import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '../clinical-core/database';
import { classifyDatabaseRejection } from '../clinical-core/rds-data-database';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '../commerce/program-commerce-activation';
import { createSqlProgramOfferLedger } from '../commerce/program-offer-ledger-sql';
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, createSqlCheckoutLedger } from '../commerce/program-checkout-ledger-sql';
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, createSqlEducationLedger } from '../commerce/program-education-ledger-sql';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from '../commerce/program-commerce-authority';
import { PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256 } from '../commerce/reviewed/commerce-role-sessions';
import { createClaimDelivery, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider, codeFromMessage } from '../commerce/program-claim-delivery';
import { createProgramCheckout } from '../commerce/program-checkout';
import { createProgramSettlement } from '../commerce/program-settlement';
import { createFictionalCheckoutProcessor } from '../commerce/program-checkout-processor';
import type { OfferActor } from '../commerce/program-offer-ledger';
import type { VerifiedEvent } from '../stripe-boundary';
import { createProgramMediaNativeLedger } from './program-media-native-ledger';
import { createProgramMediaAuthoring } from './program-media-authoring';
import { createFictionalProgramMediaStore } from './program-media-fictional';
import { createSqlLearnerMediaLedger } from './learner-media-ledger-sql';
import { createLearnerMediaService, createStaffMediaService, PROGRAM_MEDIA_LEARNER_ADMISSION_PARENTS, PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256 } from './learner-media';
import { createFictionalLearnerMediaStorage } from './learner-media-fictional';
import { PROGRAM_LEARNER_MEDIA_CONTRACT, type LearnerMediaRequest } from '@/contracts/programLearnerMedia';
import type { ProgramLessonMediaReference } from '@/contracts/programLessonMedia';

/**
 * Learner media WP1 and the SQL half of WP2: the BLOCKED successor program-media-learner-admission.sql
 * on the whole chain it names (catalog admission, the four media candidates, the seven commerce
 * candidates and the runtime sessions), on an embedded engine. Publications are made by the real
 * authoring runtime through the restricted media worker; purchases by the real checkout, settlement,
 * delivery and claim path; reads through the SQL learner media adapter on the API role with the
 * request context a verified session would produce, and by DIRECT statements from sessions whose
 * session user is the reduced role. Storage is the fictional reader (no network).
 *
 * One embedded connection, one superuser for fixture setup only: grants and row policies are
 * exercised, but nothing here is hosted isolation, lock contention or provider evidence.
 */
