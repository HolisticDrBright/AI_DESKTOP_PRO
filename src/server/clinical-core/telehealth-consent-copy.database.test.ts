import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { bindTelehealthConsentDatabase } from './telehealth-consent-database-binding';
import { createProductionTelehealthConsent } from './production-telehealth-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { parseTelehealthConsentResponse, type TelehealthConsentRequest } from '../../contracts/telehealthConsent';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { createTelehealthConsentHandler, telehealthConsentConfigurationSha256, type TelehealthConsentBuild } from './telehealth-consent-deployment';
import type { ApiGatewayV2Event } from './aws-identity-api';

// Entire real 112-migration source artifact, actual restricted API role. Every
// identity, approval and consent below is fictional, in memory, never in AWS.
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>;
  releaseHash: string; candidate: Record<string, unknown> };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const build = (script: string) => JSON.parse(execFileSync(process.execPath, [script, '--json'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true })) as Artifact;
let pg: PGlite, parent: Artifact, successor: Artifact, operations: ReturnType<typeof createProductionTelehealthConsent>;
let runtimeBuild: TelehealthConsentBuild;
let org: string, foreign: string, owner: string, other: string, staff: string, patient: string, connection: string;
const copy = 'FICTIONAL TEST ONLY — I agree to fictional telehealth recording and AI notes. Not an approved patient consent.';
const context = (actor = owner, organization = org): ProductionClinicalRequestContext => ({
  actorPersonId: actor, organizationId: organization, identityPool: 'consumer', identitySubject: 'fixture-' + actor,
  purpose: 'consent_management', environment: 'production-clinical', dataClassification: 'clinical_phi',
  containsPhi: true, realPatientData: true, productionBound: true,
});
const rawDatabase: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  const query: ClinicalCoreTransaction['query'] = async (sql, parameters = []) => {
    try { return await tx.query(sql, parameters.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/telehealth_consent_invalid/.test(message)) throw new ClinicalCoreDatabaseRejection('request_invalid');
      if (/telehealth_consent_conflict/.test(message)) throw new ClinicalCoreDatabaseRejection('conflict');
      if (/telehealth_consent_copy_required/.test(message)) throw new ClinicalCoreDatabaseRejection('consent_required');
      if (/owned_account_deletion_write_blocked/.test(message)) throw new ClinicalCoreDatabaseRejection('account_deletion_write_blocked');
      if (/telehealth_consent_refused|care_connection_refused|request_context_refused/.test(message)) throw new ClinicalCoreDatabaseRejection('identity_refused');
      throw error;
    }
  };
  return work({ query });
}) };
const call = (request: TelehealthConsentRequest, actor = owner, organization = org) => operations(context(actor, organization), request);
const review = (): TelehealthConsentRequest => ({ action: 'consent', connectionId: connection, scope: 'telehealth_recording' });
const grant = (artifactId: string, expectedVersion = 0, text = copy): TelehealthConsentRequest => ({
  action: 'grant', connectionId: connection, scope: 'telehealth_recording', artifactId, contentSha256: sha(text), expectedVersion,
});
const withdraw = (expectedVersion: number): TelehealthConsentRequest => ({ action: 'withdraw', connectionId: connection,
  scope: 'telehealth_recording', expectedVersion });
