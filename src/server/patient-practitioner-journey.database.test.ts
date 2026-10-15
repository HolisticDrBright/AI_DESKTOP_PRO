import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A fictional patient and a fictional clinic, end to end, under clinic-membership sign-in: the real Desktop live routes
// (session, selection, stale-tab fence, family gate), the real messaging deployment handler and practitioner program
// route under `database_current`, the real patient-app adapters, the shared contracts, and one database holding the
// assembled production schema, both lab candidates, the BLOCKED program candidate and boundary, and the UNREGISTERED
// current-membership setter. Only the browser's cookies and request headers, the network hop between the Desktop and
// the API (with API Gateway's JWT check), and the clock are simulated. A source fixture, never hosted acceptance.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find(cookie => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter(cookie => cookie.name === name) : browser.cookies),
  }),
  headers: async () => browser.headers,
}));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));

import { POST as careMessagesRoute } from '@/app/api/live/care-messages/route';
import { POST as programAssignmentsRoute } from '@/app/api/live/program-assignments/route';
import { parseCareMessageResponse, type CareMessageRequest } from '@/contracts/careMessages';
import { parseProgramAssignmentResponse, type ProgramAssignmentRequest } from '@/contracts/programAssignments';
import type { ApiGatewayV2Event } from './clinical-core/aws-identity-api';
import { createCareMessagingHandler, type CareMessagingBuild } from './clinical-core/care-messaging-deployment';
import { createCurrentMembershipProgramApi } from './clinical-core/current-membership-program-api';
import { createCurrentMembershipProgramAssignments } from './clinical-core/current-membership-program-assignments';
import { createProductionProgramAssignments, PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256, PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256 } from './clinical-core/production-program-assignments';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './clinical-core/database';
import { classifyDatabaseRejection } from './clinical-core/rds-data-database';

const API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const WORKFORCE_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce';
const CONSUMER_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer';
const REVIEW = '2'.repeat(64);
const HOST = 'penrnyupn3.us-east-2.awsapprunner.com';
const CLINIC = randomUUID(), OTHER_CLINIC = randomUUID();
const practitioner = { person: randomUUID(), sub: randomUUID() };
let patient: { person: string; sub: string };
let connection: string, record: string, version: string;

let db: PGlite;
let afterBinding: ((tx: Transaction) => Promise<void>) | undefined;
const REQUEST_INVALID = /\bprogram_assignment_invalid\b/;
const CONFLICT = /\b(program_assignment_conflict|program_assignment_revision_stale|program_review_stale|program_assignment_state_invalid|program_tasks_remaining|program_phase_not_due|program_check_in_required|program_practitioner_review_required|program_clinical_items_held)\b/;
const unwrap = (v: unknown) => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v;
const database: ClinicalCoreDatabase = { transaction: async work => {
  try {
    return await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      return work({ query: async (sql: string, parameters: readonly unknown[] = []) => {
        const result = await tx.query(sql, parameters.map(unwrap));
        if (sql.startsWith('select clinical_private.set_current_workforce_context(') && afterBinding) await afterBinding(tx);
        return result as never;
      } });
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof ClinicalCoreDatabaseRejection || !(cause instanceof Error) || !/^(program_|care_message_|workforce_membership|request_context|consumer_)/.test(message)) {
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? cause;
    }
    throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection(
      REQUEST_INVALID.test(message) ? 'request_invalid' : CONFLICT.test(message) ? 'conflict' : 'operation_refused');
  }
} };
const activation = { contract: 'production-program-activation/1', enabled: true, target: 'production-clinical',
  schemaCandidateSha256: PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256, evidenceSha256: 'e'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-11T00:00:00Z' };
const boundaryActivation = { contract: 'program-consumer-boundary-activation/1', enabled: true, target: 'production-clinical',
  programCandidateSha256: PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256, boundaryCandidateSha256: PRODUCTION_PROGRAM_BOUNDARY_CANDIDATE_SHA256,
  evidenceSha256: 'd'.repeat(64), reviewedBy: 'FICTIONAL REVIEW FIXTURE', reviewedAt: '2026-10-14T00:00:00Z' };

// The services, as their hosts would construct them.
let messagingApi: (event: ApiGatewayV2Event) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
const programApi = createCurrentMembershipProgramApi({ configuration: { workforceIssuer: WORKFORCE_ISSUER, workforceAudience: 'w'.repeat(26), organizationId: CLINIC },
  programs: () => createCurrentMembershipProgramAssignments({ database, activation, boundaryActivation }) });
const patientPrograms = createProductionProgramAssignments({ database, activation, boundaryActivation, verifyConsumerCore: async () => undefined });

// The network between the Desktop and the API: API Gateway verifies the JWT and hands the Lambda its claims.
const sent: Array<{ path: string; clinic: string[] }> = [];
const idToken = (sub: string) => [{ alg: 'RS256' }, { sub, token_use: 'id' }].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fictional';
async function network(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url).pathname;
  const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
  sent.push({ path, clinic: Object.entries(headers).filter(([key]) => key === 'x-alp-selected-organization-id').map(([, value]) => value) });
  const token = headers.authorization!.replace(/^Bearer /, '');
  const sub = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub;
  const now = Math.floor(Date.now() / 1000);
  const event: ApiGatewayV2Event = { routeKey: `POST ${path}`, headers, body: String(init.body),
    requestContext: { authorizer: { jwt: { claims: { iss: WORKFORCE_ISSUER, aud: 'w'.repeat(26), token_use: 'id', sub, email_verified: 'true',
      iat: now - 10, exp: now + 900, auth_time: now - 10 } } } } };
  const answer = await (path === '/clinical-core/workforce/messages' ? messagingApi(event) : programApi(event));
  return new Response(answer.body, { status: answer.statusCode, headers: answer.headers });
}

