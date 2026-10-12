import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '../clinical-core/database';
import { classifyDatabaseRejection } from '../clinical-core/rds-data-database';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from './program-commerce-activation';
import { createSqlProgramOfferLedger } from './program-offer-ledger-sql';
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, createSqlCheckoutLedger } from './program-checkout-ledger-sql';
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, createSqlEducationLedger } from './program-education-ledger-sql';
import { createClaimDelivery, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider, codeFromMessage } from './program-claim-delivery';
import { EducationLedgerError } from './program-education-ledger';
import { createProgramCheckout } from './program-checkout';
import { createProgramSettlement, hashClaimToken } from './program-settlement';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import type { OfferActor } from './program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';
import { educationAccessView } from '../../contracts/programEducationAccess';

/**
 * The BLOCKED education-access candidate on top of the offer and checkout candidates, against the
 * full synthetic manifest and nowhere else, driven through the SQL ledgers under the API role by the
 * same settlement boundary the fictional tests exercise. Disabled as shipped; then the SQL authority
 * the design claims: one entitlement per verified order whichever path arrives first, a single-use
 * expiring claim, the subject bound once, the transition table, policy holds, the exact-version
 * curriculum read, and no person-shaped column.
 */
const OFFER = 'infra/aws-clinical-core/source-candidates/program-offer-revisions.sql';
const CHECKOUT = 'infra/aws-clinical-core/source-candidates/program-checkout-orders.sql';
const CHECKOUT_RECOVERY = 'infra/aws-clinical-core/source-candidates/program-checkout-recovery.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-education-access.sql';
/** The BLOCKED delivery successor, applied after the unchanged candidate above. */
const DELIVERY = 'infra/aws-clinical-core/source-candidates/program-education-delivery.sql';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '62000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), staff = id(3), program = id(6), version1 = id(9);
const alice = 'sub:fictional-alice-0001', bob = 'sub:fictional-bob-00002';
let db: PGlite;
const fails = async (sql: string, args: unknown[] = []) => { try { await db.query(sql, args); } catch (error) { return (error as Error).message; } return 'none'; };
/** A session of one reduced role, the way the host would construct one per authority. */
const asRole = (role: string): ClinicalCoreDatabase => ({ transaction: work => db.transaction(async tx => {
  await tx.exec(`set local role ${role}`);
  return work({ query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
    try { return await tx.query<Row>(sql, parameters.map(p => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p)); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection('operation_refused');
    }
  } });
}) });
const database = asRole('clinical_core_api');
const evidence = () => ({ contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' });
const offers = createSqlProgramOfferLedger({ database, activation: evidence(), identity: (actor: OfferActor) => ({ identityPool: 'workforce', identitySubject: 'wf:' + actor.personId }) });
const orders = createSqlCheckoutLedger({ database, activation: evidence(), checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256 });
const education = (educationSha = PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, activation: unknown = evidence()) => createSqlEducationLedger({
  database, delivery: asRole('commercial_education_delivery'), operator: asRole('commercial_education_operator'), activation,
  checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256,
  educationCandidateSha256: educationSha, educationDeliveryCandidateSha256: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256,
});
const sealer = createFictionalClaimSealer();
const contacts = createFictionalContactAuthority();
const provider = createFictionalDeliveryProvider();
/** The purchaser's view: the processor-held contact for the order, one delivery pass, the code from the message that arrived. */
async function codeFor(orderId: string): Promise<string> {
  const address = `purchaser+${orderId.slice(0, 8)}@fictional.example`;
  contacts.contacts.set(orderId, address);
  const pass = await createClaimDelivery({ ledger: education(), sealer, contacts, provider, now }).deliverDue();
  if (!pass.ok) throw new Error('delivery pass could not read its queue');
  const message = [...provider.mailbox].reverse().find(m => m.to === address);
  if (!message) throw new Error('nothing reached the purchaser');
  return codeFromMessage(message);
}
const me: OfferActor = { personId: staff, organizationId: org };
const expected = { accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
let clock = Date.parse('2026-10-11T12:00:00Z');
const now = () => new Date(clock);
const processor = createFictionalCheckoutProcessor({ now });
const checkout = createProgramCheckout({ offers, ledger: orders, processor, publicOrigin: 'https://clinic.fictional.example', now });
const phases = [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [{ id: 'lesson-a', title: 'Fictional lesson a', kind: 'lesson', instructions: 'Read.', released: true }] }];
const settlement = (accountRef = expected.accountRef) => createProgramSettlement({ ledger: education(), curriculumContent: async () => { throw new Error('the SQL read is the authority here'); }, expectedAccountRef: accountRef, now, sealer });
const event = (eventId: string, sessionRef: string): VerifiedEvent => ({ id: eventId, type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: sessionRef } } });
async function verifiedOrder(attemptKey: string) {
  const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey });
  const order = (await orders.readOrder(started.started ? started.orderId : ''))!;
  processor.settle(order.processor!.sessionRef, 'paid');
  await checkout.admitEvent(event('evt_' + attemptKey, order.processor!.sessionRef), 'raw', expected);
  await checkout.processEvent('evt_' + attemptKey);
  return (await orders.readOrder(order.orderId))!;
}
async function refusal(work: () => Promise<unknown>): Promise<EducationLedgerError> {
  try { await work(); } catch (error) { if (error instanceof EducationLedgerError) return error; throw error; }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  expect(sha(OFFER)).toBe(PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256);
  expect(sha(CHECKOUT)).toBe(PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256);
  const candidate = readFileSync(CANDIDATE, 'utf8');
  expect(candidate).toContain('BLOCKED source candidate');
  expect(candidate).toContain(PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256);
  expect(candidate).toContain('c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445');
  expect(sha(CANDIDATE)).toBe(PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256);
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_](offer|checkout|order|education|entitlement)|commercial_education/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
  await db.exec(readFileSync(OFFER, 'utf8'));
  await db.exec(readFileSync(CHECKOUT, 'utf8'));
  expect(sha(CHECKOUT_RECOVERY)).toBe(PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256);
  await db.exec(readFileSync(CHECKOUT_RECOVERY, 'utf8'));
  await db.exec(candidate);
  const delivery = readFileSync(DELIVERY, 'utf8');
  expect(delivery).toContain('BLOCKED source candidate (successor)');
  expect(delivery).toContain(PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256);
  expect(sha(DELIVERY)).toBe(PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256);
  await db.exec(delivery);
  await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [org, 'Fictional A']);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [staff, 'syn_' + staff.replaceAll('-', '')]);
  await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`, [staff, 'wf:' + staff]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')`, [org, staff]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [program, org, staff]);
  await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,1,'published',$4::jsonb,$5,clock_timestamp())`, [version1, org, program, JSON.stringify({ consumerProgram: { title: 'Fictional guide', phases } }), staff]);
  await db.query("update clinical_core.synthetic_desktop_programs set published_version_id=$2,status='published' where id=$1", [program, version1]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('disabled as shipped', () => {
  it('the API role touches no table, the ledger refuses without the exact evidence, and no column names a person', async () => {
    for (const table of ['program_entitlements', 'program_claims', 'program_education_enrollments', 'program_entitlement_events']) {
      await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec(`select * from commercial_education.${table}`); })).rejects.toThrow(/permission denied/);
    }
    expect((await refusal(() => education(PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, undefined).access(alice))).category).toBe('store_unavailable');
    expect((await refusal(() => education('f'.repeat(64)).access(alice))).category).toBe('store_unavailable');
    expect((await refusal(() => education().access(alice))).category).toBe('store_unavailable');
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='commercial_education'");
    expect(columns.rows.map(c => c.column_name).filter(c => /patient|email|first_name|last_name|full_name|card|pan$|cvc|diagnos|symptom|encounter|connection|phone|address/.test(c))).toEqual([]);
    const bodies = await db.query<{ n: string }>("select p.proname as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname in('clinical_core','clinical_private','clinical_audit') and p.prokind='f' and pg_get_functiondef(p.oid) ilike '%commercial_education%'");
    expect(bodies.rows).toEqual([]);
  });
});

describe('enabled in this embedded database only', () => {
  let orderId = '', entitlementId = '', token = '';
  beforeAll(async () => {
    await db.query(`update commercial_education.program_commerce_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
    const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
  });
  it('settles one verified order into one entitlement and one claim, idempotently; refuses an open order, another account, and a direct second row', async () => {
    const open = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-open' });
    expect(await settlement().settleOrder({ orderId: open.started ? open.orderId : '' })).toEqual({ settled: false, reason: 'order_not_verified' });
    const order = await verifiedOrder('browser-a');
    orderId = order.orderId;
    expect(await settlement('acct_FictionalOther99').settleOrder(order)).toEqual({ settled: false, reason: 'account_mismatch' });
    const first = await settlement().settleOrder(order);
    expect(first.settled && first.receipt.created).toBe(true);
    expect(first.settled && first.delivery).toBe('queued');
    token = await codeFor(order.orderId);
    entitlementId = first.settled ? first.receipt.entitlement.entitlementId : '';
    expect(first.settled && first.receipt.entitlement).toMatchObject({ orderId, state: 'awaiting_claim', subject: { kind: 'unclaimed' }, curriculum: { versionId: version1, version: 1 }, accessDurationDays: 30, offerRevision: 3, settlement: { verificationEventId: 'evt_browser-a' } });
    // The digest is the database's private record of the code; no reply carries it.
    expect((await db.query<{ token_hash: string }>('select token_hash from commercial_education.program_claims where entitlement_id=$1', [entitlementId])).rows[0]!.token_hash).toBe(hashClaimToken(token));
    expect(JSON.stringify(first)).not.toContain(hashClaimToken(token));
    expect(JSON.stringify(first)).not.toMatch(/tokenHash/);
    const again = await settlement().settleOrder(order);
    expect(again.settled && !again.receipt.created && again.delivery === 'none').toBe(true);
    expect(await education().unsettledOrders(10)).toEqual([]);
    expect(await fails(`insert into commercial_education.program_entitlements(order_id,organization_id,program_id,offer_id,offer_revision,curriculum_version_id,curriculum_version,curriculum_source_digest,access_terms_version,access_duration_days,verification_event_id)
      select order_id,organization_id,program_id,offer_id,offer_revision,curriculum_version_id,curriculum_version,curriculum_source_digest,access_terms_version,access_duration_days,verification_event_id from commercial_education.program_entitlements where id=$1`, [entitlementId])).toMatch(/unique/);
    expect(await fails(`insert into commercial_education.program_entitlements(order_id,organization_id,program_id,offer_id,offer_revision,curriculum_version_id,curriculum_version,curriculum_source_digest,access_terms_version,access_duration_days,verification_event_id)
      select id,organization_id,program_id,offer_id,offer_revision,curriculum_version_id,curriculum_version,curriculum_source_digest,access_terms_version,access_duration_days,'evt_x' from commercial_education.program_orders where id=$1`, [open.started ? open.orderId : ''])).toContain('program_entitlement_order_not_verified');
  });
  it('the claim is single-use and binds one subject; a stranger, a replay, an order id and a forged token change nothing', async () => {
    expect(await settlement().claim(bob, orderId)).toEqual({ outcome: 'refused', reason: 'claim_invalid' });
    expect(await settlement().claim(bob, 'A'.repeat(43))).toEqual({ outcome: 'refused', reason: 'claim_invalid' });
    expect(await settlement().access(bob)).toMatchObject({ entitlements: [], enrollments: [] });
    const claimed = await settlement().claim(alice, token);
    expect(claimed).toMatchObject({ outcome: 'claimed', entitlement: { state: 'active', revision: 2, subject: { kind: 'claimed', consumerSubject: alice } } });
    // The window opens at the claim instant. The database renders timestamptz in its session zone (PGlite follows the process TZ; CI runs the unit suite in Pacific time), so the instant is compared, never the rendering.
    expect(claimed.outcome === 'claimed' && claimed.entitlement.window ? Date.parse(claimed.entitlement.window.startsAt) : NaN).toBe(Date.parse('2026-10-11T12:00:00Z'));
    // The winner retrying after a lost reply gets the same receipt (work package 2); the code still binds nobody else.
    expect((await settlement().claim(alice, token)).outcome).toBe('claimed');
    expect(await settlement().claim(bob, token)).toEqual({ outcome: 'refused', reason: 'already_claimed_by_other' });
    const access = await settlement().access(alice);
    expect(access?.entitlements).toHaveLength(1);
    expect(access?.enrollments).toHaveLength(1);
    expect(access?.enrollments[0]).toMatchObject({ consumerSubject: alice, state: 'active', curriculum: { versionId: version1 } });
    expect(await settlement().access(bob)).toMatchObject({ entitlements: [], enrollments: [] });
    expect(await fails(`update commercial_education.program_entitlements set consumer_subject=$2,revision=revision+1 where id=$1`, [entitlementId, bob])).toContain('program_entitlement_subject_immutable');
    expect(await fails(`update commercial_education.program_claims set state='issued',used_at=null,used_by=null where entitlement_id=$1`, [entitlementId])).toContain('program_claim_settled');
    expect(await fails(`insert into commercial_education.program_education_enrollments(entitlement_id,consumer_subject,curriculum_version_id,curriculum_version,curriculum_source_digest) select entitlement_id,$2,curriculum_version_id,curriculum_version,curriculum_source_digest from commercial_education.program_education_enrollments where entitlement_id=$1`, [entitlementId, bob])).toMatch(/unique/);
  });
  it('the claim window is one instant under a UTC and a non-UTC database session zone, and both renderings are the contract\'s timestamp', async () => {
    // The declared contract is `z.string().datetime({ offset: true })`: an offset rendering is admitted, so the instant is the fact and the zone is presentation.
    const instant = Date.parse('2026-10-11T12:00:00Z');
    const renderings: string[] = [];
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
      await db.exec(`set time zone '${zone}'`);
      const access = await settlement().access(alice);
      const entitlement = access?.entitlements[0];
      expect(entitlement).toMatchObject({ state: 'active', revision: 2, subject: { kind: 'claimed', consumerSubject: alice } });
      expect(entitlement?.window ? Date.parse(entitlement.window.startsAt) : NaN).toBe(instant);
      expect(educationAccessView.safeParse(access).success).toBe(true);
      renderings.push(entitlement!.window!.startsAt);
      // The winner's retry is the same receipt under every zone; a stranger still holds nothing.
      expect((await settlement().claim(alice, token)).outcome).toBe('claimed');
      expect(await settlement().access(bob)).toMatchObject({ entitlements: [], enrollments: [] });
    }
    await db.exec(`set time zone 'UTC'`);
    // Three zones, three renderings of the same instant: the proof is not a rendering happening to match.
    expect(new Set(renderings).size).toBe(3);
  });
  it('serves the exact purchased version to the owner only, and withholds when the stored content no longer matches the digest', async () => {
    const served = await education().access(alice);
    expect(served.entitlements[0]!.entitlementId).toBe(entitlementId);
    const read = await db.query<{ data: { outcome: string; title?: string; reason?: string } }>('select commercial_education.education_curriculum($1,$2,$3::timestamptz) as data', [alice, entitlementId, now().toISOString()]);
    expect(read.rows[0]!.data).toMatchObject({ outcome: 'served', title: 'Fictional guide' });
    const stranger = await db.query<{ data: { outcome: string; reason?: string } }>('select commercial_education.education_curriculum($1,$2,$3::timestamptz) as data', [bob, entitlementId, now().toISOString()]);
    expect(stranger.rows[0]!.data).toMatchObject({ outcome: 'withheld', reason: 'not_owner' });
    await db.query(`update clinical_core.synthetic_desktop_program_versions set content=$2::jsonb where id=$1`, [version1, JSON.stringify({ consumerProgram: { title: 'Fictional guide', phases: [{ ...phases[0], title: 'Changed' }] } })]);
    const changed = await db.query<{ data: { outcome: string; reason?: string } }>('select commercial_education.education_curriculum($1,$2,$3::timestamptz) as data', [alice, entitlementId, now().toISOString()]);
    expect(changed.rows[0]!.data).toMatchObject({ outcome: 'withheld', reason: 'digest_mismatch' });
    const late = await db.query<{ data: { outcome: string; reason?: string } }>('select commercial_education.education_curriculum($1,$2,$3::timestamptz) as data', [alice, entitlementId, new Date(clock + 31 * 86_400_000).toISOString()]);
    expect(late.rows[0]!.data).toMatchObject({ outcome: 'withheld', reason: 'not_active' });
    // The content is put back so later purchases bind to the same digest; the withheld read above was the point.
    await db.query(`update clinical_core.synthetic_desktop_program_versions set content=$2::jsonb where id=$1`, [version1, JSON.stringify({ consumerProgram: { title: 'Fictional guide', phases } })]);
    expect((await db.query<{ data: { outcome: string } }>('select commercial_education.education_curriculum($1,$2,$3::timestamptz) as data', [alice, entitlementId, now().toISOString()])).rows[0]!.data.outcome).toBe('served');
  });
  it('policy events hold and release visibly, revocation is final, expiry follows the window, and the status view lists every state', async () => {
    const held = await settlement().recordPolicy(orderId, 'refund', 're_fictional_1');
    expect(held).toMatchObject({ state: 'held_refund', revision: 3, policy: { kind: 'refund', reference: 're_fictional_1' } });
    expect((await settlement().access(alice))?.entitlements[0]).toMatchObject({ state: 'held_refund' });
    expect(await settlement().recordPolicy(orderId, 'operator_release', 'review-1')).toMatchObject({ state: 'active', revision: 4 });
    expect(await fails(`update commercial_education.program_entitlements set state='awaiting_claim',revision=revision+1 where id=$1`, [entitlementId])).toContain('program_entitlement_transition_refused');
    expect(await settlement().recordPolicy(orderId, 'operator_revoke', 'review-2')).toMatchObject({ state: 'revoked' });
    expect(await settlement().recordPolicy(orderId, 'operator_release', 'review-3')).toBeNull();
    expect(await fails(`delete from commercial_education.program_entitlement_events where entitlement_id=$1`, [entitlementId])).toContain('append_only_record');
    const events = await db.query<{ kind: string }>('select kind from commercial_education.program_entitlement_events where entitlement_id=$1 order by id', [entitlementId]);
    expect(events.rows.map(e => e.kind)).toEqual(['settled', 'claimed', 'refund', 'operator_release', 'operator_revoke']);
    // A second purchase expires on its window.
    const second = await verifiedOrder('browser-b');
    await settlement().settleOrder(second);
    await settlement().claim(bob, await codeFor(second.orderId));
    clock += 31 * 86_400_000;
    const expired = await settlement().expireDue();
    expect(expired.map(e => e.state)).toEqual(['expired']);
    expect((await settlement().access(bob))?.entitlements[0]).toMatchObject({ state: 'expired' });
    const status = await education().listForProgram(org, program);
    expect(status.orders.map(o => o.state).sort()).toEqual(['checkout_open', 'payment_verified', 'payment_verified']);
    expect(status.entitlements.map(e => e.state).sort()).toEqual(['expired', 'revoked']);
    // The clinic's own read of the exact purchased version needs a workforce context with a clinical role; a stranger clinic gets nothing.
    expect(await education().staffCurriculum({ personId: staff, organizationId: org, identitySubject: 'wf:' + staff }, entitlementId)).toMatchObject({ outcome: 'served', title: 'Fictional guide', curriculum: { versionId: version1 } });
    expect((await refusal(() => education().staffCurriculum({ personId: staff, organizationId: id(2), identitySubject: 'wf:' + staff }, entitlementId))).category).toBe('store_unavailable');
    expect(status.claims.map(c => c.state).sort()).toEqual(['used', 'used']);
    expect(status.enrollments).toHaveLength(2);
    // An unclaimed entitlement whose claim expired is still awaiting claim and visible, never deleted.
    const third = await verifiedOrder('browser-c');
    await settlement().settleOrder(third);
    const thirdCode = await codeFor(third.orderId);
    clock += 8 * 86_400_000;
    expect(await settlement().claim(alice, thirdCode)).toEqual({ outcome: 'refused', reason: 'claim_expired' });
    expect((await education().entitlementForOrder(third.orderId))!.state).toBe('awaiting_claim');
  });
  it('the delivery successor under its own reduced roles: the API role cannot read a sealed code, record a delivery, replace a code or assume either role', async () => {
    const asApi = async (sql: string) => { try { await db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec(sql); }); return 'none'; } catch (error) { return (error as Error).message; } };
    for (const sql of [
      "select commercial_education.due_program_claim_deliveries(now(),10)",
      "select commercial_education.record_program_claim_delivery(gen_random_uuid(),0,'{}'::jsonb)",
      "select commercial_education.reissue_program_claim(gen_random_uuid(),gen_random_uuid(),repeat('a',64),now(),'{}'::jsonb,'op:x')",
      "select commercial_education.settle_program_order(gen_random_uuid(),repeat('a',64),now(),'acct_FictionalAccount1')",
      'select * from commercial_education.program_claim_deliveries',
      'select * from commercial_education.program_claims',
    ]) expect(await asApi(sql), sql).toMatch(/permission denied/);
    // Role assumption is checked against the SESSION user. A superuser session that merely runs SET ROLE proves nothing,
    // so the session itself becomes the API role first, as a real API connection would be, and then tries to assume each role.
    // (The embedded runner ignores RESET SESSION AUTHORIZATION; the original user is restored by name.)
    const original = (await db.query<{ s: string }>('select session_user::text as s')).rows[0]!.s;
    const asApiSession = async (sql: string) => {
      try { await db.exec('set session authorization clinical_core_api'); await db.exec(sql); return 'none'; }
      catch (error) { return (error as Error).message; }
      finally { await db.exec(`set session authorization ${original}`); }
    };
    expect(await asApiSession("do $$ begin if session_user::text<>'clinical_core_api' or current_user::text<>'clinical_core_api' then raise exception 'not an api session'; end if; end $$")).toBe('none');
    for (const role of ['commercial_education_delivery', 'commercial_education_operator']) expect(await asApiSession(`set role ${role}`), role).toMatch(/permission denied/);
    expect((await db.query<{ s: string }>('select session_user::text as s')).rows[0]!.s).not.toBe('clinical_core_api');
    // The delivery role sends; it cannot settle, claim, replace or read the tables.
    const asDelivery = async (sql: string) => { try { await db.transaction(async tx => { await tx.exec('set local role commercial_education_delivery'); await tx.exec(sql); }); return 'none'; } catch (error) { return (error as Error).message; } };
    for (const sql of [
      "select commercial_education.reissue_program_claim(gen_random_uuid(),gen_random_uuid(),repeat('a',64),now(),'{}'::jsonb,'op:x')",
      "select commercial_education.claim_program_entitlement(repeat('a',64),'sub:fictional-alice-0001',now())",
      'select * from commercial_education.program_claim_deliveries',
    ]) expect(await asDelivery(sql), sql).toMatch(/permission denied/);
    // A fresh purchase: queued sealed, delivered once, erased on acceptance; the staff status shows state only.
    const order = await verifiedOrder('browser-d');
    const settled = await settlement().settleOrder(order);
    const entitlement = settled.settled ? settled.receipt.entitlement.entitlementId : '';
    const pending = await db.query<{ state: string; sealed: unknown }>('select d.state,d.sealed from commercial_education.program_claim_deliveries d join commercial_education.program_claims c on c.id=d.claim_id where c.entitlement_id=$1', [entitlement]);
    expect(pending.rows[0]).toMatchObject({ state: 'pending' });
    expect(pending.rows[0]!.sealed).not.toBeNull();
    const code = await codeFor(order.orderId);
    const accepted = await db.query<{ state: string; sealed: unknown; attempts: number }>('select d.state,d.sealed,d.attempts from commercial_education.program_claim_deliveries d join commercial_education.program_claims c on c.id=d.claim_id where c.entitlement_id=$1', [entitlement]);
    expect(accepted.rows[0]).toEqual({ state: 'accepted', sealed: null, attempts: 1 });
    expect(await fails(`update commercial_education.program_claim_deliveries set state='pending',attempts=attempts+1,sealed='{"keyRef":"a","iv":"b","ciphertext":"c","tag":"d"}',next_attempt_at=now() where claim_id=(select id from commercial_education.program_claims where entitlement_id=$1)`, [entitlement])).toContain('program_delivery_settled');
    const hashes = (await db.query<{ token_hash: string }>('select token_hash from commercial_education.program_claims')).rows.map(r => r.token_hash);
    const status = JSON.stringify(await education().listForProgram(org, program));
    for (const hash of hashes) expect(status).not.toContain(hash);
    expect(status).not.toContain(code);
    expect(status).not.toMatch(/tokenHash|sealed|ciphertext/);
    // An operator's replacement supersedes the old code and withdraws its delivery in one transaction.
    const replaced = await settlement().reissue({ kind: 'operator', operatorId: 'op:fictional-operator-1' }, entitlement);
    expect(replaced).toMatchObject({ reissued: true, superseded: 1 });
    expect(await settlement().claim(alice, code)).toEqual({ outcome: 'refused', reason: 'claim_superseded' });
    const newCode = await codeFor(order.orderId);
    const claimed = await settlement().claim(alice, newCode);
    expect(claimed.outcome).toBe('claimed');
    // The winner retrying gets the same receipt from the database too; the enrollment count stays one.
    expect(await settlement().claim(alice, newCode)).toEqual(claimed);
    expect(await settlement().claim(bob, newCode)).toEqual({ outcome: 'refused', reason: 'already_claimed_by_other' });
    expect((await db.query<{ n: number }>('select count(*)::int as n from commercial_education.program_education_enrollments where entitlement_id=$1', [entitlement])).rows[0]!.n).toBe(1);
    expect(await settlement().reissue({ kind: 'operator', operatorId: 'op:fictional-operator-1' }, entitlement)).toEqual({ reissued: false, reason: 'not_claimable' });
    const sealedLeft = await db.query<{ n: number }>('select count(*)::int as n from commercial_education.program_claim_deliveries where sealed is not null');
    expect(sealedLeft.rows[0]!.n).toBe(0);
  });
  it('a card being charged created nothing clinical: no patient record, membership, consent, assignment or consult request', async () => {
    for (const table of ['patient_records', 'organization_memberships', 'consent_grants', 'program_assignments', 'public_consult_requests']) {
      const exists = await db.query<{ n: string }>("select count(*)::text as n from information_schema.tables where table_schema='clinical_core' and table_name=$1", [table]);
      if (exists.rows[0]!.n === '0') continue;
      const count = await db.query<{ n: string }>(`select count(*)::text as n from clinical_core.${table}`);
      expect(count.rows[0]!.n, table).toBe(table === 'organization_memberships' ? '1' : '0');
    }
  });
});