const SC = 'infra/aws-clinical-core/source-candidates/';
const CANDIDATE = SC + 'program-media-learner-admission.sql';
const sha = (text: string | Buffer) => createHash('sha256').update(typeof text === 'string' ? text.replace(/\r\n/g, '\n') : text).digest('hex');
const id = (n: number) => '7c000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), otherOrg = id(2), author = id(3), otherAuthor = id(4), staffOnly = id(5);
const program = id(6), sibling = id(7), foreignProgram = id(8), midProgram = id(9);
const alicePerson = id(20), bobPerson = id(21);
const alice = 'sub:fictional-media-alice-01', bob = 'sub:fictional-media-bob-0002';
const storage = { purpose: 'educational_media' as const, phiAllowed: false as const, dedicated: true as const, bucket: 'alp-fictional-lessons', expectedBucketOwner: '588966314750',
  region: 'us-east-2', kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/7c000000-0000-4000-8000-000000000099', maxImageBytes: 16777216, maxVideoBytes: 268435456, publicOrigin: 'https://lessons.fictional.example/' };
let db: PGlite;

const fails = async (sql: string, args: unknown[] = []) => { try { await db.query(sql, args); } catch (error) { return (error as Error).message; } return 'none'; };
const asRole = (role: string): ClinicalCoreDatabase => ({ transaction: work => db.transaction(async tx => {
  await tx.exec(`set local role ${role}`);
  return work({ query: async <Row extends Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
    try { return await tx.query<Row>(text, parameters.map(p => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p)); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection('operation_refused');
    }
  } });
}) });
const api = asRole('clinical_core_api');
const original = () => db.query<{ s: string }>('select session_user::text as s').then(r => r.rows[0]!.s);
/** One statement from a session whose SESSION user is the role, after the request context the server would set. */
async function asSession(role: string, sql: string, args: unknown[] = [], context?: { person: string; org: string | null; pool: 'workforce' | 'consumer'; subject: string }) {
  const back = await original();
  try {
    await db.exec(`set session authorization ${role}`);
    return await db.transaction(async tx => {
      if (context) await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [context.person, context.org, context.pool, context.subject, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
      return { ok: true as const, rows: (await tx.query<Record<string, unknown>>(sql, args)).rows };
    });
  } catch (error) { return { ok: false as const, error: (error as Error).message }; }
  finally { await db.exec(`set session authorization ${back}`); }
}

/* -------------------------------------------------------------- commerce: the real purchase path */

const evidence = () => ({ contract: 'program-commerce-activation/1', enabled: true, target: 'synthetic-staging', schemaCandidateSha256: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-13T00:00:00Z' });
const offers = createSqlProgramOfferLedger({ database: api, activation: evidence(), identity: (actor: OfferActor) => ({ identityPool: 'workforce', identitySubject: 'wf:' + actor.personId }) });
const chain = { activation: evidence(), checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, commerceAuthorityCandidateSha256: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 };
const orders = createSqlCheckoutLedger({ database: api, ...chain });
const workerOrders = createSqlCheckoutLedger({ database: asRole('commercial_education_worker'), authority: 'worker', ...chain });
const education = () => createSqlEducationLedger({
  database: api, worker: asRole('commercial_education_worker'), delivery: asRole('commercial_education_delivery'), operator: asRole('commercial_education_operator'), ...chain,
  educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, educationDeliveryCandidateSha256: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, educationProgressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256,
});
const sealer = createFictionalClaimSealer(), contacts = createFictionalContactAuthority(), provider = createFictionalDeliveryProvider();
const clock = Date.parse('2026-10-13T12:00:00Z');
const now = () => new Date(clock);
const processor = createFictionalCheckoutProcessor({ now });
// The processor's own price list holds the fixture amount each fixture offer is published with.
processor.setPriceAmount('price_FictionalMedia01', 1234);
processor.setPriceAmount('price_FictionalMedia02', 1234);
const checkout = createProgramCheckout({ offers, ledger: orders, processor, publicOrigin: 'https://clinic.fictional.example', now });
const workerCheckout = createProgramCheckout({ offers, ledger: workerOrders, processor, publicOrigin: 'https://clinic.fictional.example', now });
const settlement = () => createProgramSettlement({ ledger: education(), curriculumContent: async () => { throw new Error('the SQL read is the authority here'); }, expectedAccountRef: 'acct_FictionalAccount1', now, sealer });
const expected = { accountRef: 'acct_FictionalAccount1', apiVersion: '2025-08-27.basil' };
const event = (eventId: string, sessionRef: string): VerifiedEvent => ({ id: eventId, type: 'checkout.session.completed', livemode: false, created: 1, data: { object: { object: 'checkout.session', id: sessionRef } } });
async function codeFor(orderId: string): Promise<string> {
  const address = `purchaser+${orderId.slice(0, 8)}@fictional.example`;
  contacts.contacts.set(orderId, address);
  const pass = await createClaimDelivery({ ledger: education(), sealer, contacts, provider, now }).deliverDue();
  if (!pass.ok) throw new Error('delivery pass could not read its queue');
  const message = [...provider.mailbox].reverse().find(m => m.to === address);
  if (!message) throw new Error('nothing reached the purchaser');
  return codeFromMessage(message);
}
type Bought = { entitlementId: string; curriculum: { versionId: string; version: number; sourceDigest: string } };
async function purchase(attemptKey: string, person: string, subject: string, programId = program): Promise<Bought> {
  const started = await checkout.start({ funnelSlug: 'longevity-program', programBinding: { organizationId: org, programId }, attemptKey });
  if (!started.started) throw new Error('checkout refused: ' + JSON.stringify(started));
  const order = (await orders.readOrder(started.started ? started.orderId : ''))!;
  processor.settle(order.processor!.sessionRef, 'paid');
  await checkout.admitEvent(event('evt_' + attemptKey, order.processor!.sessionRef), 'raw', expected);
  await workerCheckout.processEvent('evt_' + attemptKey);
  const verified = (await orders.readOrder(order.orderId))!;
  const settled = await settlement().settleOrder(verified);
  if (!settled.settled) throw new Error('settlement refused: ' + settled.reason);
  const claimed = await settlement().claim({ kind: 'consumer', personId: person, identitySubject: subject }, await codeFor(order.orderId));
  if (claimed.outcome !== 'claimed') throw new Error('claim refused: ' + claimed.reason);
  return { entitlementId: claimed.entitlement.entitlementId, curriculum: claimed.entitlement.curriculum };
}

/* -------------------------------------------------------------- media: the real authoring runtime */

const workforce = (person: string, clinic: string): ClinicalRequestContext => ({ actorPersonId: person, organizationId: clinic, identityPool: 'workforce', identitySubject: 'wf:' + person,
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false });
const consumer = (person: string, subject: string): ClinicalRequestContext => ({ actorPersonId: person, organizationId: null as unknown as string, identityPool: 'consumer', identitySubject: subject,
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false });
const mediaWorker: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
  await tx.exec('set local role program_media_worker');
  return work({ query: async (text, parameters) => await tx.query(text, parameters?.map(p => typeof p === 'object' && p !== null && 'kind' in p && 'value' in p ? p.value : p) ?? []) as never });
}) };
const authoring = () => createProgramMediaAuthoring({ ledger: createProgramMediaNativeLedger(mediaWorker, { evidenceSha256: 'a'.repeat(64), storage }),
  store: createFictionalProgramMediaStore({ kmsKeyArn: storage.kmsKeyArn }), storage, activation: { enabled: true, reason: 'Fictional embedded test only' } });