// The Desktop: one practitioner's browser session and the tab a request comes from.
const binding = (sub: string) => createHash('sha256').update(`aidp-selected-clinic/1|${sub}`).digest('hex');
const tabToken = (sub: string, organizationId: string) => 'v1.' + createHash('sha256')
  .update(`aidp-expected-clinic/1|${sub}|${organizationId}`).digest('base64url').slice(0, 32);
function signIn(clinic: string) {
  browser.cookies = [{ name: 'aidp_at', value: idToken(practitioner.sub) }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) },
    { name: 'aidp_em', value: 'fictional.practitioner@example.test' }, { name: 'aidp_org', value: clinic }, { name: 'aidp_org_sub', value: binding(practitioner.sub) }];
}
const fromTab = (clinic: string) => { browser.headers = new Headers({ 'x-aidp-expected-clinic': tabToken(practitioner.sub, clinic) }); };
const post = (path: string, body: unknown) => new Request(`http://0.0.0.0:3000${path}`, { method: 'POST',
  headers: { host: HOST, origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function desk<T>(route: 'messages' | 'programs', body: CareMessageRequest | ProgramAssignmentRequest) {
  const answered = route === 'messages' ? await careMessagesRoute(post('/api/live/care-messages', body)) : await programAssignmentsRoute(post('/api/live/program-assignments', body));
  const json = await answered.json() as { data?: unknown; error?: string };
  return { status: answered.status, binding: answered.headers.get('x-aidp-clinic-binding'), error: json.error,
    data: json.data === undefined ? undefined : (route === 'messages' ? parseCareMessageResponse(body as CareMessageRequest, json.data)
      : parseProgramAssignmentResponse(body as ProgramAssignmentRequest, json.data)) as T };
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- answers are parsed by the shared contracts first

// The patient app (V2): its own consumer routes, with the patient's own token, through the same contracts.
async function app(body: CareMessageRequest) {
  const now = Math.floor(Date.now() / 1000);
  const answer = await messagingApi({ routeKey: 'POST /clinical-core/consumer/messages', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: CONSUMER_ISSUER, aud: 'c'.repeat(26), sub: patient.sub, token_use: 'id',
      'custom:person_id': patient.person, 'custom:organization_id': CLINIC, 'custom:production_bound': 'true', email_verified: 'true',
      iat: now - 10, exp: now + 900, auth_time: now - 10 } } } } });
  const json = JSON.parse(answer.body) as { data?: unknown };
  return { status: answer.statusCode, data: json.data === undefined ? undefined : parseCareMessageResponse(body, json.data) as Json };
}
const appPrograms = async (body: ProgramAssignmentRequest) => parseProgramAssignmentResponse(body, await patientPrograms({
  actorPersonId: patient.person, organizationId: CLINIC, identitySubject: patient.sub, identityPool: 'consumer', purpose: 'clinical_data',
  environment: 'production-clinical', dataClassification: 'clinical_phi', productionBound: true, containsPhi: true, realPatientData: true,
}, body, 'Bearer fictional-patient')) as Json;
const messageCount = async () => Number((await db.query<{ n: number }>('select count(*)::int as n from clinical_core.messages')).rows[0]!.n);
const reply = (threadId: string, text = 'FICTIONAL care team reply'): CareMessageRequest => ({ action: 'send', requestId: randomUUID(), connectionId: connection, threadId,
  body: text, acknowledgement: 'care-messages/1' });
