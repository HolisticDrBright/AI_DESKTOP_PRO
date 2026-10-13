import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { classifyDatabaseRejection } from '@/server/clinical-core/rds-data-database';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '@/server/commerce/program-commerce-activation';
import { createSqlProgramOfferLedger } from '@/server/commerce/program-offer-ledger-sql';
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, createSqlCheckoutLedger } from '@/server/commerce/program-checkout-ledger-sql';
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, createSqlEducationLedger } from '@/server/commerce/program-education-ledger-sql';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from '@/server/commerce/program-commerce-authority';
import { PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256 } from '@/server/commerce/reviewed/commerce-role-sessions';
import { createClaimDelivery, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider, codeFromMessage } from '@/server/commerce/program-claim-delivery';
import { createProgramCheckout } from '@/server/commerce/program-checkout';
import { createProgramSettlement } from '@/server/commerce/program-settlement';
import { createFictionalCheckoutProcessor } from '@/server/commerce/program-checkout-processor';
import type { OfferActor } from '@/server/commerce/program-offer-ledger';
import type { VerifiedEvent } from '@/server/stripe-boundary';
import { createProgramMediaNativeLedger } from '@/server/programs/program-media-native-ledger';
import { createProgramMediaAuthoring } from '@/server/programs/program-media-authoring';
import { createFictionalProgramMediaStore } from '@/server/programs/program-media-fictional';
import { createSqlLearnerMediaLedger } from '@/server/programs/learner-media-ledger-sql';
import { createLearnerMediaService, PROGRAM_MEDIA_LEARNER_ADMISSION_PARENTS, PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256 } from '@/server/programs/learner-media';
import { createFictionalLearnerMediaStorage } from '@/server/programs/learner-media-fictional';
import { PROGRAM_LEARNER_MEDIA_CONTRACT, type LearnerMediaRequest } from '@/contracts/programLearnerMedia';
import type { ProgramLessonMediaReference } from '@/contracts/programLessonMedia';

/**
 * Test support: the learner media world on an embedded engine. The installed migration manifest, the
 * catalog-admission candidate, the four media candidates, the seven commerce candidates and the
 * runtime sessions (each checked against its pinned digest), then the BLOCKED learner admission
 * successor; two fictional clinics, authors, a non-clinical staff member and two fictional learners;
 * the real authoring runtime through the restricted media worker for publications, and the real
 * checkout, settlement, delivery and claim path for purchases. One embedded connection and one
 * superuser for fixture setup only: nothing built here is hosted, provider or device evidence.
 */
const ensure = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
export const CAPTION = 'WEBVTT\n\n00:00.000 --> 00:02.000\nFictional caption for a test lesson.';
export const TRANSCRIPT = 'Fictional transcript of a test lesson. Nothing here is advice.';
export type Bought = { entitlementId: string; curriculum: { versionId: string; version: number; sourceDigest: string } };

export async function openLearnerMediaWorld(dataDir?: string) {
 const db = dataDir ? await PGlite.create(dataDir, { extensions: { pgcrypto } }) : new PGlite({ extensions: { pgcrypto } });
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
 async function asSession(role: string, sql: string, args: unknown[] = [], context?: { person: string; org: string | null; pool: 'workforce' | 'consumer'; subject: string }): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error?: string }> {
   const back = await original();
   try {
     await db.exec(`set session authorization ${role}`);
     return await db.transaction(async tx => {
       if (context) await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [context.person, context.org, context.pool, context.subject, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
       return { ok: true as const, rows: (await tx.query<Record<string, unknown>>(sql, args)).rows };
     });
   } catch (error) { return { ok: false as const, rows: [], error: (error as Error).message }; }
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

  /* -------------------------------------------------------------- build */
   const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
   ensure(!manifest.migrations.some(m => /program[-_](media|offer|checkout|order|education|entitlement)|learner|commercial_education/.test(m.file)), 'a media or commerce candidate is in the installed manifest');
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
   ensure(commerce.at(-1)![1] === parents['program-commerce-runtime-sessions.sql'], 'runtime sessions parent moved');
   for (const [file, digest] of ordered) { const text = readFileSync(SC + file, 'utf8'); ensure(sha(text) === digest, file + ' does not match its pinned SHA-256'); await db.exec(text); }
   const candidate = readFileSync(CANDIDATE, 'utf8');
   ensure(candidate.startsWith('-- BLOCKED source candidate (successor)'), 'candidate is not marked BLOCKED');
   for (const digest of Object.values(parents)) ensure(candidate.includes(digest), 'candidate does not name parent ' + digest);
   ensure(sha(candidate) === PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256, 'candidate does not match its pinned SHA-256');
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
 return {
  db, sha, ids: { org, otherOrg, author, otherAuthor, staffOnly, program, sibling, foreignProgram, midProgram, alicePerson, bobPerson, alice, bob }, storage,
  fails, asRole, asSession, api, offers, purchase, workforce, consumer, authoring, publishVideo, lesson, phasesWith, content, publishVersion,
  enableDelivery, admissions, statusOf, ledger, fictionalStorage, service, request, sqlRead,
 };
}
export type LearnerMediaWorld = Awaited<ReturnType<typeof openLearnerMediaWorld>>;
