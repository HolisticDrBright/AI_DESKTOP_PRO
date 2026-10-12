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
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, createSqlEducationLedger } from './program-education-ledger-sql';
import { randomUUID } from 'node:crypto';
import { EducationLedgerError } from './program-education-ledger';
import { FICTIONAL_COURSE_TITLE, fictionalCoursePhases } from '../../test-support/commerceCourse';
import type { EducationProgressRequest } from '../../contracts/programEducationProgress';
import { createClaimDelivery, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider, codeFromMessage } from './program-claim-delivery';
import { createProgramCheckout } from './program-checkout';
import { createProgramSettlement } from './program-settlement';
import { createFictionalCheckoutProcessor } from './program-checkout-processor';
import type { OfferActor } from './program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from './program-commerce-authority';

/**
 * Work package 4: learner progress (program-education-progress/1) against the BLOCKED progress
 * successor on the whole chain, driven through the SQL ledger under the API role with a verified
 * consumer context, and by DIRECT calls from a session whose session user is the API role. The
 * course is the fictional test fixture in the published consumer-content shape, so lesson ids are
 * validated against the stored version exactly as the curriculum read validates its digest.
 */
const OFFER = 'infra/aws-clinical-core/source-candidates/program-offer-revisions.sql';
const CHECKOUT = 'infra/aws-clinical-core/source-candidates/program-checkout-orders.sql';
const CHECKOUT_RECOVERY = 'infra/aws-clinical-core/source-candidates/program-checkout-recovery.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-education-access.sql';
/** The BLOCKED delivery successor, applied after the unchanged candidate above. */
const DELIVERY = 'infra/aws-clinical-core/source-candidates/program-education-delivery.sql';
const AUTHORITY = 'infra/aws-clinical-core/source-candidates/program-commerce-authority.sql';
const PROGRESS = 'infra/aws-clinical-core/source-candidates/program-education-progress.sql';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '64000000-0000-4000-8000-' + String(n).padStart(12, '0');
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
const education = (educationSha = PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, activation: unknown = evidence(), progressSha: string | null = PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256) => createSqlEducationLedger({
  database, worker: asRole('commercial_education_worker'), delivery: asRole('commercial_education_delivery'), operator: asRole('commercial_education_operator'), activation,
  checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256,
  educationCandidateSha256: educationSha, educationDeliveryCandidateSha256: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, commerceAuthorityCandidateSha256: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256, educationProgressCandidateSha256: progressSha ?? undefined,
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
const phases = fictionalCoursePhases;
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
  const progress = readFileSync(PROGRESS, 'utf8');
  expect(progress).toContain('BLOCKED source candidate (successor)');
  expect(progress).toContain(PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256);
  expect(sha(PROGRESS)).toBe(PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256);
  await db.exec(progress);
  await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [org, 'Fictional A']);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [staff, 'syn_' + staff.replaceAll('-', '')]);
  await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`, [staff, 'wf:' + staff]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')`, [org, staff]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [program, org, staff]);
  await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id,published_at) values($1,$2,$3,1,'published',$4::jsonb,$5,clock_timestamp())`, [version1, org, program, JSON.stringify({ consumerProgram: { title: FICTIONAL_COURSE_TITLE, phases } }), staff]);
  await db.query("update clinical_core.synthetic_desktop_programs set published_version_id=$2,status='published' where id=$1", [program, version1]);
}, 120_000);
afterAll(async () => { await db?.close(); });

/** Claim as a verified consumer: the caller is the verified request context. */
async function claimAs(person: string, subject: string, code: string) {
  return settlement().claim({ kind: 'consumer', personId: person, identitySubject: subject }, code);
}

const alicePerson = id(20), bobPerson = id(21);

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
const aliceCaller = { kind: 'consumer' as const, personId: alicePerson, identitySubject: alice };
const bobCaller = { kind: 'consumer' as const, personId: bobPerson, identitySubject: bob };
const operator = { kind: 'operator' as const, operatorId: 'op:fictional-operator-1' };
const lessonA = { phaseId: 'phase-1', itemId: 'lesson-a' }, habitB = { phaseId: 'phase-1', itemId: 'habit-b' }, supplementC = { phaseId: 'phase-1', itemId: 'supplement-c' };
const lessonD = { phaseId: 'phase-1', itemId: 'lesson-d' }, lessonE = { phaseId: 'phase-2', itemId: 'lesson-e' };
type Bought = { orderId: string; entitlementId: string; enrollmentId: string; curriculum: { versionId: string; version: number; sourceDigest: string } };
async function purchase(attemptKey: string, person: string, subject: string): Promise<Bought> {
  const order = await verifiedOrder(attemptKey);
  const settled = await settlement().settleOrder(order);
  if (!settled.settled) throw new Error('settlement refused: ' + settled.reason);
  const claimed = await claimAs(person, subject, await codeFor(order.orderId));
  if (claimed.outcome !== 'claimed') throw new Error('claim refused: ' + claimed.reason);
  const enrollment = (await db.query<{ id: string }>('select id from commercial_education.program_education_enrollments where entitlement_id=$1', [claimed.entitlement.entitlementId])).rows[0]!;
  return { orderId: order.orderId, entitlementId: claimed.entitlement.entitlementId, enrollmentId: enrollment.id, curriculum: claimed.entitlement.curriculum };
}
const write = (bought: Bought, action: 'complete' | 'position', lesson: { phaseId: string; itemId: string }, expectedRevision: number, requestId = randomUUID()): Extract<EducationProgressRequest, { action: 'complete' | 'position' }> =>
  ({ action, entitlementId: bought.entitlementId, enrollmentId: bought.enrollmentId, curriculum: bought.curriculum, lesson, expectedRevision, requestId });
const count = async (table: string, enrollment: string) => (await db.query<{ n: number }>(`select count(*)::int as n from commercial_education.${table} where enrollment_id=$1`, [enrollment])).rows[0]!.n;

describe('learner progress on the progress successor', () => {
  let a: Bought, b: Bought;
  beforeAll(async () => {
    await db.query(`update commercial_education.program_commerce_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
    for (const [person, subject] of [[alicePerson, alice], [bobPerson, bob]] as const) {
      await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
      await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer',$2,true)`, [person, subject]);
    }
    await db.query(`select commercial_education.record_reviewed_access_terms('education-access-terms/1','fixed_days','not_required','fictional-refund-policy/1','FICTIONAL REVIEW FIXTURE',repeat('f',64))`);
    const created = await offers.execute(me, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalAbc123', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.execute(me, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId, expectedRevision: 2 });
    a = await purchase('browser-a', alicePerson, alice);
    b = await purchase('browser-b', bobPerson, bob);
  });
  it('is disabled without its own pin, and no role reads its tables', async () => {
    await expect(education(undefined, undefined, null).progress(aliceCaller, a.entitlementId)).rejects.toBeInstanceOf(EducationLedgerError);
    await expect(education(undefined, undefined, 'f'.repeat(64)).recordProgress(aliceCaller, write(a, 'complete', lessonA, 0))).rejects.toMatchObject({ category: 'store_unavailable' });
    for (const table of ['program_education_progress', 'program_education_completions', 'program_education_progress_receipts']) {
      expect((await asApi(`select * from commercial_education.${table}`)).ok, table).toBe(false);
    }
    // Without a consumer context, or with a workforce one, the functions refuse before reading anything.
    expect((await asApi('select commercial_education.education_progress_for_caller($1) as data', [a.entitlementId])).ok).toBe(false);
    expect((await asApi('select commercial_education.education_progress_for_caller($1) as data', [a.entitlementId], { person: staff, org, pool: 'workforce', subject: 'wf:' + staff })).ok).toBe(false);
  });
  it('reading records nothing; an explicit completion records once with a receipt, and a retry converges on the same receipt', async () => {
    const first = await education().progress(aliceCaller, a.entitlementId);
    expect(first).toMatchObject({ outcome: 'read', progress: { contract: 'program-education-progress/1', entitlementId: a.entitlementId, enrollmentId: a.enrollmentId, revision: 0, completed: [], position: null } });
    expect(await count('program_education_progress_receipts', a.enrollmentId)).toBe(0);
    const command = write(a, 'complete', lessonA, 0);
    const done = await education().recordProgress(aliceCaller, command);
    expect(done).toMatchObject({ outcome: 'recorded', receipt: { requestId: command.requestId, action: 'complete', lesson: lessonA, revision: 1 }, progress: { revision: 1, completed: [{ lesson: lessonA, requestId: command.requestId }] } });
    expect(await education().recordProgress(aliceCaller, command)).toEqual(done);
    expect(await count('program_education_completions', a.enrollmentId)).toBe(1);
    expect(await count('program_education_progress_receipts', a.enrollmentId)).toBe(1);
    expect(await education().recordProgress(aliceCaller, { ...command, lesson: habitB })).toEqual({ outcome: 'refused', reason: 'request_conflict', progress: null });
  });
  it('two devices: a write against an older revision is refused with the current record, and the re-read write lands', async () => {
    const stale = await education().recordProgress(aliceCaller, write(a, 'position', lessonE, 0));
    expect(stale).toMatchObject({ outcome: 'refused', reason: 'revision_stale', progress: { revision: 1, completed: [{ lesson: lessonA }], position: null } });
    expect(await education().recordProgress(aliceCaller, write(a, 'position', lessonE, 1))).toMatchObject({ outcome: 'recorded', progress: { revision: 2, position: lessonE } });
    // Completing an already completed lesson again (a fresh request at the current revision) adds no second completion.
    expect(await education().recordProgress(aliceCaller, write(a, 'complete', lessonA, 2))).toMatchObject({ outcome: 'recorded', progress: { revision: 3, completed: [{ lesson: lessonA }] } });
    expect(await count('program_education_completions', a.enrollmentId)).toBe(1);
  });
  it('refuses another owner, another enrollment, an older version, an unknown lesson, a supplement or unreleased step, and an inactive course', async () => {
    expect(await education().progress(bobCaller, a.entitlementId)).toEqual({ outcome: 'refused', reason: 'not_owner' });
    expect(await education().recordProgress(bobCaller, write(a, 'complete', habitB, 3))).toEqual({ outcome: 'refused', reason: 'not_owner', progress: null });
    expect(await education().recordProgress(aliceCaller, { ...write(a, 'complete', habitB, 3), enrollmentId: b.enrollmentId })).toEqual({ outcome: 'refused', reason: 'enrollment_mismatch', progress: null });
    expect(await education().recordProgress(aliceCaller, { ...write(a, 'complete', habitB, 3), curriculum: { ...a.curriculum, sourceDigest: '0'.repeat(64) } })).toEqual({ outcome: 'refused', reason: 'stale_version', progress: null });
    expect(await education().recordProgress(aliceCaller, write(a, 'complete', { phaseId: 'phase-2', itemId: 'lesson-a' }, 3))).toEqual({ outcome: 'refused', reason: 'unknown_lesson', progress: null });
    expect(await education().recordProgress(aliceCaller, write(a, 'complete', supplementC, 3))).toEqual({ outcome: 'refused', reason: 'not_completable', progress: null });
    expect(await education().recordProgress(aliceCaller, write(a, 'complete', lessonD, 3))).toEqual({ outcome: 'refused', reason: 'not_completable', progress: null });
    // Bob's verified context, called directly from an API session, cannot write to Alice's course by naming it.
    const direct = await asApi('select commercial_education.record_education_progress_for_caller($1::jsonb) as data', [JSON.stringify(write(a, 'complete', habitB, 3))], { person: bobPerson, org: null, pool: 'consumer', subject: bob });
    expect(direct.ok && JSON.stringify(direct.rows)).toContain('not_owner');
    // A held course is inactive: nothing is recorded.
    await settlement().recordPolicy(operator, a.orderId, 'refund', 're_fictional_1');
    expect(await education().recordProgress(aliceCaller, write(a, 'complete', habitB, 3))).toEqual({ outcome: 'refused', reason: 'not_active', progress: null });
    expect(await education().progress(aliceCaller, a.entitlementId)).toMatchObject({ outcome: 'read', progress: { revision: 3 } });
  });
  it('completions and receipts are append-only, and the revision rises by exactly one', async () => {
    expect(await fails('delete from commercial_education.program_education_completions where enrollment_id=$1', [a.enrollmentId])).toContain('append_only_record');
    expect(await fails("update commercial_education.program_education_progress_receipts set action='position' where enrollment_id=$1", [a.enrollmentId])).toContain('append_only_record');
    expect(await fails('update commercial_education.program_education_progress set revision=revision+2 where enrollment_id=$1', [a.enrollmentId])).toContain('program_progress_revision_must_increase');
    expect(await fails('delete from commercial_education.program_education_progress where enrollment_id=$1', [a.enrollmentId])).toContain('program_progress_append_only');
    // Bob's course is untouched by everything above.
    expect(await education().progress(bobCaller, b.entitlementId)).toMatchObject({ outcome: 'read', progress: { revision: 0, completed: [] } });
  });
});