async function patientOpensThread() {
  const opened = await app({ action: 'send', requestId: randomUUID(), connectionId: connection, subject: 'Fictional question',
    body: 'FICTIONAL patient message', acknowledgement: 'care-messages/1' });
  expect(opened.status).toBe(200);
  return opened.data!.threadId as string;
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const file of ['production-candidates/lab-result-transfer-v2.sql', 'production-candidates/lab-observation-attestation.sql', 'production-candidates/production-program-assignments.sql',
    'production-candidates/production-program-consumer-boundary.sql', 'source-candidates/workforce-current-membership-context.sql']) {
    await db.exec(readFileSync(`infra/aws-clinical-core/${file}`, 'utf8'));
  }
  for (const table of ['production_program_activation', 'program_consumer_boundary_activation']) {
    await db.query(`update clinical_core.${table} set enabled=true,evidence_sha256=repeat('e',64),reviewed_by='FICTIONAL REVIEW FIXTURE',reviewed_at=now()`);
  }
  await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values('protocols_supplements','journey-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC'),($2,'FICTIONAL OTHER CLINIC')", [CLINIC, OTHER_CLINIC]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [practitioner.person, 'subject_' + practitioner.person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [practitioner.person, practitioner.sub]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$3,'practitioner','active'),($2,$3,'practitioner','active')",
    [CLINIC, OTHER_CLINIC, practitioner.person]);
  const sql: string = files['20261006010000_production_care_messaging.sql'];
  const build: CareMessagingBuild = { sourceCommit: '1'.repeat(40), sourceClean: true, migrationCount: 106,
    migrationReleaseSha256: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
    functions: [...sql.matchAll(/create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
      .map(([, schema, name, body]) => ({ schema, name, sha256: createHash('sha256').update(body).digest('hex'), callable: schema === 'clinical_core' })) };
  const subjects = Array.from({ length: 12 }, () => randomUUID());
  journeySubjects.push(...subjects);
  messagingApi = createCareMessagingHandler({ SOURCE_COMMIT: build.sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256, AWS_REGION: 'us-east-2',
    DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked', CARE_MESSAGING_WORKFORCE_AUTHORITY: 'database_current',
    CONSUMER_ISSUER, CONSUMER_AUDIENCE: 'c'.repeat(26), WORKFORCE_ISSUER, WORKFORCE_AUDIENCE: 'w'.repeat(26), CARE_MESSAGING_ORGANIZATION_ID: CLINIC,
    CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
    DATABASE_REVIEW_SHA256: REVIEW, WORKFORCE_MFA_REVIEW_SHA256: REVIEW, MESSAGING_REVIEW_SHA256: REVIEW, RETENTION_REVIEW_SHA256: REVIEW,
    QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: REVIEW, QUALIFICATION_ACCOUNT_ID: '588966314750',
    QUALIFICATION_IDENTITY_SUBJECTS: [practitioner.sub, ...subjects].join(',') }, build, () => database) as typeof messagingApi;
}, 120_000);
const journeySubjects: string[] = [];
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  afterBinding = undefined; sent.length = 0;
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN', API);
  vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
  vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', 'care_messages,program_assignments');
  vi.stubGlobal('fetch', vi.fn(network));
  signIn(CLINIC); fromTab(CLINIC);
  // The fictional patient connects to the fictional clinic and agrees to messaging, from the app.
  patient = { person: randomUUID(), sub: journeySubjects.shift()! };
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [patient.person, 'subject_' + patient.person.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [patient.person, patient.sub]);
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','journey-fixture')", [patient.person]);
  record = randomUUID(); connection = randomUUID();
  const artifact = randomUUID();
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')", [record, CLINIC, 'patient_' + record.replaceAll('-', '')]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, CLINIC, record, patient.person]);
  await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
    values($1,$2,'messaging',$5,$3,'TEST','approved',now(),$4)`, [artifact, CLINIC, 'a'.repeat(64), practitioner.person, 'fictional-' + artifact]);
  await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
    representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'messaging','granted','patient_app','self',1,$5)`, [CLINIC, record, connection, artifact, patient.person]);
  // A published curriculum: a lesson phase, then a phase with a supplement step the governed catalog cannot vouch for.
  const program = randomUUID(); version = randomUUID();
  await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL curriculum','active',$3)", [program, CLINIC, practitioner.person]);
  await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at)
    values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp())`, [version, CLINIC, program, practitioner.person]);
  const lessonStep = (id: string) => ({ id, title: 'Fictional lesson ' + id, kind: 'lesson', instructions: 'Read the fictional lesson.', released: true, authorship: 'practitioner_authored' });
  await db.query(`update clinical_core.program_versions set content=$2::jsonb,content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,
    [version, JSON.stringify({ title: 'Fictional', modules: [], consumerProgram: { title: 'Fictional curriculum', phases: [
      { id: 'phase-1', title: 'Foundations', days: 1, transition: 'scheduled', items: [lessonStep('lesson-a')] },
      { id: 'phase-2', title: 'Next steps', days: 1, transition: 'practitioner', items: [lessonStep('lesson-b'), { id: 'supp-1', title: 'Fictional supplement step',
        kind: 'supplement', instructions: 'Fictional instruction.', released: true, product: { id: 'product-fictional-1', ingredientKeys: ['fictional_other_mineral'],
          dose: '100 mg', purchaseUrl: 'https://shop.example.test/fictional-journey', catalog: { stableId: 'prd_fictional_unlisted', version: 1, target: 'production-clinical' } } }] }] } })]);
});