async function artifact(text = copy, withText = true, time = 'clock_timestamp()') {
  const id = randomUUID();
  await pg.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,
    jurisdiction,status,approved_at,approved_by_person_id) values($1,$2,'telehealth_recording',$3,$4,'TEST','approved',${time},$5)`,
  [id, org, 'FICTIONAL-' + id, sha(text), staff]);
  if (withText) await pg.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)',
    [id, org, text, sha(text)]);
  return id;
}
beforeAll(async () => {
  parent = build('scripts/build-fullscript-candidate.mjs');
  successor = build('scripts/build-telehealth-consent-copy-candidate.mjs');
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = successor.manifest.migrations.map(entry => ({ version: entry.version,
    name: entry.file.slice(15, -4), sql: successor.files[entry.file], sha256: sha(successor.files[entry.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({
    query: (sql, parameters = []) => tx.query(sql, [...parameters]),
  })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  // Forward source artifact rehearsal only. These ledger rows are fictional
  // operator facts in memory, not a deployed or reviewed preserving upgrade.
  for (const entry of migrations.slice(106)) {
    await pg.exec(entry.sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  for (const table of ['consent_artifacts', 'consent_grants', 'care_consent_texts'])
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.' + table)).rows[0].n).toBe(0);
  const sql = parent.files['20261006020000_production_care_connections.sql'];
  const functions = [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
  const newSql = successor.files[successor.manifest.migrations.at(-1)!.file];
  const body = /as \$\$([^]*?)\$\$/.exec(newSql)![1];
  operations = createProductionTelehealthConsent(bindTelehealthConsentDatabase(rawDatabase, functions, sha(body)));
  // Source identities and reviews in this test are deliberately fictional.
  // Real SQL bindings are derived from the actual distinct release bytes.
  runtimeBuild = { sourceCommit: '1'.repeat(40), sourceClean: true, sourceInputSha256: '2'.repeat(64), migrationCount: 112,
    migrationReleaseSha256: String(successor.candidate.migrationReleaseSha256), assemblySha256: successor.releaseHash,
    sqlSha256: sha(newSql), functions, telehealthFunctionSha256: sha(body) };
}, 60000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  [org, foreign, owner, other, staff, patient, connection] = Array.from({ length: 7 }, () => randomUUID());
  for (const id of [org, foreign]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const [id, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce']]) {
    await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await pg.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, 'fixture-' + id]);
  }
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, staff]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')", [patient, org, 'patient_' + patient.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
    [connection, org, patient, owner]);
});
describe('unreleased 112 telehealth exact-copy consent under actual SQL authority', () => {
  it('the same112 database exposes its exact ledger to Fullscript without granting consent mutation',async()=>{
    const functionOid=(await pg.query<{oid:number}>("select 'clinical_core.production_telehealth_consent_request(jsonb)'::regprocedure::oid oid")).rows[0].oid;
    await pg.transaction(async tx=>{
      await tx.exec('set local role fullscript_draft_worker');
      const r=await tx.query<{ledger:{version:string;name:string;sha256:string}[];consent_execute:boolean}>(`select
        fullscript_delivery.migration_ledger() ledger,
        has_function_privilege(current_user,$1::oid,'EXECUTE') consent_execute`,[functionOid]);
      expect(r.rows[0].ledger).toEqual(successor.manifest.migrations.map(m=>({version:m.version,name:m.file.slice(15,-4),sha256:sha(successor.files[m.file])})));
      expect(r.rows[0].consent_execute).toBe(false);
    });
  });
  const runtime = (enabled = true) => {
    const now = Date.now(), reviewHash = '3'.repeat(64);
    const environment: Record<string, string> = {
      SOURCE_COMMIT: runtimeBuild.sourceCommit, SOURCE_INPUT_SHA256: runtimeBuild.sourceInputSha256,
      MIGRATION_RELEASE_SHA256: runtimeBuild.migrationReleaseSha256, AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750',
      TELEHEALTH_CONSENT_ACTIVATION: 'blocked', PHI_ALLOWED: 'false', TELEHEALTH_CONSENT_ENABLED: String(enabled),
      TELEHEALTH_CONSENT_ORGANIZATION_ID: org, CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
      CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
      CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12',
      CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
      WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
      DATABASE_REVIEW_SHA256: reviewHash, WORKFORCE_MFA_REVIEW_SHA256: reviewHash, CONNECTION_REVIEW_SHA256: reviewHash,
      CONSENT_REVIEW_SHA256: reviewHash, RETENTION_REVIEW_SHA256: reviewHash, QUALIFICATION_EXECUTION: 'enabled',
      QUALIFICATION_REVIEW_SHA256: reviewHash, QUALIFICATION_ACCOUNT_ID: '588966314750',
      QUALIFICATION_IDENTITY_SUBJECTS: `fixture-${owner},fixture-${other}`,
    };
    environment.TELEHEALTH_CONSENT_CONFIGURATION_SHA256 = telehealthConsentConfigurationSha256(environment);
    const handle = createTelehealthConsentHandler(environment, runtimeBuild, () => rawDatabase, () => now);
    return (request: TelehealthConsentRequest, actor = owner, organization = org) => handle({
      routeKey: 'POST /clinical-core/consumer/telehealth-consent', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      requestContext: { authorizer: { jwt: { claims: { iss: environment.CONSUMER_ISSUER, aud: environment.CONSUMER_AUDIENCE,
        sub: `fixture-${actor}`, token_use: 'id', 'custom:person_id': actor, 'custom:organization_id': organization,
        'custom:production_bound': 'true', email_verified: true, iat: Math.floor(now / 1000) - 10,
        exp: Math.floor(now / 1000) + 1000, auth_time: Math.floor(now / 1000) - 10 } } } },
    } as ApiGatewayV2Event);
  };
  it('composes the compiled handler, consumer API, copy safeguards and actual restricted SQL without substituting a transport', async () => {
    const id = await artifact(), handle = runtime();
    const read = await handle(review());
    expect(read).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    expect(JSON.parse(read.body).data).toMatchObject({ artifact: { artifactId: id, content: copy }, status: 'not_granted', version: 0 });
    const granted = await handle(grant(id));
    expect(granted.statusCode).toBe(200); expect(JSON.parse(granted.body).data).toMatchObject({ status: 'granted', version: 1 });
    const revoked = await handle(withdraw(1));
    expect(revoked.statusCode).toBe(200); expect(JSON.parse(revoked.body).data).toMatchObject({ status: 'revoked', version: 2 });
    expect((await handle(grant(id, 0))).statusCode).toBe(409);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.consent_grants where organization_id=$1', [org])).rows[0].n).toBe(2);
  });
  it('refuses a designated different owner or different clinic through the actual handler and database', async () => {
    const id = await artifact(), handle = runtime();
    for (const request of [review(), grant(id), withdraw(0)]) {
      expect((await handle(request, other)).statusCode).toBe(403);
      expect((await handle(request, owner, foreign)).statusCode).toBe(403);
    }
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.consent_grants where organization_id=$1', [org])).rows[0].n).toBe(0);
  });
  it('checks actual deployed function privileges before the runtime can deliver approved copy', async () => {
    await artifact(); const handle = runtime();
    await pg.exec('grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to public');
    try {
      const response = await handle(review()); expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: 'service_unavailable' });
      expect(response.body).not.toContain(copy);
    } finally { await pg.exec('revoke execute on function clinical_core.production_telehealth_consent_request(jsonb) from public'); }
  });
  it('keeps status and withdrawal available through the real runtime after new grants are disabled and the connection is revoked', async () => {
    const id = await artifact(); expect((await runtime()(grant(id))).statusCode).toBe(200);
    await pg.query("update clinical_core.patient_connections set state='revoked',revoked_at=now(),revoke_reason_safe='patient_request',version=version+1 where id=$1", [connection]);
    const handle = runtime(false), read = await handle(review());
    expect(JSON.parse(read.body).data).toMatchObject({ artifact: null, status: 'granted', connectionState: 'revoked' });
    const revoked = await handle(withdraw(1)); expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.body).data).toMatchObject({ status: 'revoked', version: 2 });
    expect((await handle(grant(id, 2))).statusCode).toBe(403);
  });
  it('preserves every predecessor byte and creates no seeded approvals', () => {
    expect(parent.manifest.migrations).toHaveLength(111);
    expect(successor.manifest.migrations).toHaveLength(112);
    expect(successor.manifest.migrations.slice(0, 111)).toEqual(parent.manifest.migrations);
    for (const entry of parent.manifest.migrations) expect(successor.files[entry.file]).toBe(parent.files[entry.file]);
    expect(successor.candidate).toMatchObject({ activation: 'blocked', phiAllowed: false, deployment: 'not_deployed',
      seededApprovals: false, seededConsents: false, migrationCount: 112 });
    expect(successor.releaseHash).toBe(sha(successor.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(successor.files[m.file])).join('\n')));
    expect(() => execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--activate'], { stdio: 'pipe' })).toThrow();
  });
  it('discovers only the caller’s active clinic connection', async () => {
    expect(await call({ action: 'connection' })).toMatchObject({ connection: { connectionId: connection } });
    expect(await call({ action: 'connection' }, other)).toEqual({ connection: null });
    expect(await call({ action: 'connection' }, owner, foreign)).toEqual({ connection: null });
  });
  it('delivers the exact approved UTF-8 copy and current position without writing a grant', async () => {
    const id = await artifact();
    expect(await call(review())).toMatchObject({ status: 'not_granted', version: 0, currentArtifactId: null,
      artifact: { artifactId: id, content: copy, contentSha256: sha(copy) } });
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.consent_grants where organization_id=$1', [org])).rows[0].n).toBe(0);
  });
  it('grants exactly once, then withdraws with append-only audit and refuses a stale regrant', async () => {
    const id = await artifact();
    expect(await call(grant(id))).toMatchObject({ status: 'granted', artifactId: id, version: 1, alreadyApplied: false });
    expect(await call(grant(id))).toMatchObject({ status: 'granted', artifactId: id, version: 1, alreadyApplied: true });
    expect(await call(withdraw(1))).toMatchObject({ status: 'revoked', artifactId: null, version: 2, alreadyApplied: false });
    expect(await call(withdraw(1))).toMatchObject({ status: 'revoked', version: 2, alreadyApplied: true });
    await expect(call(grant(id, 0))).rejects.toThrow('conflict');
    await expect(call(withdraw(0))).rejects.toThrow('conflict');
    expect(await call(grant(id, 2))).toMatchObject({ status: 'granted', version: 3 });
    expect((await pg.query<{ n: number }>("select count(*)::int n from clinical_audit.events where organization_id=$1 and action in ('consent.granted','consent.revoked')", [org])).rows[0].n).toBe(3);
  });
  it.each(['owner', 'clinic'])('refuses cross-%s review, grant and withdrawal', async kind => {
    const id = await artifact();
    for (const request of [review(), grant(id), withdraw(0)]) await expect(call(request,
      kind === 'owner' ? other : owner, kind === 'clinic' ? foreign : org)).rejects.toThrow('identity_refused');
  });
  it('refuses workforce, unbound, disabled subject and mismatched subject contexts', async () => {
    await artifact();
    for (const c of [{ ...context(), identityPool: 'workforce' as const }, { ...context(), productionBound: false as const },
      { ...context(), identitySubject: 'wrong' }]) await expect(operations(c as ProductionClinicalRequestContext, review())).rejects.toThrow('identity_refused');
    await pg.query("update clinical_core.identities set status='disabled' where person_id=$1", [owner]);
    await expect(call(review())).rejects.toThrow('identity_refused');
  });
  it('never falls back to old wording when the newest release has no copy', async () => {
    const old = await artifact(); await artifact('NEW FICTIONAL COPY', false);
    expect(await call(review())).toMatchObject({ artifact: null });
    await expect(call(grant(old))).rejects.toThrow('consent_required');
  });
  it('refuses future approval and a no-longer-active reviewer', async () => {
    const old = await artifact(); await artifact('FUTURE FICTIONAL', false, "clock_timestamp()+interval '1 day'");
    expect(await call(review())).toMatchObject({ artifact: null });
    await expect(call(grant(old))).rejects.toThrow('consent_required');
    await pg.query("update clinical_core.consent_artifacts set status='retired' where organization_id=$1 and content_sha256=$2", [org, sha('FUTURE FICTIONAL')]);
    await pg.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, staff]);
    expect(await call(review())).toMatchObject({ artifact: null });
    await expect(call(grant(old))).rejects.toThrow('consent_required');
  });
  it('withdraws after release retirement and connection revocation without granting new processing', async () => {
    const id = await artifact(); await call(grant(id));
    await pg.query("update clinical_core.consent_artifacts set status='retired' where id=$1", [id]);
    await pg.query("update clinical_core.patient_connections set state='revoked',revoked_at=now(),revoke_reason_safe='patient_request',version=version+1 where id=$1", [connection]);
    expect(await call(review())).toMatchObject({ connectionState: 'revoked', artifact: null, status: 'granted' });
    expect(await call(withdraw(1))).toMatchObject({ status: 'revoked', version: 2 });
    await expect(call(grant(id, 2))).rejects.toThrow('identity_refused');
  });
  it('refuses a replaced artifact, wrong hash, paused link or archived chart', async () => {
    const id = await artifact();
    await expect(call(grant(id, 0, 'WRONG'))).rejects.toThrow('conflict');
    await artifact('NEW FICTIONAL');
    await expect(call(grant(id))).rejects.toThrow('conflict');
    await pg.query("update clinical_core.patient_connections set state='paused',paused_at=now(),version=version+1 where id=$1", [connection]);
    await expect(call(grant(id))).rejects.toThrow('identity_refused');
    await pg.query("update clinical_core.patient_connections set state='verified',paused_at=null,version=version+1 where id=$1", [connection]);
    await pg.query("update clinical_core.patient_records set status='archived' where id=$1", [patient]);
    await expect(call(grant(id))).rejects.toThrow('identity_refused');
  });
  it.each([
    ["grant execute on function clinical_core.production_telehealth_consent_request(jsonb) to public", "revoke execute on function clinical_core.production_telehealth_consent_request(jsonb) from public"],
    ["alter function clinical_core.production_telehealth_consent_request(jsonb) security invoker", "alter function clinical_core.production_telehealth_consent_request(jsonb) security definer"],
    ["alter function clinical_core.production_telehealth_consent_request(jsonb) set search_path=public", "alter function clinical_core.production_telehealth_consent_request(jsonb) set search_path=''"],
    ['grant select on clinical_core.care_consent_texts to clinical_core_api', 'revoke select on clinical_core.care_consent_texts from clinical_core_api'],
  ])('refuses weakened deployed metadata before content access: %s', async (change, restore) => {
    await pg.exec(change);
    try { await expect(call(review())).rejects.toThrow('service_unavailable'); }
    finally { await pg.exec(restore); }
  });
  it('refuses changed new-function bytes and overloads', async () => {
    const original = (await pg.query<{ definition: string }>("select pg_get_functiondef('clinical_core.production_telehealth_consent_request(jsonb)'::regprocedure) definition")).rows[0].definition;
    await pg.exec("create or replace function clinical_core.production_telehealth_consent_request(_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin return '{}'::jsonb; end$$");
    try { await expect(call(review())).rejects.toThrow('service_unavailable'); } finally { await pg.exec(original); }
    await pg.exec("create function clinical_core.production_telehealth_consent_request(integer) returns jsonb language plpgsql security definer set search_path='' as $$begin return '{}'::jsonb; end$$; revoke all on function clinical_core.production_telehealth_consent_request(integer) from public;");
    try { await expect(call(review())).rejects.toThrow('service_unavailable'); }
    finally { await pg.exec('drop function clinical_core.production_telehealth_consent_request(integer)'); }
  });
  it('refuses direct API table reads and preserves the historical care function scope set', async () => {
    await artifact();
    await expect(rawDatabase.transaction(tx => tx.query('select content from clinical_core.care_consent_texts'))).rejects.toThrow();
    await expect(rawDatabase.transaction(async tx => {
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [owner, org, 'consumer', 'fixture-' + owner, 'consent_management', 'production-clinical', 'clinical_phi']);
      return tx.query('select clinical_core.production_care_connection_request($1::jsonb)', [JSON.stringify(review())]);
    })).rejects.toThrow('care_connection_invalid');
  });
  it.each([null, [], { ...review(), ownerId: randomUUID() }, { ...review(), scope: 'messaging' },
    { ...withdraw(0), expectedVersion: '0' }, { ...withdraw(0), expectedVersion: 1.5 }, { action: 'issue', patientRecordId: randomUUID() }])(
    'refuses malformed or authority-injected input %j', async input => {
      await expect(operations(context(), input)).rejects.toThrow('request_invalid');
    });
  it('does not accept mismatched response ownership, skipped versions or fake grant acknowledgements', () => {
    const id = randomUUID();
    for (const result of [{ connectionId: other, scope: 'telehealth_recording', status: 'granted', artifactId: id, version: 1, alreadyApplied: false },
      { connectionId: connection, scope: 'telehealth_recording', status: 'granted', artifactId: id, version: 2, alreadyApplied: false },
      { connectionId: connection, scope: 'telehealth_recording', status: 'not_granted', artifactId: null, version: 0, alreadyApplied: true },
      { connectionId: connection, scope: 'telehealth_recording', status: 'granted', artifactId: randomUUID(), version: 1, alreadyApplied: false }])
      expect(() => parseTelehealthConsentResponse(grant(id), result)).toThrow();
  });
  it('refuses malformed direct SQL calls instead of relying only on the application parser', async () => {
    for (const input of [null, [], {}, { ...review(), scope: null }, { ...review(), scope: 'messaging' },
      { ...review(), connectionId: null }, { ...review(), ownerId: owner },
      { ...withdraw(0), expectedVersion: '0' }, { ...withdraw(0), expectedVersion: 0.5 },
      { ...grant(randomUUID()), artifactId: null }, { ...grant(randomUUID()), contentSha256: null }]) {
      await expect(rawDatabase.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [owner, org,
          'consumer', 'fixture-' + owner, 'consent_management', 'production-clinical', 'clinical_phi']);
        return tx.query('select clinical_core.production_telehealth_consent_request($1::jsonb)', [JSON.stringify(input)]);
      })).rejects.toThrow('request_invalid');
    }
  });
  it('refuses administrative execution and malformed content returned by a fictional transport', async () => {
    const sql = parent.files['20261006020000_production_care_connections.sql'];
    const functions = [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
    const newSql = successor.files[successor.manifest.migrations.at(-1)!.file];
    const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({
      query: (statement, parameters = []) => tx.query(statement, [...parameters]),
    })) };
    await expect(bindTelehealthConsentDatabase(admin, functions, sha(/as \$\$([^]*?)\$\$/.exec(newSql)![1]))
      .transaction(() => Promise.resolve(null))).rejects.toThrow('service_unavailable');
    const id = await artifact(), valid = await call(review());
    if (!('artifact' in valid) || !valid.artifact) throw Error('fixture_missing');
    for (const content of ['WRONG COPY', '\ud800', '\0', ' '.repeat(100)]) {
      const bad: ClinicalCoreDatabase = { transaction: work => work({ query: async statement => ({ rows: statement.startsWith('select clinical_core.')
        ? [{ data: { ...valid, artifact: { ...valid.artifact, artifactId: id, content } } }] : [] }) } as ClinicalCoreTransaction) };
      await expect(createProductionTelehealthConsent(bad)(context(), review())).rejects.toThrow('service_unavailable');
    }
  });
});
