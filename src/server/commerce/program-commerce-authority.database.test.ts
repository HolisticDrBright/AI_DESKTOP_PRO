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
import { createProgramCheckout } from './program-checkout';
import { createProgramSettlement } from './program-settlement';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import type { OfferActor } from './program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from './program-commerce-authority';

/**
 * Work package 3: who may call what. The whole BLOCKED chain (offer, checkout, recovery, education,
 * delivery, and the authority successor program-commerce-authority.sql) on the full synthetic
 * manifest, then DIRECT calls from a real API-role session (its session user is the API role, not a
 * superuser that ran SET ROLE) with no request context, another subject's context, or another
 * clinic's context. Each refused call below SUCCEEDED against the chain without the successor (the
 * reproduction is recorded in the return document); the last cases show the legitimate paths still
 * work through the role that owns them.
 */
const OFFER = 'infra/aws-clinical-core/source-candidates/program-offer-revisions.sql';
const CHECKOUT = 'infra/aws-clinical-core/source-candidates/program-checkout-orders.sql';
const CHECKOUT_RECOVERY = 'infra/aws-clinical-core/source-candidates/program-checkout-recovery.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-education-access.sql';
/** The BLOCKED delivery successor, applied after the unchanged candidate above. */
const DELIVERY = 'infra/aws-clinical-core/source-candidates/program-education-delivery.sql';
const AUTHORITY = 'infra/aws-clinical-core/source-candidates/program-commerce-authority.sql';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '63000000-0000-4000-8000-' + String(n).padStart(12, '0');
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
const chain = { activation: evidence(), checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, commerceAuthorityCandidateSha256: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 };
const orders = createSqlCheckoutLedger({ database, ...chain });
const workerOrders = createSqlCheckoutLedger({ database: asRole('commercial_education_worker'), authority: 'worker', ...chain });
const education = (educationSha = PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, activation: unknown = evidence()) => createSqlEducationLedger({
  database, worker: asRole('commercial_education_worker'), delivery: asRole('commercial_education_delivery'), operator: asRole('commercial_education_operator'), activation,
  checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256,
  educationCandidateSha256: educationSha, educationDeliveryCandidateSha256: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, commerceAuthorityCandidateSha256: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256,
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
const clock = Date.parse('2026-10-11T12:00:00Z');
const now = () => new Date(clock);
const processor = createFictionalCheckoutProcessor({ now });
const checkout = createProgramCheckout({ offers, ledger: orders, processor, publicOrigin: 'https://clinic.fictional.example', now });
const workerCheckout = createProgramCheckout({ offers, ledger: workerOrders, processor, publicOrigin: 'https://clinic.fictional.example', now });
const phases = [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [{ id: 'lesson-a', title: 'Fictional lesson a', kind: 'lesson', instructions: 'Read.', released: true }] }];
const settlement = (accountRef = expected.accountRef) => createProgramSettlement({ ledger: education(), curriculumContent: async () => { throw new Error('the SQL read is the authority here'); }, expectedAccountRef: accountRef, now, sealer });
const event = (eventId: string, sessionRef: string): VerifiedEvent => ({ id: eventId, type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: sessionRef } } });
async function verifiedOrder(attemptKey: string) {
  const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey });
  const order = (await orders.readOrder(started.started ? started.orderId : ''))!;
  processor.settle(order.processor!.sessionRef, 'paid');
  await checkout.admitEvent(event('evt_' + attemptKey, order.processor!.sessionRef), 'raw', expected);
  await workerCheckout.processEvent('evt_' + attemptKey);
  return (await orders.readOrder(order.orderId))!;
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
  const authority = readFileSync(AUTHORITY, 'utf8');
  expect(authority).toContain('BLOCKED source candidate (successor)');
  expect(authority).toContain(PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256);
  expect(sha(AUTHORITY)).toBe(PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256);
  await db.exec(authority);
  await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [org, 'Fictional A']);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [staff, 'syn_' + staff.replaceAll('-', '')]);
  await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`, [staff, 'wf:' + staff]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')`, [org, staff]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [program, org, staff]);
  await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,1,'published',$4::jsonb,$5,clock_timestamp())`, [version1, org, program, JSON.stringify({ consumerProgram: { title: 'Fictional guide', phases } }), staff]);
  await db.query("update clinical_core.synthetic_desktop_programs set published_version_id=$2,status='published' where id=$1", [program, version1]);
}, 120_000);
afterAll(async () => { await db?.close(); });

/** Claim as a verified consumer: the caller is the verified request context. */
async function claimAs(person: string, subject: string, code: string) {
  return settlement().claim({ kind: 'consumer', personId: person, identitySubject: subject }, code);
}

const orgB = id(2), staffB = id(4), alicePerson = id(20), bobPerson = id(21);
let orderId = '', entitlementId = '', openOrderId = '';
const original = () => db.query<{ s: string }>('select session_user::text as s').then(r => r.rows[0]!.s);
/** One statement from a session whose SESSION user is the API role; optionally after a request context the server would set. */
async function asApi(sql: string, args: unknown[] = [], context?: { person: string; org: string | null; pool: 'workforce' | 'consumer'; subject: string }) {
  const back = await original();
  try {
    await db.exec('set session authorization clinical_core_api');
    return await db.transaction(async tx => {
      if (context) await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [context.person, context.org, context.pool, context.subject, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
      const result = await tx.query<Record<string, unknown>>(sql, args);
      return { ok: true as const, rows: result.rows };
    });
  } catch (error) { return { ok: false as const, error: (error as Error).message }; }
  finally { await db.exec(`set session authorization ${back}`); }
}
const refusedOrEmpty = (r: Awaited<ReturnType<typeof asApi>>) => !r.ok || JSON.stringify(r.rows).match(/"(refused|withheld)"|null/) !== null;

describe('who may call what (failing before the authority successor; held after it)', () => {
  beforeAll(async () => {
    await db.query(`update commercial_education.program_commerce_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
    await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [orgB, 'Fictional B']);
    for (const [person, pool, subject] of [[staffB, 'workforce', 'wf:' + staffB], [alicePerson, 'consumer', alice], [bobPerson, 'consumer', bob]] as const) {
      await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)', [person, pool, subject]);
    }
    await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')`, [orgB, staffB]);
    await db.query(`select commercial_education.record_reviewed_access_terms('education-access-terms/1','fixed_days','not_required','fictional-refund-policy/1','FICTIONAL REVIEW FIXTURE',repeat('f',64))`);
    const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
    const order = await verifiedOrder('browser-a');
    orderId = order.orderId;
    const settled = await settlement().settleOrder(order);
    entitlementId = settled.settled ? settled.receipt.entitlement.entitlementId : '';
    const code = await codeFor(orderId);
    expect(await claimAs(alicePerson, alice, code)).toMatchObject({ outcome: 'claimed' });
    const open = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId: program }, attemptKey: 'browser-open' });
    openOrderId = open.started ? open.orderId : '';
  });
  it('the API role cannot manufacture a verified payment', async () => {
    const order = (await db.query<{ revision: number; session_ref: string }>('select revision,session_ref from commercial_education.program_orders where id=$1', [openOrderId])).rows[0]!;
    const verification = JSON.stringify({ verification: { eventId: 'evt_forged', sessionRef: order.session_ref, amountMinor: 1999, currency: 'USD', paymentStatus: 'paid', accountRef: 'acct_FictionalAccount1', verifiedAt: '2026-10-11T12:00:00Z' } });
    const forged = await asApi('select commercial_education.transition_program_order($1,$2,$3,$4::jsonb) as data', [openOrderId, order.revision, 'payment_verified', verification]);
    expect(forged.ok).toBe(false);
    expect((await db.query<{ state: string }>('select state from commercial_education.program_orders where id=$1', [openOrderId])).rows[0]!.state).toBe('checkout_open');
  });
  it('the API role cannot claim for a subject it names, nor read another owner\'s purchases', async () => {
    const hash = (await db.query<{ token_hash: string }>('select token_hash from commercial_education.program_claims where entitlement_id=$1', [entitlementId])).rows[0]!.token_hash;
    expect(refusedOrEmpty(await asApi("select commercial_education.claim_program_entitlement($1,'sub:fictional-mallory-01',now()) as data", [hash]))).toBe(true);
    const named = await asApi('select commercial_education.education_access($1) as data', [alice]);
    expect(named.ok && JSON.stringify(named.rows).includes(entitlementId)).toBe(false);
    // Bob's verified context reads Bob's purchases, never Alice's.
    for (const fn of ['education_access_for_caller()']) {
      const bobs = await asApi(`select commercial_education.${fn} as data`, [], { person: bobPerson, org: null, pool: 'consumer', subject: bob });
      expect(bobs.ok ? JSON.stringify(bobs.rows).includes(entitlementId) : false).toBe(false);
    }
  });
  it('the API role cannot read any entitlement by id, nor another clinic\'s status', async () => {
    const byId = await asApi('select commercial_education.read_program_entitlement($1) as data', [entitlementId]);
    expect(byId.ok && JSON.stringify(byId.rows).includes(entitlementId)).toBe(false);
    const forOrder = await asApi('select commercial_education.entitlement_for_order($1) as data', [orderId]);
    expect(forOrder.ok && JSON.stringify(forOrder.rows).includes(entitlementId)).toBe(false);
    const status = await asApi('select commercial_education.program_education_status($1,$2) as data', [org, program], { person: staffB, org: orgB, pool: 'workforce', subject: 'wf:' + staffB });
    expect(status.ok && JSON.stringify(status.rows).includes(entitlementId)).toBe(false);
  });
  it('the API role cannot hold, release or revoke an entitlement, nor run a global expiry sweep', async () => {
    expect((await asApi("select commercial_education.record_entitlement_policy($1,'operator_revoke','forged',now()) as data", [orderId])).ok).toBe(false);
    const entitlement = (await db.query<{ revision: number }>('select revision from commercial_education.program_entitlements where id=$1', [entitlementId])).rows[0]!;
    expect((await asApi("select commercial_education.transition_program_entitlement($1,$2,'revoked') as data", [entitlementId, entitlement.revision])).ok).toBe(false);
    expect((await asApi("select commercial_education.expire_program_entitlements(now()+interval '4000 days') as data")).ok).toBe(false);
    expect((await db.query<{ state: string }>('select state from commercial_education.program_entitlements where id=$1', [entitlementId])).rows[0]!.state).toBe('active');
  });
  it('the API role cannot settle, read the settlement backlog, or process intake', async () => {
    for (const sql of [
      "select commercial_education.settle_program_order_sealed(gen_random_uuid(),gen_random_uuid(),repeat('b',64),now(),'{\"keyRef\":\"a\",\"iv\":\"b\",\"ciphertext\":\"c\",\"tag\":\"d\"}'::jsonb,'acct_FictionalAccount1')",
      'select commercial_education.unsettled_program_orders(10)',
      "select commercial_education.due_checkout_intake(now(),10)",
      "select commercial_education.find_program_order_by_session('cs_test_anything12345')",
    ]) expect((await asApi(sql)).ok, sql).toBe(false);
  });
  it('the API role cannot assume the worker, delivery or operator role', async () => {
    for (const role of ['commercial_education_worker', 'commercial_education_delivery', 'commercial_education_operator']) {
      expect((await asApi(`set local role ${role}`)).ok, role).toBe(false);
    }
  });
  it('the legitimate paths still work, each through the role that owns it', async () => {
    // The consumer reads their own purchase under their verified context.
    const own = await asApi('select commercial_education.education_access_for_caller() as data', [], { person: alicePerson, org: null, pool: 'consumer', subject: alice });
    expect(own.ok && JSON.stringify(own.rows).includes(entitlementId)).toBe(true);
    // A clinician of the clinic reads its status; the API role with that clinic's workforce context.
    const status = await asApi('select commercial_education.program_education_status($1,$2) as data', [org, program], { person: staff, org, pool: 'workforce', subject: 'wf:' + staff });
    expect(status.ok && JSON.stringify(status.rows).includes(entitlementId)).toBe(true);
    // The request path cannot record a payment outcome even through its own transition function.
    const order = (await db.query<{ revision: number }>('select revision from commercial_education.program_orders where id=$1', [openOrderId])).rows[0]!;
    expect((await asApi("select commercial_education.advance_program_checkout($1,$2,'payment_verified','{}'::jsonb) as data", [openOrderId, order.revision])).ok).toBe(false);
    // The operator holds and releases; the worker sweeps a bounded count by the database clock.
    const operator = { kind: 'operator' as const, operatorId: 'op:fictional-operator-1' };
    expect(await settlement().recordPolicy(operator, orderId, 'refund', 're_fictional_1')).toMatchObject({ state: 'held_refund' });
    expect(await settlement().recordPolicy(operator, orderId, 'operator_release', 'review-fictional-1')).toMatchObject({ state: 'active' });
    expect(await settlement().expireDue(5)).toEqual({ ok: true, expired: [] });
  });
  it('an unreviewed access-terms version holds publication in the database too, and the reviewed registry is append-only', async () => {
    const draft = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program, other terms', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/42', accessDurationDays: 30 } });
    const draftId = draft.action === 'create' ? draft.offer.offerId : '';
    await offers.execute(me, { action: 'approve_provider_mapping', offerId: draftId, expectedRevision: 1 });
    const refused = await offers.execute(me, { action: 'publish', offerId: draftId, expectedRevision: 2 }).catch(error => error);
    expect(refused).toMatchObject({ category: 'publish_refused', holds: expect.arrayContaining(['access_terms_unreviewed']) });
    expect((await db.query<{ h: string[] }>(`select commercial_education.access_terms_holds('education-access-terms/42',30,'one_time') as h`)).rows[0]!.h).toEqual(['access_terms_unreviewed']);
    expect((await db.query<{ h: string[] }>(`select commercial_education.access_terms_holds('education-access-terms/1',null,'one_time') as h`)).rows[0]!.h).toEqual(['access_duration_undecided']);
    expect((await db.query<{ h: string[] }>(`select commercial_education.access_terms_holds('education-access-terms/1',30,'recurring') as h`)).rows[0]!.h).toEqual(['renewal_terms_undecided']);
    expect(await fails(`update commercial_education.reviewed_access_terms set duration_policy='indefinite' where version='education-access-terms/1'`)).toContain('append_only_record');
    expect((await asApi(`select commercial_education.record_reviewed_access_terms('education-access-terms/9','indefinite','not_required','x','FICTIONAL REVIEW FIXTURE',repeat('f',64))`)).ok).toBe(false);
    expect((await asApi('select * from commercial_education.reviewed_access_terms')).ok).toBe(false);
  });
});