describe('the patient and the practitioner, end to end', () => {
  it('message, reply, second-device re-read; assign, review, adopt, complete and advance a phase', async () => {
    const threadId = await patientOpensThread();
    const listed = await desk<Json>('messages', { action: 'list' });
    expect(listed).toMatchObject({ status: 200, binding: tabToken(practitioner.sub, CLINIC) });
    expect(listed.data!.threads.map((t: Json) => t.threadId)).toContain(threadId);
    expect((await desk<Json>('messages', { action: 'read', threadId })).data!.messages.map((m: Json) => m.body)).toEqual(['FICTIONAL patient message']);
    expect(await desk<Json>('messages', reply(threadId))).toMatchObject({ status: 200, data: { action: 'send', duplicate: false } });
    // The patient's second device reads the same thread and sees the reply.
    const reread = await app({ action: 'read', threadId });
    expect(reread.data!.messages.map((m: Json) => [m.sender, m.body])).toEqual([['workforce', 'FICTIONAL care team reply'], ['consumer', 'FICTIONAL patient message']]);

    expect((await desk<Json>('programs', { action: 'programs' })).data!.programs.map((p: Json) => p.programVersionId)).toContain(version);
    const preview = await desk<Json>('programs', { action: 'preview', programVersionId: version });
    expect(JSON.stringify(preview.data)).not.toContain('shop.example.test');
    const assigned = await desk<Json>('programs', { action: 'assign', connectionId: connection, programVersionId: version });
    expect(assigned).toMatchObject({ status: 200, data: { action: 'assign', state: 'offered' } });
    const enrollmentId = assigned.data!.enrollmentId as string;
    const offered = await appPrograms({ action: 'read', enrollmentId });
    expect(offered.review.held).toContain('supp-1');
    await appPrograms({ action: 'accept', enrollmentId, sourceDigest: offered.assignment.sourceDigest, expectedRevision: offered.assignment.revision, planRevision: offered.review.planRevision });
    const active = await appPrograms({ action: 'read', enrollmentId });
    await patientPrograms({ actorPersonId: patient.person, organizationId: CLINIC, identitySubject: patient.sub, identityPool: 'consumer', purpose: 'clinical_data',
      environment: 'production-clinical', dataClassification: 'clinical_phi', productionBound: true, containsPhi: true, realPatientData: true },
    { action: 'complete', enrollmentId, sourceDigest: active.assignment.sourceDigest, expectedRevision: active.assignment.revision, planRevision: active.review.planRevision, itemId: 'lesson-a' }, 'Bearer fictional-patient');
    // Two days pass. Only the clock moves: the phase start is set back, outside the API, past the row's immutability trigger.
    await db.transaction(async tx => {
      await tx.exec('set local session_replication_role=replica');
      await tx.query("update clinical_core.program_assignments set phase_started_at=phase_started_at-interval '2 days' where id=$1", [enrollmentId]);
    });
    const done = await appPrograms({ action: 'read', enrollmentId });
    expect(await appPrograms({ action: 'advance', enrollmentId, sourceDigest: done.assignment.sourceDigest, expectedRevision: done.assignment.revision }))
      .toMatchObject({ action: 'advance', phaseIndex: 1, finished: false });
    const status = await desk<Json>('programs', { action: 'status', connectionId: connection });
    expect(status.data!.assignments).toEqual([expect.objectContaining({ enrollmentId, state: 'active', phaseIndex: 1, completedCount: 1 })]);
    // Every request to the API named exactly the selected clinic, and nothing else chose one.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(request => request.clinic.length === 1 && request.clinic[0] === CLINIC)).toBe(true);
  });
});