const CAPTION = 'WEBVTT\n\n00:00.000 --> 00:02.000\nFictional caption for a test lesson.';
const TRANSCRIPT = 'Fictional transcript of a test lesson. Nothing here is advice.';
/** Upload, caption, transcribe and publish one fictional video as `person` of `clinic` for `programId`; returns the exact reference. */
async function publishVideo(person: string, clinic: string, programId: string, label: string, text: { caption?: string; transcript?: string } = { caption: CAPTION, transcript: TRANSCRIPT }) {
  const runtime = authoring(), context = workforce(person, clinic);
  const bytes = new TextEncoder().encode('fictional mp4 bytes ' + label + ' ' + randomUUID());
  const reserved = await runtime.prepare(context, { commandId: randomUUID(), programId, kind: 'video', contentType: 'video/mp4', bytes: bytes.length, sha256: sha(Buffer.from(bytes)), fileName: 'lesson.mp4' });
  let artifact = await runtime.admit(context, { artifactId: reserved.artifactId, sha256: reserved.sha256, bytes: reserved.bytes }, bytes);
  if (text.caption) artifact = await runtime.attachText(context, { artifactId: artifact.artifactId, expectedVersion: artifact.version, slot: 'caption', text: text.caption, source: 'supplied_by_author', format: 'vtt' });
  if (text.transcript) artifact = await runtime.attachText(context, { artifactId: artifact.artifactId, expectedVersion: artifact.version, slot: 'transcript', text: text.transcript, source: 'supplied_vendor_file', format: 'plain' });
  const reference = await runtime.publish(context, { artifactId: artifact.artifactId, expectedVersion: artifact.version });
  return { reference: reference as unknown as ProgramLessonMediaReference, artifact, runtime, context };
}

/* -------------------------------------------------------------- curriculum versions */

