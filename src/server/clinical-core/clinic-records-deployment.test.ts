import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { bindClinicRecordsDatabase, createClinicRecordsHandler, type ClinicRecordsBuild } from './clinic-records-deployment';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';

/**
 * The artifact-bound clinic-records runtime: blocked by default, refuses a
 * mismatched source, ledger, candidate hash, account, region or database before
 * constructing a client, requires every independent review, and checks the
 * deployed dispatcher and ledgers in the REAL 116 artifact under the API role.
 * Fictional build and review values only; no AWS call, registration or activation.
 */
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>; candidate: Record<string, unknown> };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sourceCommit = '1'.repeat(40), review = '2'.repeat(64), now = 1800000000000;
const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
let artifact: Artifact, build: ClinicRecordsBuild, pg: PGlite;
beforeAll(async () => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 }));
  const sql = artifact.files[artifact.manifest.migrations[115].file];
  const body = /create function clinical_core\.clinic_record_request\(_request jsonb\) returns jsonb\nlanguage plpgsql security definer set search_path='' as \$\$([^]*?)\$\$;/.exec(sql)![1];
  build = { sourceCommit, sourceClean: true, migrationCount: 116, migrationReleaseSha256: artifact.candidate.migrationReleaseSha256 as string,
    extensionSha256: artifact.candidate.extensionSha256 as string, dispatcher: { schema: 'clinical_core', name: 'clinic_record_request', sha256: sha(body) } };
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(entry => ({ version: entry.version, name: entry.file.slice(15, -4), sql: artifact.files[entry.file], sha256: sha(artifact.files[entry.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (q, parameters = []) => tx.query(q, [...parameters]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  for (const entry of migrations.slice(106)) {
    await pg.exec(entry.sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
}, 120000);
afterAll(async () => { await pg?.close(); });
const env = () => ({ SOURCE_COMMIT: sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256, CLINIC_RECORDS_EXTENSION_SHA256: build.extensionSha256, AWS_REGION: 'us-east-2',
  CLINIC_RECORDS_ACTIVATION: 'blocked', PHI_ALLOWED: 'false', DEPLOYMENT_ACCOUNT_ID: '588966314750',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
  WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26), CLINIC_RECORDS_ORGANIZATION_ID: org,
  DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, DISCLOSURE_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001,fictional-workforce-00001',
});
const event = (pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event => ({
  routeKey: `POST /clinical-core/${pool}/clinic-records`, headers: { 'content-type': 'application/json' }, body: pool === 'consumer' ? '{"action":"overview"}' : '{"action":"queue","limit":10}',
  requestContext: { authorizer: { jwt: { claims: { iss: env()[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
    aud: env()[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: `fictional-${pool}-00001`,
    'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true', token_use: 'id',
    iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } },
});
function transport(valid = true) {
  const query = vi.fn(async (q: string) => q.startsWith('with checked_function') ? { rows: [{ valid }] }
    : q.includes('clinic_record_request(') ? { rows: [{ data: { action: 'overview', connection: null, sections: [], requests: [] } }] } : { rows: [] });
  const database: ClinicalCoreDatabase = { transaction: work => work({ query } as unknown as ClinicalCoreTransaction) };
  return { query, factory: vi.fn(() => database) };
}
describe('artifact-bound clinic-records runtime', () => {
  it('is blocked by default without constructing a database client', async () => {
    const t = transport();
    expect(await createClinicRecordsHandler({ ...env(), QUALIFICATION_EXECUTION: 'disabled' }, build, t.factory, () => now)(event())).toMatchObject({ statusCode: 503, body: '{"error":"production_not_activated","phiAllowed":false}' });
    expect(t.factory).not.toHaveBeenCalled();
  });
  it('refuses a wrong source, ledger, candidate hash, region, account, database, dirty serving build or malformed build before any client', async () => {
    for (const changed of [{ SOURCE_COMMIT: '3'.repeat(40) }, { MIGRATION_RELEASE_SHA256: '4'.repeat(64) }, { CLINIC_RECORDS_EXTENSION_SHA256: '5'.repeat(64) },
      { AWS_REGION: 'us-west-2' }, { DEPLOYMENT_ACCOUNT_ID: '173535830222' }, { CLINICAL_DATABASE_NAME: 'clinical_core' }, { QUALIFICATION_ACCOUNT_ID: '123456789012' },
      { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:wrong' }, { CLINIC_RECORDS_ACTIVATION: 'approved', PHI_ALLOWED: 'true' }]) {
      const t = transport(); expect(await createClinicRecordsHandler({ ...env(), ...changed }, build, t.factory)(event())).toMatchObject({ statusCode: 503 }); expect(t.factory).not.toHaveBeenCalled();
    }
    for (const bad of [{ ...build, sourceClean: false }, { ...build, migrationCount: 115 as unknown as 116 }, { ...build, dispatcher: { ...build.dispatcher, sha256: 'zz' } }]) {
      const t = transport(); expect(await createClinicRecordsHandler(env(), bad, t.factory)(event())).toMatchObject({ statusCode: 503 }); expect(t.factory).not.toHaveBeenCalled();
    }
  });
  it('requires every independent review (database, MFA, disclosure, retention) and distinct pools before construction', async () => {
    for (const key of ['DATABASE_REVIEW_SHA256', 'WORKFORCE_MFA_REVIEW_SHA256', 'DISCLOSURE_REVIEW_SHA256', 'RETENTION_REVIEW_SHA256'] as const) {
      const t = transport(); expect(await createClinicRecordsHandler({ ...env(), [key]: '' }, build, t.factory)(event())).toMatchObject({ statusCode: 503 }); expect(t.factory).not.toHaveBeenCalled();
    }
    const t = transport(); expect(await createClinicRecordsHandler({ ...env(), CONSUMER_AUDIENCE: env().WORKFORCE_AUDIENCE }, build, t.factory)(event())).toMatchObject({ statusCode: 503 });
  });
  it('serves a designated qualification identity through the bound database, checks the dispatcher before business SQL, and answers 503 when the check fails', async () => {
    const good = transport();
    const handler = createClinicRecordsHandler(env(), build, good.factory, () => now);
    expect(await handler(event())).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    expect(good.query.mock.calls[0][0]).toMatch(/^with checked_function/); expect(good.query.mock.calls.some(c => String(c[0]).includes('clinic_record_request('))).toBe(true);
    expect(good.factory).toHaveBeenCalledTimes(1);
    const foreign = event(); foreign.requestContext!.authorizer!.jwt!.claims!.sub = 'consumer-not-designated';
    expect(await handler(foreign)).toMatchObject({ statusCode: 503 });
    const bad = transport(false);
    expect(await createClinicRecordsHandler(env(), build, bad.factory, () => now)(event())).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' });
    expect(bad.query.mock.calls.some(c => String(c[0]).includes('clinic_record_request('))).toBe(false);
  });
  it('the dispatcher and ledger check holds against the real 116 artifact under clinical_core_api, and refuses a different dispatcher hash', async () => {
    const api: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => { await tx.exec('set local role clinical_core_api'); return work({ query: (q, parameters = []) => tx.query(q, [...parameters]) }); }) };
    await expect(bindClinicRecordsDatabase(api, build).transaction(async () => 'reached')).resolves.toBe('reached');
    await expect(bindClinicRecordsDatabase(api, { dispatcher: { ...build.dispatcher, sha256: '9'.repeat(64) } }).transaction(async () => 'reached')).rejects.toThrow('service_unavailable');
    // An administrative connection is never the serving principal.
    const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (q, parameters = []) => tx.query(q, [...parameters]) })) };
    await expect(bindClinicRecordsDatabase(admin, build).transaction(async () => 'reached')).rejects.toThrow('service_unavailable');
    expect(randomUUID()).toMatch(/-4/);
  });
});