describe('a disconnect racing a reply', () => {
  it('reply first: it is stored; after the disconnect neither side can read the conversation', async () => {
    const threadId = await patientOpensThread();
    expect((await desk('messages', reply(threadId))).status).toBe(200);
    await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1", [connection]);
    expect((await desk('messages', { action: 'read', threadId })).status).toBe(403);
    expect((await app({ action: 'read', threadId })).status).toBe(403);
  });
  it('disconnect first: the reply is refused and nothing is stored', async () => {
    const threadId = await patientOpensThread();
    await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1", [connection]);
    const before = await messageCount();
    expect((await desk('messages', reply(threadId))).status).toBe(403);
    expect(await messageCount()).toBe(before);
  });
});

describe('a clinic switch racing a reply', () => {
  it('reply first: it is stored in the clinic it was sent in; then the stale tab is refused and the other clinic sees nothing of it', async () => {
    const threadId = await patientOpensThread();
    expect((await desk('messages', reply(threadId))).status).toBe(200);
    signIn(OTHER_CLINIC);
    const calls = sent.length;
    expect(await desk('messages', { action: 'read', threadId })).toMatchObject({ status: 409, error: 'clinic_selection_changed' });
    expect(sent.length).toBe(calls);
    // The tab that switched asks in its own clinic; this messaging API serves only the clinic it is configured for.
    fromTab(OTHER_CLINIC);
    expect((await desk('messages', { action: 'list' })).status).toBe(403);
    expect(sent.at(-1)!.clinic).toEqual([OTHER_CLINIC]);
  });
  it('switch first: the reply from the stale tab never leaves the Desktop and nothing is stored', async () => {
    const threadId = await patientOpensThread();
    signIn(OTHER_CLINIC);
    const before = await messageCount(), calls = sent.length;
    expect(await desk('messages', reply(threadId))).toMatchObject({ status: 409, error: 'clinic_selection_changed' });
    expect(sent.length).toBe(calls);
    expect(await messageCount()).toBe(before);
  });
  it('an answer names the binding it was produced under; one asked in the other clinic carries no binding for this tab', async () => {
    // The browser fence (src/lib/clinic-binding.ts, clinic-binding.test.ts) turns an answer under another binding into
    // "clinic changed" instead of showing it; this is the server half it relies on.
    await patientOpensThread();
    const here = await desk('messages', { action: 'list' });
    expect(here.binding).toBe(tabToken(practitioner.sub, CLINIC));
    signIn(OTHER_CLINIC); fromTab(OTHER_CLINIC);
    const there = await desk('programs', { action: 'status' });
    expect(there).toMatchObject({ status: 403, binding: null });
    expect(sent.at(-1)!.clinic).toEqual([OTHER_CLINIC]);
  });
});

describe('membership revoked racing an assignment', () => {
  it('revoked inside the assignment\'s own transaction: refused, nothing assigned; revoked before: refused at the next request', async () => {
    afterBinding = async tx => {
      await tx.exec('reset role');
      await tx.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [CLINIC, practitioner.person]);
      await tx.exec('set local role clinical_core_api');
    };
    expect((await desk('programs', { action: 'assign', connectionId: connection, programVersionId: version })).status).toBe(403);
    afterBinding = undefined;
    expect(Number((await db.query<{ n: number }>('select count(*)::int as n from clinical_core.program_assignments where connection_id=$1', [connection])).rows[0]!.n)).toBe(0);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [CLINIC, practitioner.person]);
    try {
      expect((await desk('programs', { action: 'status' })).status).toBe(403);
      expect((await desk('messages', { action: 'list' })).status).toBe(403);
    } finally {
      await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2", [CLINIC, practitioner.person]);
    }
    expect((await desk('programs', { action: 'status' })).status).toBe(200);
  });
});
