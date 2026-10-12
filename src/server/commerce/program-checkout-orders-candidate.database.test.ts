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
import { CheckoutLedgerError } from './program-checkout-ledger';
import { createProgramCheckout, hashAttemptKey } from './program-checkout';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import type { OfferActor } from './program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';

/**
 * The BLOCKED program-checkout candidate on top of the offer candidate, against the full synthetic
 * manifest and nowhere else, driven through the SQL ledger under the API role by the SAME boundary
 * the fictional tests exercise, with the fictional processor. The first block proves it is disabled
 * as shipped; the rest proves the SQL authority the design claims: admission with an immutable
 * snapshot before anything outbound, one open order per attempt and offer revision, the transition
 * table, verification bound to the snapshot, append-only intake with bounded attempts, and no
 * person-shaped column anywhere in the commercial schema.
 */
const OFFER_CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-offer-revisions.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-checkout-orders.sql';
/** The BLOCKED successor (program-checkout/2), applied after the unchanged parent above. */
const RECOVERY = 'infra/aws-clinical-core/source-candidates/program-checkout-recovery.sql';
const IDENTITY = 'infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '61000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), staff = id(3), program = id(6), version1 = id(9), version2 = id(10);
let db: PGlite;
const fails = async (sql: string, args: unknown[] = []) => { try { await db.query(sql, args); } catch (error) { return (error as Error).message; } return 'none'; };
const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
    try { return await tx.query<Row>(sql, parameters.map(p => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p)); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection('operation_refused');
    }
  } });
}) };
const evidence = () => ({ contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' });
const offers = createSqlProgramOfferLedger({ database, activation: evidence(), identity: (actor: OfferActor) => ({ identityPool: 'workforce', identitySubject: 'wf:' + actor.personId }) });
const ledger = (checkoutSha = PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, activation: unknown = evidence()) => createSqlCheckoutLedger({ database, activation, checkoutCandidateSha256: checkoutSha, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256 });
const me: OfferActor = { personId: staff, organizationId: org };
const binding = { organizationId: org, programId: program };
const origin = 'https://clinic.fictional.example';
const expected = { accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
const event = (over: Partial<VerifiedEvent & { account?: string }> = {}, object: Record<string, unknown> = {}): VerifiedEvent => ({ id: 'evt_sql_1', type: 'checkout.session.completed', livemode: false, created: 1, data: { object }, ...over });
const phases = (suffix: string) => [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items: [{ id: 'lesson-' + suffix, title: 'Fictional lesson ' + suffix, kind: 'lesson', instructions: 'Read.', released: true }] }];
let clock = Date.parse('2026-10-11T12:00:00Z');
const now = () => new Date(clock);
async function publishVersion(versionId: string, version: number, suffix: string) {
  await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,$4,'published',$5::jsonb,$6,clock_timestamp())`, [versionId, org, program, version, JSON.stringify({ consumerProgram: { title: 'Fictional guide', phases: phases(suffix) } }), staff]);
  await db.query("update clinical_core.synthetic_desktop_programs set published_version_id=$2,status='published' where id=$1", [program, versionId]);
}
async function refusal(work: () => Promise<unknown>): Promise<CheckoutLedgerError> {
  try { await work(); } catch (error) { if (error instanceof CheckoutLedgerError) return error; throw error; }
  throw new Error('expected a refusal');
}
function boundary(processor = createFictionalCheckoutProcessor({ now })) {
  return { processor, checkout: createProgramCheckout({ offers, ledger: ledger(), processor, publicOrigin: origin, now }) };
}

beforeAll(async () => {
  expect(sha(IDENTITY)).toBe('c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445');
  expect(sha(OFFER_CANDIDATE)).toBe(PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256);
  const candidate = readFileSync(CANDIDATE, 'utf8');
  expect(candidate).toContain('BLOCKED source candidate');
  expect(candidate).toContain(PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256);
  expect(candidate).toContain('c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445');
  expect(sha(CANDIDATE)).toBe(PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256);
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_](offer|checkout|order)|commercial_education/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
  await db.exec(readFileSync(OFFER_CANDIDATE, 'utf8'));
  await db.exec(candidate);
  const recovery = readFileSync(RECOVERY, 'utf8');
  expect(recovery).toContain('BLOCKED source candidate (successor)');
  expect(recovery).toContain(PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256);
  expect(sha(RECOVERY)).toBe(PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256);
  await db.exec(recovery);
  await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [org, 'Fictional A']);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [staff, 'syn_' + staff.replaceAll('-', '')]);
  await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`, [staff, 'wf:' + staff]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')`, [org, staff]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [program, org, staff]);
  await publishVersion(version1, 1, 'a');
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('disabled as shipped', () => {
  it('the API role touches no table, and the ledger refuses without evidence, with another candidate digest, and while the row is off', async () => {
    for (const table of ['program_orders', 'program_checkout_intake']) {
      await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec(`select * from commercial_education.${table}`); })).rejects.toThrow(/permission denied/);
    }
    expect((await refusal(() => ledger(PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, undefined).readOrder(id(50)))).category).toBe('store_unavailable');
    expect((await refusal(() => ledger('f'.repeat(64)).readOrder(id(50)))).category).toBe('store_unavailable');
    expect((await refusal(() => ledger().readOrder(id(50)))).category).toBe('store_unavailable');
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='commercial_education'");
    expect(columns.rows.map(c => c.column_name).filter(c => /patient|consumer|email|first_name|last_name|full_name|card|pan$|cvc|diagnos|symptom|encounter|connection|phone|address/.test(c))).toEqual([]);
    const bodies = await db.query<{ n: string }>("select p.proname as n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname in('clinical_core','clinical_private','clinical_audit') and p.prokind='f' and pg_get_functiondef(p.oid) ilike '%commercial_education%'");
    expect(bodies.rows).toEqual([]);
  });
});

