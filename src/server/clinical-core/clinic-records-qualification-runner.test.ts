import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { createClinicRecordsHandler, type ClinicRecordsBuild } from './clinic-records-deployment';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ClinicalCoreDatabase } from './database';
import { runClinicRecordsQualification, tokenClaims } from '../../../scripts/clinic-records-qualification-runner.mjs';
import { CLINIC_RECORDS_QUALIFICATION_CASES, CLINIC_RECORDS_QUALIFICATION_SUBJECTS } from '../../../scripts/clinic-records-qualification-report.mjs';

/**
 * The hosted runner, executed end to end against the REAL artifact-bound
 * deployment handler over the real 114 schema in embedded PostgreSQL: the http
 * port invokes the compiled handler with gateway-shaped events, the sql port is
 * a privileged readback, and the fictional release is registered between the
 * two phases exactly as the owner-reviewed operator would. Every one of the
 * thirty observations comes from a real response or readback. Fictional
 * subjects, fictional tokens; no AWS call, registration or activation.
 */
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>; candidate: Record<string, unknown> };
type Ports = { http: (route: string, token: string, body: string) => Promise<{ status: number; json: unknown }>; sql: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }> };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const NOW = 1800000000000, review = '2'.repeat(64), sourceCommit = '1'.repeat(40);
const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const orgX = '11111111-1111-4111-8111-111111111111', orgY = '22222222-2222-4222-8222-222222222222';
const subjects: Record<string, string> = Object.fromEntries((CLINIC_RECORDS_QUALIFICATION_SUBJECTS as string[]).map((k, i) => [k, uuid(i + 1)]));
const binding = () => ({ contract: 'clinic-records-qualification-binding/1', sourceCommit, migrationReleaseSha256: '', extensionSha256: '', apiId: 'abcdefghij',
  organizationId: orgX, otherOrganizationId: orgY,
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', consumerAudience: 'c'.repeat(26),
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', workforceAudience: 'w'.repeat(26),
  subjects: { ...subjects }, reviews: { disclosure: review, retention: '3'.repeat(64), workforceMfa: '4'.repeat(64), qualification: '5'.repeat(64) },
  disclosureRelease: { releaseVersion: 'fictional-qualification-1', sections: ['signed_notes', 'lab_observations'], reviewSha256: review } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
let pg: PGlite, artifact: Artifact, build: ClinicRecordsBuild, persons: Record<string, string>, tokens: Record<string, Record<string, string>>;
const admin = () => ({ transaction: work => pg.transaction(tx => work({ query: (q, parameters = []) => tx.query(q, [...parameters]) })) }) as ClinicalCoreDatabase;
/** The restricted API connection as the hosted RDS Data client presents it: raised refusal words become classified rejections. */
const apiDb = (): ClinicalCoreDatabase => ({ transaction: work => pg.transaction(async tx => { await tx.exec('set local role clinical_core_api'); return work({ query: async (q, parameters = []) => {
  const values = parameters.map(v => v && typeof v === 'object' && (v as { kind?: string }).kind === 'uuid' ? (v as { value: string }).value : v);
  try { return await tx.query(q, values); }
  catch (error) { throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: `ERROR: ${error instanceof Error ? error.message : String(error)}` }) ?? error; }
} }); }) });
function env(bind = binding()) {
  return { SOURCE_COMMIT: sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256, CLINIC_RECORDS_EXTENSION_SHA256: build.extensionSha256, AWS_REGION: 'us-east-2',
    CLINIC_RECORDS_ACTIVATION: 'blocked', PHI_ALLOWED: 'false', DEPLOYMENT_ACCOUNT_ID: '588966314750',
    CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12',
    CLINICAL_DATABASE_NAME: 'clinical_core_qualification', CONSUMER_ISSUER: bind.consumerIssuer, CONSUMER_AUDIENCE: bind.consumerAudience, WORKFORCE_ISSUER: bind.workforceIssuer, WORKFORCE_AUDIENCE: bind.workforceAudience,
    CLINIC_RECORDS_ORGANIZATION_ID: orgX, DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: bind.reviews.workforceMfa, DISCLOSURE_REVIEW_SHA256: bind.reviews.disclosure, RETENTION_REVIEW_SHA256: bind.reviews.retention,
    QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: bind.reviews.qualification, QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_IDENTITY_SUBJECTS: Object.values(bind.subjects).join(',') };
}
/** Fictional JWT-shaped tokens: the gateway would verify the signature; the handler and the runner read only the claims. */
function token(subject: string, pool: 'consumer' | 'workforce', organization: string, authAgeSeconds: number) {
  const bind = binding();
  const claims = { iss: bind[pool === 'consumer' ? 'consumerIssuer' : 'workforceIssuer'], aud: bind[pool === 'consumer' ? 'consumerAudience' : 'workforceAudience'], sub: subjects[subject],
    'custom:person_id': persons[subject], 'custom:organization_id': organization, 'custom:production_bound': 'true', email_verified: 'true', token_use: 'id',
    iat: NOW / 1000 - 5, exp: NOW / 1000 + 3600, auth_time: NOW / 1000 - authAgeSeconds };
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.fictional`;
}
function ports(handler: (event: ApiGatewayV2Event) => Promise<{ statusCode: number; body?: string }>): Ports {
  return {
    http: async (route, bearer, body) => {
      const claims = tokenClaims(bearer) as Record<string, unknown>;
      const response = await handler({ routeKey: route, headers: { 'content-type': 'application/json' }, body, requestContext: { authorizer: { jwt: { claims } } } } as ApiGatewayV2Event);
      let json: unknown = null; try { json = JSON.parse(response.body ?? ''); } catch { json = null; }
      return { status: response.statusCode, json };
    },
    sql: async (text, params) => ({ rows: (await pg.query(text, params)).rows }),
  };
}
async function call<T>(sql: string, args: unknown[], who: string, organization: string) {
  return pg.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    const subject = Object.entries(persons).find(([, id]) => id === who)![0];
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [who, organization, subjects[subject]]);
    return (await tx.query<{ result: T }>(sql, args)).rows[0]?.result as T;
  });
}
const fixtures = { signedNoteText: 'Fictional signed narrative for the qualification runner.', draftNoteText: 'Fictional DRAFT that must never be disclosed.' };
beforeAll(async () => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 }));
  const sql = artifact.files[artifact.manifest.migrations[113].file];
  const body = /create function clinical_core\.clinic_record_request\(_request jsonb\) returns jsonb\nlanguage plpgsql security definer set search_path='' as \$\$([^]*?)\$\$;/.exec(sql)![1];
  build = { sourceCommit, sourceClean: true, migrationCount: 114, migrationReleaseSha256: artifact.candidate.migrationReleaseSha256 as string,
    extensionSha256: artifact.candidate.extensionSha256 as string, dispatcher: { schema: 'clinical_core', name: 'clinic_record_request', sha256: sha(body) } };
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(entry => ({ version: entry.version, name: entry.file.slice(15, -4), sql: artifact.files[entry.file], sha256: sha(artifact.files[entry.file]) }));
  await applyProductionClinicalCoreMigrations(admin(), migrations.slice(0, 106));
  for (const entry of migrations.slice(106)) {
    await pg.exec(entry.sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  // Two fictional clinics, seven fictional subjects, four fictional patients; the runner is told none of these ids except the subjects.
  for (const id of [orgX, orgY]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  persons = {};
  const roles: Record<string, [pool: 'consumer' | 'workforce', organization: string, role: string | null]> = {
    patientA: ['consumer', orgX, null], patientB: ['consumer', orgX, null], patientRevoked: ['consumer', orgX, null], patientOtherClinic: ['consumer', orgY, null],
    practitioner: ['workforce', orgX, 'practitioner'], staffWithoutClinicalRole: ['workforce', orgX, 'staff'], practitionerOtherClinic: ['workforce', orgY, 'practitioner'] };
  for (const [name, [pool, organization, role]] of Object.entries(roles)) {
    const id = randomUUID(); persons[name] = id;
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subjects[name]]);
    if (role) await pg.query('insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,$3)', [organization, id, role]);
  }
  const patient = async (organization: string) => { const id = randomUUID(); await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')", [id, organization, 'patient_' + id.replaceAll('-', '')]); return id; };
  const [a, bPatient, d, c] = [await patient(orgX), await patient(orgX), await patient(orgX), await patient(orgY)];
  for (const [p, consumer, organization, state] of [[a, 'patientA', orgX, 'verified'], [bPatient, 'patientB', orgX, 'verified'], [c, 'patientOtherClinic', orgY, 'verified']] as const) {
    await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,$5,now())", [randomUUID(), organization, p, persons[consumer], state]);
  }
  await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at,revoked_at) values($1,$2,$3,$4,'revoked',now(),now())", [randomUUID(), orgX, d, persons.patientRevoked]);
  const encounter = await call<string>("select clinical_core.start_encounter($1,$2,'follow-up',null) as result", [orgX, a], persons.practitioner, orgX);
  const saved = await call<{ note_id: string }>("select clinical_core.save_note_draft($1,$2,'narrative',$3::jsonb,0,null,'manual','[]'::jsonb) as result", [orgX, encounter, JSON.stringify({ text: fixtures.signedNoteText })], persons.practitioner, orgX);
  await call('select clinical_core.sign_note($1,1) as result', [saved.note_id], persons.practitioner, orgX);
  const draftEncounter = await call<string>("select clinical_core.start_encounter($1,$2,'follow-up',null) as result", [orgX, a], persons.practitioner, orgX);
  await call("select clinical_core.save_note_draft($1,$2,'narrative',$3::jsonb,0,null,'manual','[]'::jsonb) as result", [orgX, draftEncounter, JSON.stringify({ text: fixtures.draftNoteText })], persons.practitioner, orgX);
  const provider = (await pg.query<{ id: string }>("insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at) values($1,'fictional_lab','patient-sync/1','lab-result/1','1','active',$2,now()) returning id", [orgX, persons.practitioner])).rows[0].id;
  const connectionA = (await pg.query<{ id: string }>('select id from clinical_core.patient_connections where patient_record_id=$1', [a])).rows[0].id;
  for (const [marker, status] of [['Ferritin', 'accepted'], ['Iron', 'unreviewed']]) {
    const event = (await pg.query<{ id: string }>(`insert into clinical_core.lab_import_events(organization_id,patient_record_id,connection_id,provider_id,provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,marker_name,value_numeric,unit,collected_at,occurred_at,payload_sha256,state,reviewed_at,reviewed_by_person_id)
      values($1,$2,$3,$4,$5,'panel-1',$6,'1','Iron panel',$6,42.50,'ng/mL',now(),now(),$7,'accepted',now(),$8) returning id`, [orgX, a, connectionA, provider, 'evt-' + marker, marker, sha(marker), persons.practitioner])).rows[0].id;
    await pg.query(`insert into clinical_core.lab_observations(id,organization_id,patient_record_id,import_event_id,panel_name,marker_name,value_numeric,unit,observed_at,review_status,provenance,reviewed_at,reviewed_by_person_id)
      values($1,$2,$3,$4,'Iron panel',$5,42.50,'ng/mL',now(),$6,$7::jsonb,$8,$9)`, [randomUUID(), orgX, a, event, marker, status, JSON.stringify({ source: 'fictional_lab' }), status === 'accepted' ? new Date().toISOString() : null, status === 'accepted' ? persons.practitioner : null]);
  }
  const organizationOf = (name: string) => roles[name][1], poolOf = (name: string) => roles[name][0];
  tokens = Object.fromEntries(Object.keys(roles).map(name => [name, { fresh: token(name, poolOf(name), organizationOf(name), 10), aged: token(name, poolOf(name), organizationOf(name), 6 * 60), stale: token(name, poolOf(name), organizationOf(name), 16 * 60) }]));
}, 180000);
afterAll(async () => { await pg?.close(); });
const candidate = () => artifact.candidate;
const bound = () => ({ ...binding(), migrationReleaseSha256: build.migrationReleaseSha256, extensionSha256: build.extensionSha256 });
const registerRelease = async () => { const d = binding().disclosureRelease; await pg.query("insert into clinical_private.clinic_disclosure_releases(organization_id,release_version,sections,reviewed_by,review_sha256) values($1,$2,$3,'FICTIONAL REVIEWER (qualification fixture, not an approval)',$4)", [orgX, d.releaseVersion, d.sections, d.reviewSha256]); };

describe('clinic-records qualification runner against the real deployment handler and schema', () => {
  it('refuses a token outside its required sign-in window or under another subject before touching anything', async () => {
    const handler = createClinicRecordsHandler(env(), build, apiDb, () => NOW);
    const wrongWindow = await runClinicRecordsQualification({ binding: bound(), candidate: candidate(), tokens: { ...tokens, patientA: { ...tokens.patientA, stale: tokens.patientA.fresh } }, fixtures, ports: ports(handler), now: () => NOW, awaitRelease: registerRelease });
    expect(wrongWindow).toMatchObject({ complete: false, verdict: null, refusal: 'token_window:patientA.stale' });
    expect(wrongWindow.report.cases[0]).toMatchObject({ id: 'consumer_stale_signin_refused', observed: false, failure: 'token_window:patientA.stale' });
    const wrongSubject = await runClinicRecordsQualification({ binding: bound(), candidate: candidate(), tokens: { ...tokens, patientA: { ...tokens.patientA, stale: tokens.patientB.stale } }, fixtures, ports: ports(handler), now: () => NOW, awaitRelease: registerRelease });
    expect(wrongSubject).toMatchObject({ complete: false, refusal: 'token_subject:patientA' });
    expect(Number((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.clinic_record_requests')).rows[0].n)).toBe(0);
    expect(Number((await pg.query<{ n: number }>('select count(*)::int n from clinical_private.clinic_disclosure_releases')).rows[0].n)).toBe(0);
  });
  it('observes all thirty mandatory cases from real responses and readback, registers the fictional release between phases, and matches without acceptance', async () => {
    const handler = createClinicRecordsHandler(env(), build, apiDb, () => NOW);
    let released = 0;
    const result = await runClinicRecordsQualification({ binding: bound(), candidate: candidate(), tokens, fixtures, ports: ports(handler), now: () => NOW, awaitRelease: async () => { released++; await registerRelease(); } });
    const failed = result.report.cases.filter((c: { observed: boolean }) => !c.observed);
    expect(failed, JSON.stringify({ refusal: result.refusal, failed, last: result.report.cases.at(-1) })).toEqual([]);
    const mismatches = (CLINIC_RECORDS_QUALIFICATION_CASES as unknown as { id: string; expect: { status: number | null; error?: string; summary?: Record<string, unknown> }; attest: string[] }[]).flatMap(spec => {
      const row = result.report.cases.find((c: { id: string }) => c.id === spec.id);
      const got = { id: spec.id, status: row.status, error: row.error, summary: spec.expect.summary ? Object.fromEntries(Object.keys(spec.expect.summary).map(k => [k, row.summary?.[k]])) : undefined, attestations: row.attestations };
      const want = { id: spec.id, status: spec.expect.status, error: spec.expect.error ?? null, summary: spec.expect.summary, attestations: Object.fromEntries(spec.attest.map(k => [k, true])) };
      return JSON.stringify(got) === JSON.stringify(want) ? [] : [{ got, want }];
    });
    expect(mismatches).toEqual([]);
    expect(result).toMatchObject({ complete: true, refusal: null, verdict: { verdict: 'mandatory_cases_matched', acceptance: false, phiAllowed: false, humanReviewsVerified: false, cases: CLINIC_RECORDS_QUALIFICATION_CASES.length } });
    expect(released).toBe(1); expect(result.report.releaseRegistered).toEqual(binding().disclosureRelease);
    expect(result.report.cases.map((c: { id: string }) => c.id)).toEqual(CLINIC_RECORDS_QUALIFICATION_CASES.map((c: { id: string }) => c.id));
    for (const row of result.report.cases) expect(Object.values(row.attestations).every(v => v === true), row.id).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain('.fictional'); // no token in the report
    expect(JSON.stringify(result.report)).not.toContain(fixtures.signedNoteText);
  });
  it('refuses to start a run on a target where a release is already registered before the first phase', async () => {
    const handler = createClinicRecordsHandler(env(), build, apiDb, () => NOW);
    const result = await runClinicRecordsQualification({ binding: bound(), candidate: candidate(), tokens, fixtures, ports: ports(handler), now: () => NOW, awaitRelease: registerRelease });
    expect(result).toMatchObject({ complete: false, refusal: 'release_present_before_phase' });
    expect(result.report.cases).toEqual([]);
  });
});