const lesson = (itemId: string, extra: Record<string, unknown> = {}) => ({ id: itemId, title: 'Fictional ' + itemId, kind: 'lesson', instructions: 'Fictional reading for ' + itemId + '. Nothing here is advice.', released: true, ...extra });
const phasesWith = (items: unknown[]) => [{ id: 'phase-1', title: 'Fictional phase one', days: 7, transition: 'scheduled', items }];
const content = (phases: unknown) => JSON.stringify({ consumerProgram: { title: 'Fictional media course (test fixture)', phases } });
let nextVersion = 1;
/** A draft version of `programId`, then the same status change the publish command makes. Returns the refusal text, or 'none'. */
async function publishVersion(programId: string, clinic: string, phases: unknown, versionId = randomUUID()) {
  const version = nextVersion++;
  await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id) values($1,$2,$3,$4,'approved',$5::jsonb,$6)`,
    [versionId, clinic, programId, version, content(phases), clinic === org ? author : otherAuthor]);
  const refused = await fails(`with s as (update clinical_core.synthetic_desktop_program_versions set status='superseded' where program_id=$1 and status='published' returning 1)
    update clinical_core.synthetic_desktop_program_versions set status='published',published_at=clock_timestamp() where id=$2`, [programId, versionId]);
  if (refused === 'none') await db.query("update clinical_core.synthetic_desktop_programs set status='published',published_version_id=$2 where id=$1", [programId, versionId]);
  return { versionId, version, refused };
}
/** Fixture stand-in for the separately reviewed change that enables learner delivery. */
const enableDelivery = () => db.query("update clinical_core.program_media_learner_delivery set enabled=true,evidence_sha256=repeat('d',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=clock_timestamp()");
const admissions = async (versionId: string) => (await db.query<{ n: number }>('select count(*)::int as n from clinical_core.program_curriculum_media_admissions where curriculum_version_id=$1', [versionId])).rows[0]!.n;
const statusOf = async (versionId: string) => (await db.query<{ status: string }>('select status from clinical_core.synthetic_desktop_program_versions where id=$1', [versionId])).rows[0]!.status;

/* -------------------------------------------------------------- the learner side */

const ledger = createSqlLearnerMediaLedger({ database: api, candidateSha256: PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256 });
const fictionalStorage = createFictionalLearnerMediaStorage();
const service = createLearnerMediaService({ ledger, storage: fictionalStorage });
const request = (bought: Bought, itemId: string, reference: ProgramLessonMediaReference, slot = 0): LearnerMediaRequest => ({
  contractVersion: PROGRAM_LEARNER_MEDIA_CONTRACT, entitlementId: bought.entitlementId, curriculum: bought.curriculum,
  lesson: { phaseId: 'phase-1', itemId }, slot, expected: { artifactId: reference.artifactId, version: reference.version, sha256: reference.sha256 },
});
const sqlRead = (person: string, subject: string, entitlementId: string, itemId: string, slot = 0) =>
  asSession('clinical_core_api', 'select commercial_education.education_media_for_caller($1,$2,$3,$4) as data', [entitlementId, 'phase-1', itemId, slot], { person, org: null, pool: 'consumer', subject });

beforeAll(async () => {
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_](media|offer|checkout|order|education|entitlement)|learner|commercial_education/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
  const commerce: [string, string][] = [
    ['program-offer-revisions.sql', PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256], ['program-checkout-orders.sql', PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256],
    ['program-checkout-recovery.sql', PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256], ['program-education-access.sql', PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256],
    ['program-education-delivery.sql', PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256], ['program-commerce-authority.sql', PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256],
    ['program-education-progress.sql', PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256], ['program-commerce-runtime-sessions.sql', PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256],
  ];
  const parents = PROGRAM_MEDIA_LEARNER_ADMISSION_PARENTS;
  const ordered: [string, string][] = [
    ['program-education-catalog-admission.sql', parents['program-education-catalog-admission.sql']],
    ['program-media-ledger.sql', parents['program-media-ledger.sql']], ['program-media-settlement.sql', parents['program-media-settlement.sql']],
    ['program-media-native-ledger.sql', parents['program-media-native-ledger.sql']], ['program-media-multipart.sql', parents['program-media-multipart.sql']],
    ...commerce,
  ];
  expect(commerce.at(-1)![1]).toBe(parents['program-commerce-runtime-sessions.sql']);
  for (const [file, digest] of ordered) { const text = readFileSync(SC + file, 'utf8'); expect(sha(text), file).toBe(digest); await db.exec(text); }
  const candidate = readFileSync(CANDIDATE, 'utf8');
  expect(candidate.startsWith('-- BLOCKED source candidate (successor)')).toBe(true);
  for (const digest of Object.values(parents)) expect(candidate).toContain(digest);
  expect(sha(candidate)).toBe(PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256);
  await db.exec(candidate);

  await db.query(`insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional media clinic'),($2,'Fictional other clinic')`, [org, otherOrg]);
  for (const [person, clinic, role] of [[author, org, 'practitioner'], [otherAuthor, otherOrg, 'owner'], [staffOnly, org, 'staff']] as const) {
    await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'workforce',$2,true)`, [person, 'wf:' + person]);
    await db.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [clinic, person, role]);
  }
  for (const [person, subject] of [[alicePerson, alice], [bobPerson, bob]] as const) {
    await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [person, 'syn_' + person.replaceAll('-', '')]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,'consumer',$2,true)`, [person, subject]);
  }
  await db.query(`insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Fictional media program',$3),($4,$2,'Fictional sibling program',$3),($5,$6,'Fictional foreign program',$7)`,
    [program, org, author, sibling, foreignProgram, otherOrg, otherAuthor]);
  await db.query(`update clinical_core.program_media_activation set enabled=true,evidence_sha256=$1,reviewed_by='Fictional fixture operator',reviewed_at=clock_timestamp(),
    storage_bucket=$2,public_origin=$3,native_evidence_sha256=$1,expected_bucket_owner=$4,region=$5,kms_key_arn=$6,max_image_bytes=$7,max_video_bytes=$8`,
    ['a'.repeat(64), storage.bucket, storage.publicOrigin, storage.expectedBucketOwner, storage.region, storage.kmsKeyArn, storage.maxImageBytes, storage.maxVideoBytes]);
  await db.query(`update commercial_education.program_commerce_activation set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
  await db.query(`select commercial_education.record_reviewed_access_terms('education-access-terms/1','fixed_days','not_required','fictional-refund-policy/1','FICTIONAL REVIEW FIXTURE',repeat('f',64))`);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('the candidate itself', () => {
  it('is BLOCKED, unregistered, and adds one NOLOGIN non-bypass owner role; the API, worker and media roles read none of its tables', async () => {
    expect((await db.query("select rolcanlogin,rolbypassrls,rolsuper,rolinherit from pg_roles where rolname='program_media_learner_authority'")).rows).toEqual([{ rolcanlogin: false, rolbypassrls: false, rolsuper: false, rolinherit: false }]);
    for (const table of ['clinical_core.program_curriculum_media_admissions', 'clinical_core.program_curriculum_media_withdrawals', 'clinical_core.program_media_learner_delivery', 'clinical_core.program_media_text_snapshots']) {
      const r = await asSession('clinical_core_api', `select * from ${table}`);
      expect(r.ok ? 'readable' : r.error, table).toMatch(/permission denied/);
      expect((await db.query<{ ok: boolean }>(`select has_table_privilege('program_media_worker',$1,'SELECT') as ok`, [table])).rows[0]!.ok, 'worker ' + table).toBe(false);
    }
    expect((await db.query<{ ok: boolean }>(`select has_table_privilege('program_media_authority','clinical_core.program_curriculum_media_admissions','SELECT') as ok`)).rows[0]!.ok).toBe(false);
    expect((await db.query(`select has_table_privilege('clinical_core_api','clinical_core.program_media_text_snapshots','SELECT') as api, has_table_privilege('program_media_worker','clinical_core.program_media_text_snapshots','SELECT') as worker,
      pg_has_role('clinical_core_api','program_media_learner_authority','MEMBER') as member`)).rows).toEqual([{ api: false, worker: false, member: false }]);
    expect((await db.query("select enabled from clinical_core.program_media_learner_delivery")).rows).toEqual([{ enabled: false }]);
    // Every function it adds is owned by a non-bypass role, never the migration superuser.
    const owners = (await db.query<{ proname: string; owner: string }>(`select p.proname, r.rolname as owner from pg_proc p join pg_roles r on r.oid=p.proowner
      where p.proname in('program_media_capture_text','program_curriculum_media_admit','program_learner_media_text','program_learner_media_slot','education_media_for_caller','program_media_admitted_for_staff','withdraw_curriculum_media') order by 1`)).rows;
    expect(owners).toEqual([
      { proname: 'education_media_for_caller', owner: 'program_media_learner_authority' }, { proname: 'program_curriculum_media_admit', owner: 'program_media_learner_authority' },
      { proname: 'program_learner_media_slot', owner: 'program_media_learner_authority' }, { proname: 'program_learner_media_text', owner: 'program_media_learner_authority' },
      { proname: 'program_media_admitted_for_staff', owner: 'program_media_learner_authority' }, { proname: 'program_media_capture_text', owner: 'program_media_authority' },
      { proname: 'withdraw_curriculum_media', owner: 'program_media_learner_authority' },
    ]);
  });
});

describe('admission, text and the learner read, end to end', () => {
  let video: Awaited<ReturnType<typeof publishVideo>>, first: { versionId: string; version: number; refused: string }, a: Bought, b: Bought;

  beforeAll(async () => {
    video = await publishVideo(author, org, program, 'first');
    first = await publishVersion(program, org, phasesWith([lesson('lesson-a', { nativeMedia: [video.reference] }), lesson('lesson-b'), lesson('lesson-hidden', { released: false, nativeMedia: [video.reference] })]));
    expect(first.refused).toBe('none');
    const created = await offers.execute({ personId: author, organizationId: org }, { action: 'create', programId: program, terms: { mode: 'paid', name: 'Fictional media course', pricing: { currency: 'USD', amountMinor: 1234, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalMedia01', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    const offerId = created.action === 'create' ? created.offer.offerId : '';
    await offers.execute({ personId: author, organizationId: org }, { action: 'approve_provider_mapping', offerId, expectedRevision: 1 });
    await offers.execute({ personId: author, organizationId: org }, { action: 'publish', offerId, expectedRevision: 2 });
    a = await purchase('media-a', alicePerson, alice);
    b = await purchase('media-b', bobPerson, bob);
  }, 120_000);

  it('captured the published version\'s exact caption and transcript in the publication\'s own transaction, append-only', async () => {
    const rows = (await db.query<{ slot: string; body: string; sha256: string; source: string; format: string }>(`select s.slot,s.body,s.sha256,s.source,s.format from clinical_core.program_media_text_snapshots s
      join clinical_core.program_media_publications p on p.id=s.publication_id where p.artifact_id=$1 order by s.slot`, [video.reference.artifactId])).rows;
    expect(rows).toEqual([
      { slot: 'caption', body: CAPTION, sha256: sha(CAPTION), source: 'supplied_by_author', format: 'vtt' },
      { slot: 'transcript', body: TRANSCRIPT, sha256: sha(TRANSCRIPT), source: 'supplied_vendor_file', format: 'plain' },
    ]);
    expect(await fails("update clinical_core.program_media_text_snapshots set body='rewritten'")).toMatch(/append_only|append-only|immutable/i);
    expect(await fails('delete from clinical_core.program_media_text_snapshots')).toMatch(/append_only|append-only|immutable/i);
  });

  it('admitted the exact reference at publish time; the version, its digest and the entitlements are untouched', async () => {
    const rows = (await db.query<{ phase_id: string; item_id: string; slot: number; artifact_version: number; reference: unknown }>('select phase_id,item_id,slot,artifact_version,reference from clinical_core.program_curriculum_media_admissions where curriculum_version_id=$1 order by item_id', [first.versionId])).rows;
    expect(rows).toEqual([
      { phase_id: 'phase-1', item_id: 'lesson-a', slot: 0, artifact_version: video.reference.version, reference: video.reference },
      { phase_id: 'phase-1', item_id: 'lesson-hidden', slot: 0, artifact_version: video.reference.version, reference: video.reference },
    ]);
    const stored = (await db.query<{ content: { consumerProgram: { phases: unknown } } }>('select content from clinical_core.synthetic_desktop_program_versions where id=$1', [first.versionId])).rows[0]!.content;
    const digest = (await db.query<{ d: string }>("select encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex') as d", [JSON.stringify(stored.consumerProgram.phases)])).rows[0]!.d;
    expect(a.curriculum).toEqual({ versionId: first.versionId, version: first.version, sourceDigest: digest });
    expect(b.curriculum).toEqual(a.curriculum);
  });

  it('answers held for everyone while learner delivery is disabled, before any authority is reported', async () => {
    expect((await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-a')).rows).toEqual([{ data: { outcome: 'held' } }]);
    expect((await sqlRead(bobPerson, bob, a.entitlementId, 'lesson-a')).rows).toEqual([{ data: { outcome: 'held' } }]);
    expect(await service(consumer(alicePerson, alice), request(a, 'lesson-a', video.reference))).toEqual({ outcome: 'held' });
    await enableDelivery();
  });

  it('serves the owner the exact object version with the publication\'s text, and decides twice', async () => {
    const before = fictionalStorage.issued.length;
    const reply = await service(consumer(alicePerson, alice), request(a, 'lesson-a', video.reference));
    expect(reply).toMatchObject({ outcome: 'available', entitlementId: a.entitlementId, curriculum: a.curriculum, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, slot: 0,
      media: { artifactId: video.reference.artifactId, version: video.reference.version, sha256: video.reference.sha256, kind: 'video', contentType: 'video/mp4' },
      caption: { state: 'available', text: CAPTION, sha256: sha(CAPTION), format: 'vtt' }, transcript: { state: 'available', text: TRANSCRIPT, format: 'plain' } });
    if (reply.outcome !== 'available') throw new Error('not available');
    const url = new URL(reply.playback.url);
    expect(url.hostname).toBe('alp-fictional-lessons.s3.us-east-2.amazonaws.com');
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(`program-media/${org}/${program}/${video.reference.artifactId}/${video.reference.sha256}.mp4`);
    expect(fictionalStorage.issued.length).toBe(before + 1);
    const object = (await db.query<{ object_version: string }>('select object_version from clinical_core.program_media_artifacts where id=$1', [video.reference.artifactId])).rows[0]!;
    expect(url.searchParams.get('versionId')).toBe(object.object_version);
    // The second learner reads their own purchase too.
    expect((await service(consumer(bobPerson, bob), request(b, 'lesson-a', video.reference))).outcome).toBe('available');
  });

  it('refuses every other reader with one identical answer and no content or object metadata', async () => {
    const answers = [
      await sqlRead(bobPerson, bob, a.entitlementId, 'lesson-a'),           // another learner's entitlement
      await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-b'),       // a text-only lesson
      await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-hidden'),  // an unreleased lesson, even though admitted
      await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-a', 1),    // a slot the lesson does not have
      await sqlRead(alicePerson, alice, randomUUID(), 'lesson-a'),          // an entitlement nobody holds
    ];
    for (const answer of answers) expect(answer.rows).toEqual([{ data: { outcome: 'refused' } }]);
    // The service says the same thing for a request whose expected identity is not what was admitted.
    expect(await service(consumer(alicePerson, alice), { ...request(a, 'lesson-a', video.reference), expected: { ...request(a, 'lesson-a', video.reference).expected, sha256: 'f'.repeat(64) } })).toEqual({ outcome: 'not_available' });
    expect(await service(consumer(bobPerson, bob), request(a, 'lesson-a', video.reference))).toEqual({ outcome: 'not_available' });
    // A workforce identity is not a learner, and no body can name one.
    await expect(service(workforce(author, org), request(a, 'lesson-a', video.reference))).rejects.toMatchObject({ category: 'identity_refused' });
    expect((await asSession('clinical_core_api', 'select commercial_education.education_media_for_caller($1,$2,$3,$4)', [a.entitlementId, 'phase-1', 'lesson-a', 0])).ok).toBe(false);
  });

  it('refuses publishes that name foreign, cross-program, unrecorded, previewed or stale media; nothing is admitted and the version stays unpublished', async () => {
    const foreign = await publishVideo(otherAuthor, otherOrg, foreignProgram, 'foreign');
    const siblingVideo = await publishVideo(author, org, sibling, 'sibling');
    const fresh = await publishVideo(author, org, program, 'fresh');
    const cases: [string, unknown, RegExp][] = [
      ['another clinic', foreign.reference, /program_media_admission_foreign/],
      ['another program of this clinic', siblingVideo.reference, /program_media_admission_foreign/],
      ['a version nobody published', { ...fresh.reference, version: fresh.reference.version + 1 }, /program_media_admission_unrecorded/],
      ['bytes nobody published', { ...fresh.reference, sha256: 'b'.repeat(64) }, /program_media_admission_unrecorded/],
      ['a preview capability in place of the address', { ...fresh.reference, url: fresh.reference.url + '?X-Amz-Signature=' + 'c'.repeat(64) }, /program_media_admission_unrecorded/],
      ['a reference whose clinic was rewritten', { ...foreign.reference, origin: { clinic: org, programId: program } }, /program_media_admission_unrecorded/],
    ];
    for (const [label, ref, refusal] of cases) {
      const attempt = await publishVersion(program, org, phasesWith([lesson('lesson-x', { nativeMedia: [ref] })]));
      expect(attempt.refused, label).toMatch(refusal);
      expect(await statusOf(attempt.versionId), label).toBe('approved');
      expect(await admissions(attempt.versionId), label).toBe(0);
    }
    // Changed text after publication moves the artifact past its publication: that publication is stale and not admitted.
    await fresh.runtime.attachText(fresh.context, { artifactId: fresh.artifact.artifactId, expectedVersion: fresh.reference.version, slot: 'caption', text: 'WEBVTT\n\nA later fictional caption.', source: 'supplied_by_author', format: 'vtt' });
    const stale = await publishVersion(program, org, phasesWith([lesson('lesson-x', { nativeMedia: [fresh.reference] })]));
    expect(stale.refused).toMatch(/program_media_admission_stale/);
    expect(await admissions(stale.versionId)).toBe(0);
    // A retired artifact is never newly admitted.
    const retiring = await publishVideo(author, org, program, 'retiring');
    await retiring.runtime.retire(retiring.context, { artifactId: retiring.artifact.artifactId, expectedVersion: retiring.reference.version });
    const retired = await publishVersion(program, org, phasesWith([lesson('lesson-x', { nativeMedia: [retiring.reference] })]));
    expect(retired.refused).toMatch(/program_media_admission_not_ready/);
    // One bad slot among good ones rolls the whole publish back: no admission row survives.
    const mixed = await publishVersion(program, org, phasesWith([lesson('lesson-ok', { nativeMedia: [video.reference] }), lesson('lesson-bad', { nativeMedia: [foreign.reference] })]));
    expect(mixed.refused).toMatch(/program_media_admission_foreign/);
    expect(await admissions(mixed.versionId)).toBe(0);
    // The program's published version is still the one the learners bought.
    expect((await db.query<{ v: string }>('select published_version_id as v from clinical_core.synthetic_desktop_programs where id=$1', [program])).rows[0]!.v).toBe(first.versionId);
  });

  it('never serves a duplicated or over-slot item, and admission rows cannot be written, replayed or changed by any request role', async () => {
    const tooMany = Array.from({ length: 6 }, () => video.reference);
    for (const items of [[lesson('lesson-dup', { nativeMedia: [video.reference, video.reference] })], [lesson('lesson-many', { nativeMedia: tooMany })],
      [lesson('lesson-mixed', { media: [{ kind: 'video', url: 'https://videos.fictional.example/a' }, { kind: 'video', url: 'https://videos.fictional.example/b' }, { kind: 'video', url: 'https://videos.fictional.example/c' }], nativeMedia: [video.reference, { ...video.reference, version: video.reference.version }, video.reference] })]]) {
      expect((await db.query<{ ok: boolean | null }>('select clinical_private.program_consumer_content($1::jsonb) is not null as ok', [content(phasesWith(items))])).rows[0]!.ok).toBe(false);
    }
    const row = (await db.query<Record<string, unknown>>('select * from clinical_core.program_curriculum_media_admissions where curriculum_version_id=$1 and item_id=$2', [first.versionId, 'lesson-a'])).rows[0]!;
    const insert = `insert into clinical_core.program_curriculum_media_admissions(organization_id,program_id,curriculum_version_id,curriculum_version,phase_id,item_id,slot,publication_id,artifact_id,artifact_version,sha256,reference)
      values($1,$2,$3,$4,$5,'lesson-b',0,$6,$7,$8,$9,$10::jsonb)`;
    const args = [org, program, first.versionId, first.version, 'phase-1', row.publication_id, row.artifact_id, row.artifact_version, row.sha256, JSON.stringify(row.reference)];
    expect((await asSession('clinical_core_api', insert, args)).ok).toBe(false);
    expect((await asSession('clinical_core_api', 'update clinical_core.program_curriculum_media_admissions set slot=1')).ok).toBe(false);
    // Even the owner role cannot replay a slot or rewrite a row.
    const replay = await db.transaction(async tx => { await tx.exec('set local role program_media_learner_authority'); await tx.query(insert.replace("'lesson-b'", "'lesson-a'"), args); }).then(() => 'none', (error: Error) => error.message);
    expect(replay).toMatch(/duplicate key|unique/);
    expect(await fails('update clinical_core.program_curriculum_media_admissions set slot=1')).toMatch(/append_only|append-only|immutable/i);
    // Publishing an already-published version again is a no-op for admissions.
    await db.query("update clinical_core.synthetic_desktop_program_versions set status='published' where id=$1", [first.versionId]);
    expect(await admissions(first.versionId)).toBe(2);
  });

  it('keeps serving the purchased version after the author publishes a replacement, and never the newer, unsold one', async () => {
    const replacement = await publishVideo(author, org, program, 'replacement');
    const later = await publishVersion(program, org, phasesWith([lesson('lesson-a', { nativeMedia: [replacement.reference] }), lesson('lesson-new', { nativeMedia: [replacement.reference] })]));
    expect(later.refused).toBe('none');
    expect(await admissions(later.versionId)).toBe(2);
    expect((await service(consumer(alicePerson, alice), request(a, 'lesson-a', video.reference))).outcome).toBe('available');
    expect(await service(consumer(alicePerson, alice), request(a, 'lesson-a', replacement.reference))).toEqual({ outcome: 'not_available' });
    expect((await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-new')).rows).toEqual([{ data: { outcome: 'refused' } }]);
    // Retiring the original artifact does not take away bytes a sold version admitted.
    await video.runtime.retire(video.context, { artifactId: video.artifact.artifactId, expectedVersion: video.reference.version });
    expect((await service(consumer(alicePerson, alice), request(a, 'lesson-a', video.reference))).outcome).toBe('available');
  });

  it('serves the staff host only to an active clinician of the version\'s own clinic', async () => {
    const staff = createStaffMediaService({ ledger, storage: fictionalStorage });
    const body = { contractVersion: 'program-learner-media-staff/1', curriculum: { versionId: first.versionId, version: first.version }, lesson: { phaseId: 'phase-1', itemId: 'lesson-a' }, slot: 0,
      expected: { artifactId: video.reference.artifactId, version: video.reference.version, sha256: video.reference.sha256 } };
    expect((await staff(workforce(author, org), body)).outcome).toBe('available');
    expect(await staff(workforce(otherAuthor, otherOrg), body)).toEqual({ outcome: 'not_available' });
    expect(await staff(workforce(staffOnly, org), body)).toEqual({ outcome: 'not_available' });
    await expect(staff(consumer(alicePerson, alice), body)).rejects.toMatchObject({ category: 'identity_refused' });
  });

  it('a withdrawn admission is never served again; only an author of its clinic can withdraw, once, append-only', async () => {
    const admission = (await db.query<{ id: string }>("select id from clinical_core.program_curriculum_media_admissions where curriculum_version_id=$1 and item_id='lesson-a'", [first.versionId])).rows[0]!.id;
    const withdraw = (person: string, clinic: string) => asSession('clinical_core_api', 'select clinical_core.withdraw_curriculum_media($1,$2) as data', [admission, 'corrected'], { person, org: clinic, pool: 'workforce', subject: 'wf:' + person });
    expect((await withdraw(otherAuthor, otherOrg)).ok).toBe(false);
    expect((await withdraw(staffOnly, org)).ok).toBe(false);
    expect((await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-a')).rows[0]!.data).toMatchObject({ outcome: 'authorized' });
    const done = await withdraw(author, org);
    expect(done.ok && done.rows[0]!.data).toMatchObject({ admissionId: admission, reason: 'corrected' });
    expect((await withdraw(author, org)).ok).toBe(true);
    expect((await db.query<{ n: number }>('select count(*)::int as n from clinical_core.program_curriculum_media_withdrawals where admission_id=$1', [admission])).rows[0]!.n).toBe(1);
    expect((await sqlRead(alicePerson, alice, a.entitlementId, 'lesson-a')).rows).toEqual([{ data: { outcome: 'refused' } }]);
    expect(await service(consumer(alicePerson, alice), request(a, 'lesson-a', video.reference))).toEqual({ outcome: 'not_available' });
    expect(await fails('delete from clinical_core.program_curriculum_media_withdrawals')).toMatch(/append_only|append-only|immutable/i);
  });
});

describe('access that ends while storage is being read', () => {
  it('discards a capability issued for a learner whose entitlement is revoked mid-read, and refuses the next read', async () => {
    await enableDelivery();
    // Its own program and offer, so the course bought here is exactly this version.
    await db.query(`insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,created_by_person_id) values($1,$2,'Fictional mid-read program',$3)`, [midProgram, org, author]);
    const clip = await publishVideo(author, org, midProgram, 'mid-read');
    const versionId = randomUUID();
    const published = await publishVersion(midProgram, org, phasesWith([lesson('lesson-m', { nativeMedia: [clip.reference] })]), versionId);
    expect(published.refused).toBe('none');
    const me = { personId: author, organizationId: org };
    const created = await offers.execute(me, { action: 'create', programId: midProgram, terms: { mode: 'paid', name: 'Fictional mid-read course', pricing: { currency: 'USD', amountMinor: 1234, billing: { kind: 'one_time' } }, providerPriceRef: 'price_FictionalMedia02', accessTermsVersion: 'education-access-terms/1', accessDurationDays: 30 } });
    if (created.action !== 'create') throw new Error('offer not created');
    await offers.execute(me, { action: 'approve_provider_mapping', offerId: created.offer.offerId, expectedRevision: 1 });
    await offers.execute(me, { action: 'publish', offerId: created.offer.offerId, expectedRevision: 2 });
    const c = await purchase('media-c', alicePerson, alice, midProgram);
    expect(c.curriculum.versionId).toBe(versionId);
    const revoke = async () => {
      const revision = (await db.query<{ revision: number }>('select revision from commercial_education.program_entitlements where id=$1', [c.entitlementId])).rows[0]!.revision;
      const out = await asRole('commercial_education_operator').transaction(tx => tx.query('select commercial_education.transition_program_entitlement($1,$2,$3) as data', [c.entitlementId, revision, 'revoked']));
      expect(out.rows[0]).toBeTruthy();
    };
    const slow = createLearnerMediaService({ ledger, storage: createFictionalLearnerMediaStorage({ before: revoke }) });
    expect(await slow(consumer(alicePerson, alice), request(c, 'lesson-m', clip.reference))).toEqual({ outcome: 'not_available' });
    expect((await sqlRead(alicePerson, alice, c.entitlementId, 'lesson-m')).rows).toEqual([{ data: { outcome: 'refused' } }]);
  });

  it('keeps a captured text bound to its digest even below the triggers', async () => {
    const clip = await publishVideo(author, org, program, 'tamper', { transcript: 'Fictional transcript to be tampered with.' });
    // Fixture stand-in for a write that bypasses the append-only trigger (as superuser, triggers suspended): the digest is a constraint, not a trigger.
    await db.exec('set session_replication_role = replica');
    let refusal = 'none';
    try { await db.query("update clinical_core.program_media_text_snapshots s set body='Tampered fictional transcript.' from clinical_core.program_media_publications p where p.id=s.publication_id and p.artifact_id=$1", [clip.reference.artifactId]); }
    catch (error) { refusal = (error as Error).message; }
    finally { await db.exec('set session_replication_role = origin'); }
    expect(refusal).toMatch(/check constraint/);
  });
});

describe('publications recorded before text capture', () => {
  it('stay text-unavailable: nothing is backfilled from the artifact\'s current text', async () => {
    await enableDelivery();
    await db.exec('alter table clinical_core.program_media_publications disable trigger program_media_capture_text');
    let legacy: Awaited<ReturnType<typeof publishVideo>>;
    try { legacy = await publishVideo(author, org, program, 'legacy'); }
    finally { await db.exec('alter table clinical_core.program_media_publications enable trigger program_media_capture_text'); }
    const published = await publishVersion(program, org, phasesWith([lesson('lesson-l', { nativeMedia: [legacy.reference] })]));
    expect(published.refused).toBe('none');
    const staff = createStaffMediaService({ ledger, storage: fictionalStorage });
    const reply = await staff(workforce(author, org), { contractVersion: 'program-learner-media-staff/1', curriculum: { versionId: published.versionId, version: published.version }, lesson: { phaseId: 'phase-1', itemId: 'lesson-l' }, slot: 0,
      expected: { artifactId: legacy.reference.artifactId, version: legacy.reference.version, sha256: legacy.reference.sha256 } });
    expect(reply).toMatchObject({ outcome: 'available', caption: { state: 'unavailable' }, transcript: { state: 'unavailable' } });
  });
});