describe('enabled in this embedded database only', () => {
  let offerId = '';
  beforeAll(async () => {
    await db.query(`update commercial_education.program_commerce_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
    const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90 } });
    offerId = created.action === 'create' ? created.offer.offerId : '';
  });
  it('refuses admission while the offer is a draft, and admits with the snapshot copied from the published offer once it is', async () => {
    const { checkout } = boundary();
    expect(await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' })).toMatchObject({ started: false, reason: 'offer_draft' });
    await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' });
    expect(started).toMatchObject({ started: true, reused: false });
    const order = await ledger().readOrder(started.started ? started.orderId : '');
    expect(order).toMatchObject({ contract: 'program-checkout/2', state: 'checkout_open', revision: 3, offerId, offerRevision: 3, funnelSlug: 'longevity-program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90, curriculum: { versionId: version1, version: 1 }, subject: { kind: 'unclaimed' }, attemptKeyHash: hashAttemptKey('browser-a') });
    expect(order!.processor).toMatchObject({ provider: 'stripe', mode: 'test', returnSuccess: `${origin}/buy/return?order=${order!.orderId}&returned=success` });
    // The same browser again reuses it; the table refuses a second open admission for the attempt and revision directly too.
    expect(await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-a' })).toMatchObject({ started: true, reused: true, orderId: order!.orderId });
    expect(await fails(`insert into commercial_education.program_orders(organization_id,program_id,offer_id,offer_revision,funnel_slug,curriculum_version_id,curriculum_version,curriculum_source_digest,currency,amount_minor,billing_kind,provider_price_ref,access_terms_version,access_duration_days,attempt_key_hash)
      select organization_id,program_id,offer_id,offer_revision,funnel_slug,curriculum_version_id,curriculum_version,curriculum_source_digest,currency,amount_minor,billing_kind,provider_price_ref,access_terms_version,access_duration_days,attempt_key_hash from commercial_education.program_orders where id=$1`, [order!.orderId])).toMatch(/program_orders_one_open_per_attempt|unique/);
  });
  it('the snapshot must equal the published offer, and the identity, session and verification columns are immutable', async () => {
    const order = (await ledger().findOrderBySession([...boundary().processor.sessions.keys()][0] ?? ''))
      ?? (await db.query<{ id: string }>("select id from commercial_education.program_orders limit 1")).rows[0]!;
    const orderId = 'orderId' in order ? order.orderId : order.id;
    expect(await fails(`insert into commercial_education.program_orders(organization_id,program_id,offer_id,offer_revision,funnel_slug,curriculum_version_id,curriculum_version,curriculum_source_digest,currency,amount_minor,billing_kind,provider_price_ref,access_terms_version,access_duration_days,attempt_key_hash)
      select organization_id,program_id,offer_id,offer_revision,funnel_slug,curriculum_version_id,curriculum_version,curriculum_source_digest,currency,1,billing_kind,provider_price_ref,access_terms_version,access_duration_days,repeat('c',64) from commercial_education.program_orders where id=$1`, [orderId])).toContain('program_order_snapshot_mismatch');
    expect(await fails(`update commercial_education.program_orders set amount_minor=1,revision=revision+1 where id=$1`, [orderId])).toContain('program_order_identity_immutable');
    expect(await fails(`update commercial_education.program_orders set offer_revision=99,revision=revision+1 where id=$1`, [orderId])).toContain('program_order_identity_immutable');
    expect(await fails(`update commercial_education.program_orders set session_ref='cs_test_otherSession999',revision=revision+1 where id=$1`, [orderId])).toMatch(/program_order_(session_immutable|transition_refused)/);
    expect(await fails(`update commercial_education.program_orders set session_ref='cs_test_otherSession999',state='checkout_cancelled',revision=revision+1 where id=$1`, [orderId])).toContain('program_order_session_immutable');
    expect(await fails(`update commercial_education.program_orders set state='payment_verified',revision=revision+1 where id=$1`, [orderId])).toMatch(/program_orders_verified_states|check constraint/);
    expect(await fails(`update commercial_education.program_orders set state='admitted',revision=revision+1 where id=$1`, [orderId])).toContain('program_order_transition_refused');
    expect(await fails(`update commercial_education.program_orders set revision=revision+2 where id=$1`, [orderId])).toContain('program_order_revision_must_increase');
    expect(await fails(`delete from commercial_education.program_orders where id=$1`, [orderId])).toContain('program_order_append_only');
    expect(await fails(`update commercial_education.program_orders set return_success='https://evil.example/buy/return?order='||id||'&returned=success',revision=revision+1 where id=$1`, [orderId])).toMatch(/check constraint|program_order_(session_immutable|transition_refused)/);
    expect(await fails(`update commercial_education.program_orders set return_success='https://evil.example/buy/return?order='||id||'&returned=success',state='checkout_cancelled',revision=revision+1 where id=$1`, [orderId])).toMatch(/check constraint|program_order_session_immutable/);
  });
  it('intake is durable, deduplicated and bounded; verification settles the order from the retrieved object and binds the snapshot', async () => {
    const { checkout, processor } = boundary();
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-b' });
    const order = (await ledger().readOrder(started.started ? started.orderId : ''))!;
    const ref = order.processor!.sessionRef;
    expect(await checkout.admitEvent(event({}, { id: ref }), 'raw', expected)).toEqual({ outcome: 'admitted', detail: 'pending' });
    expect(await checkout.admitEvent(event({}, { id: ref }), 'raw', expected)).toEqual({ outcome: 'duplicate', detail: 'pending' });
    expect(await fails("delete from commercial_education.program_checkout_intake where event_id='evt_sql_1'")).toContain('program_intake_append_only');
    expect(await fails("update commercial_education.program_checkout_intake set body_sha256=repeat('d',64),attempts=attempts+1 where event_id='evt_sql_1'")).toContain('program_intake_identity_immutable');
    // Still open at the processor: retried, not settled.
    expect(await checkout.processEvent('evt_sql_1')).toMatchObject({ state: 'failed_retryable', attempts: 1, lastOutcome: 'session still open' });
    expect((await ledger().readOrder(order.orderId))!.state).toBe('checkout_open');
    processor.settle(ref, 'paid');
    clock += 5 * 60_000;
    const due = await checkout.processDue();
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ state: 'processed', attempts: 2, orderId: order.orderId, lastOutcome: 'payment_verified' });
    const verified = (await ledger().readOrder(order.orderId))!;
    expect(verified).toMatchObject({ state: 'payment_verified', revision: 4, verification: { eventId: 'evt_sql_1', sessionRef: ref, amountMinor: 1999, currency: 'USD', paymentStatus: 'paid', accountRef: 'acct_FictionalAccount1' } });
    expect(await fails("update commercial_education.program_checkout_intake set state='pending',attempts=attempts+1,next_attempt_at=now() where event_id='evt_sql_1'")).toContain('program_intake_settled');
    expect(await fails(`update commercial_education.program_orders set verified_amount_minor=1,revision=revision+1 where id=$1`, [order.orderId])).toMatch(/program_order_verification_immutable|program_order_transition_refused|check constraint/);
    expect(await fails(`update commercial_education.program_orders set state='checkout_expired',revision=revision+1 where id=$1`, [order.orderId])).toMatch(/program_order_transition_refused|check constraint/);
    // A late, distinct event for the same payment is processed as already settled, with no second verification.
    expect(await checkout.admitEvent(event({ id: 'evt_sql_2', type: 'checkout.session.async_payment_succeeded' }, { id: ref }), 'raw', expected)).toMatchObject({ outcome: 'admitted' });
    expect(await checkout.processEvent('evt_sql_2')).toMatchObject({ state: 'processed', lastOutcome: 'already recorded' });
    expect((await ledger().readOrder(order.orderId))!.revision).toBe(4);
  });
  it('the recovery successor: the creation request is recorded once and bound to the order, a delayed payment is processing, a contradiction is a conflict, and the worker reads are bounded', async () => {
    const { checkout, processor } = boundary();
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-r' });
    const order = (await ledger().readOrder(started.started ? started.orderId : ''))!;
    expect(order.creation).toMatchObject({ idempotencyKey: `program-order:${order.orderId}`, request: { clientReferenceId: order.orderId, metadataOrderId: order.orderId, priceRef: 'price_FictionalAbc123', mode: 'payment', quantity: 1 } });
    // The saved request cannot be rewritten, re-keyed, re-priced or attached to another step.
    expect(await fails(`update commercial_education.program_orders set creation=jsonb_set(creation,'{request,expiresAtUnix}','1'::jsonb),state='checkout_cancelled',revision=revision+1 where id=$1`, [order.orderId])).toContain('program_order_creation_immutable');
    expect(await fails(`update commercial_education.program_orders set creation=jsonb_set(creation,'{idempotencyKey}','"program-order:00000000-0000-4000-8000-000000000000"'::jsonb),state='checkout_cancelled',revision=revision+1 where id=$1`, [order.orderId])).toMatch(/program_orders_creation_shape|program_order_creation_immutable/);
    expect(await fails(`update commercial_education.program_orders set creation=null,state='checkout_cancelled',revision=revision+1 where id=$1`, [order.orderId])).toMatch(/program_order_creation_immutable|program_orders_creation_states/);
    // A fresh order cannot skip the recorded creation, and cannot carry one in by insert.
    const admitted = await ledger().admitOrder({ attemptKeyHash: 'b'.repeat(64), funnelSlug: 'longevity-program', organizationId: org, programId: program, offer: (await offers.availability(org, program)) as never, providerPriceRef: 'price_FictionalAbc123' });
    expect((await refusal(() => ledger().transition(admitted.order.orderId, admitted.order.revision, 'checkout_open', { processor: order.processor! }))).category).toBe('transition_refused');
    expect(await fails(`update commercial_education.program_orders set state='creation_pending',revision=revision+1 where id=$1`, [admitted.order.orderId])).toMatch(/program_order_transition_refused|program_orders_creation_states/);
    // A completed checkout whose payment is still processing is processing; success later verifies it once.
    processor.settle(order.processor!.sessionRef, 'processing');
    await checkout.admitEvent(event({ id: 'evt_sql_p1' }, { id: order.processor!.sessionRef }), 'raw', expected);
    expect(await checkout.processEvent('evt_sql_p1')).toMatchObject({ state: 'processed', lastOutcome: 'payment_processing' });
    expect((await ledger().readOrder(order.orderId))!).toMatchObject({ state: 'payment_processing', verification: null });
    expect(await fails(`update commercial_education.program_orders set state='checkout_expired',revision=revision+1 where id=$1`, [order.orderId])).toContain('program_order_transition_refused');
    expect((await ledger().ordersInStates(['payment_processing'], 10)).map(o => o.orderId)).toContain(order.orderId);
    processor.settle(order.processor!.sessionRef, 'succeeded_async');
    await checkout.admitEvent(event({ id: 'evt_sql_p2', type: 'checkout.session.async_payment_succeeded' }, { id: order.processor!.sessionRef }), 'raw', expected);
    expect(await checkout.processEvent('evt_sql_p2')).toMatchObject({ state: 'processed', lastOutcome: 'payment_verified' });
    // The processor later reports a failure for the same session: contradiction, held, not applied.
    processor.settle(order.processor!.sessionRef, 'failed_async');
    await checkout.admitEvent(event({ id: 'evt_sql_p3', type: 'checkout.session.async_payment_failed' }, { id: order.processor!.sessionRef }), 'raw', expected);
    expect(await checkout.processEvent('evt_sql_p3')).toMatchObject({ state: 'conflict', lastOutcome: 'observed failed while the order is payment_verified' });
    expect((await ledger().readOrder(order.orderId))!.state).toBe('payment_verified');
    expect(await fails("update commercial_education.program_checkout_intake set state='pending',attempts=attempts+1,next_attempt_at=now() where event_id='evt_sql_p3'")).toContain('program_intake_settled');
    // The worker reads: only undecided states, bounded; the operator status counts without bodies.
    expect((await refusal(() => ledger().ordersInStates(['payment_verified'] as never, 10))).category).toBe('request_invalid');
    const status = await ledger().workStatus();
    expect(status.orders.payment_verified).toBeGreaterThanOrEqual(1);
    expect(status.intake.conflict).toBe(1);
    expect(Object.keys(status).sort()).toEqual(['intake', 'oldestUnresolvedAt', 'orders']);
    expect(JSON.stringify(status)).not.toMatch(/cs_test_|price_|program-order:/);
  });
  it('a verification whose amount disagrees with the snapshot cannot be written, and a changed curriculum refuses a new admission while the old order keeps its terms', async () => {
    const { checkout, processor } = boundary();
    const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-c' });
    const order = (await ledger().readOrder(started.started ? started.orderId : ''))!;
    const stale = await refusal(() => ledger().transition(order.orderId, order.revision, 'payment_verified', { verification: { eventId: 'evt_sql_x', sessionRef: order.processor!.sessionRef, amountMinor: 1, currency: 'USD', paymentStatus: 'paid', accountRef: 'acct_FictionalAccount1', verifiedAt: now().toISOString() } }));
    expect(['request_invalid', 'transition_refused', 'store_unavailable']).toContain(stale.category);
    expect((await ledger().readOrder(order.orderId))!).toMatchObject({ state: 'checkout_open', revision: 3, verification: null });
    const mismatch = await refusal(() => ledger().transition(order.orderId, order.revision, 'payment_verified', { verification: { eventId: 'evt_sql_y', sessionRef: 'cs_test_otherSession999', amountMinor: 1999, currency: 'USD', paymentStatus: 'paid', accessTermsVersion: undefined, accountRef: 'acct_FictionalAccount1', verifiedAt: now().toISOString() } as never }));
    expect(mismatch.category).toBe('transition_refused');
    await publishVersion(version2, 2, 'b');
    expect(await checkout.start({ funnelSlug: 'longevity-program', programBinding: binding, attemptKey: 'browser-d' })).toMatchObject({ started: false, reason: 'curriculum_changed' });
    expect((await ledger().readOrder(order.orderId))!).toMatchObject({ state: 'checkout_open', pricing: { amountMinor: 1999 }, curriculum: { versionId: version1 } });
    processor.settle(order.processor!.sessionRef, 'expired');
    await checkout.admitEvent(event({ id: 'evt_sql_3', type: 'checkout.session.expired' }, { id: order.processor!.sessionRef }), 'raw', expected);
    expect(await checkout.processEvent('evt_sql_3')).toMatchObject({ state: 'processed', lastOutcome: 'checkout_expired' });
    expect((await ledger().readOrder(order.orderId))!.state).toBe('checkout_expired');
    // A stranger session named by an event is refused and recorded.
    await checkout.admitEvent(event({ id: 'evt_sql_4' }, { id: 'cs_test_strangerSession1' }), 'raw', expected);
    expect(await checkout.processEvent('evt_sql_4')).toMatchObject({ state: 'refused', lastOutcome: 'no order for session' });
    expect(await checkout.returnStatus(order.orderId)).toEqual({ state: 'checkout_expired' });
  });
});
