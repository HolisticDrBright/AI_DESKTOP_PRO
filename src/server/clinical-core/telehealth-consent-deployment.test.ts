import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { createTelehealthConsentHandler, telehealthConsentConfigurationSha256,
  type TelehealthConsentBuild } from './telehealth-consent-deployment';
// Fictional configuration, never activation or review evidence for AWS.
let build: TelehealthConsentBuild;
const review = '2'.repeat(64), org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
const connectionId = '33333333-3333-4333-8333-333333333333', artifactId = '44444444-4444-4444-8444-444444444444';
const now = 1800000000000, sha = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(() => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
  build = { sourceCommit: '1'.repeat(40), sourceClean: true, sourceInputSha256: '3'.repeat(64), migrationCount: 112,
    migrationReleaseSha256: a.candidate.migrationReleaseSha256, assemblySha256: a.releaseHash, sqlSha256: a.candidate.extensionSha256,
    functions: [...a.files['20261006020000_production_care_connections.sql'].matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') })),
    telehealthFunctionSha256: sha(/as \$\$([^]*?)\$\$/.exec(a.files['20261010100000_production_telehealth_consent_copy.sql'])![1]) };
});
const environment = () => ({ SOURCE_COMMIT: build.sourceCommit, SOURCE_INPUT_SHA256: build.sourceInputSha256,
  MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256, AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750',
  TELEHEALTH_CONSENT_ACTIVATION: 'blocked', PHI_ALLOWED: 'false', TELEHEALTH_CONSENT_ENABLED: 'true', TELEHEALTH_CONSENT_ORGANIZATION_ID: org,
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
  WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
  DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, CONNECTION_REVIEW_SHA256: review,
  CONSENT_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review, QUALIFICATION_EXECUTION: 'enabled',
  QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001',
});
const signed = (e: Record<string, string | undefined>): Record<string, string | undefined> =>
  ({ ...e, TELEHEALTH_CONSENT_CONFIGURATION_SHA256: telehealthConsentConfigurationSha256(e) });
const event = (body: unknown = { action: 'connection' }): ApiGatewayV2Event => ({
  routeKey: 'POST /clinical-core/consumer/telehealth-consent', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: { iss: environment().CONSUMER_ISSUER, aud: environment().CONSUMER_AUDIENCE,
    sub: 'fictional-consumer-00001', token_use: 'id', 'custom:person_id': person, 'custom:organization_id': org,
    'custom:production_bound': 'true', email_verified: true, iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } },
});
function transport(copyValid = true, functionValid = true, data: unknown = { connection: null }) {
  const query = vi.fn(async (sql: string) => sql.startsWith('with expected') ? { rows: [{ valid: copyValid }] }
    : sql.startsWith('select count(*)=1') ? { rows: [{ valid: functionValid }] }
    : sql.startsWith('select clinical_core.production_telehealth') ? { rows: [{ data }] } : { rows: [] });
  const db: ClinicalCoreDatabase = { transaction: work => work({ query } as unknown as ClinicalCoreTransaction) };
  return { query, factory: vi.fn(() => db) };
}
describe('separate artifact-bound 112 patient consent runtime', () => {
  it('is default blocked without constructing a database or claiming qualification', async () => {
    const t = transport(), r = await createTelehealthConsentHandler({ ...environment(), QUALIFICATION_EXECUTION: 'disabled' }, build, t.factory)(event());
    expect(r.statusCode).toBe(503); expect(r.headers).not.toHaveProperty('x-clinical-execution'); expect(t.factory).not.toHaveBeenCalled();
  });
  it.each([
    ['SOURCE_COMMIT', '4'.repeat(40)], ['SOURCE_INPUT_SHA256', '4'.repeat(64)], ['MIGRATION_RELEASE_SHA256', '4'.repeat(64)],
    ['AWS_REGION', 'us-west-2'], ['DEPLOYMENT_ACCOUNT_ID', '173535830222'], ['CLINICAL_DATABASE_NAME', 'clinical_core'],
    ['CLINICAL_DATABASE_NAME', 'another_qualification'], ['QUALIFICATION_ACCOUNT_ID', '123456789012'],
    ['CLINICAL_DATABASE_CLUSTER_ARN', 'arn:aws:rds:us-east-2:173535830222:cluster:other'],
    ['CLINICAL_DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-2:173535830222:secret:other'],
    ['TELEHEALTH_CONSENT_ACTIVATION', 'yes'], ['PHI_ALLOWED', 'true'], ['TELEHEALTH_CONSENT_ENABLED', 'TRUE'],
    ['CONSUMER_ISSUER', 'https://example.test'], ['WORKFORCE_ISSUER', 'https://example.test'],
  ])('refuses %s substitution before client construction', async (key, value) => {
    const t = transport(), r = await createTelehealthConsentHandler(signed({ ...environment(), [key]: value }), build, t.factory)(event());
    expect(r.statusCode).toBe(503); expect(r.headers).not.toHaveProperty('x-clinical-execution'); expect(t.factory).not.toHaveBeenCalled();
  });
  it.each(['DATABASE_REVIEW_SHA256', 'WORKFORCE_MFA_REVIEW_SHA256', 'CONNECTION_REVIEW_SHA256', 'CONSENT_REVIEW_SHA256',
    'RETENTION_REVIEW_SHA256', 'QUALIFICATION_REVIEW_SHA256'])('does not replace missing %s with its configuration digest', async key => {
    const t = transport(); expect((await createTelehealthConsentHandler(signed({ ...environment(), [key]: '' }), build, t.factory)(event())).statusCode).toBe(503);
    expect(t.factory).not.toHaveBeenCalled();
  });
  it('captures compiled source/configuration and verifies both sets of SQL metadata every transaction', async () => {
    const e = signed(environment()), b = structuredClone(build), t = transport();
    const handle = createTelehealthConsentHandler(e, b, t.factory, () => now);
    e.CLINICAL_DATABASE_NAME = 'clinical_core'; b.functions = []; b.telehealthFunctionSha256 = 'changed';
    expect(await handle(event())).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    expect((await handle(event())).statusCode).toBe(200); expect(t.factory).toHaveBeenCalledOnce();
    expect(t.query.mock.calls.filter(([sql]) => sql.startsWith('with expected'))).toHaveLength(2);
    expect(t.query.mock.calls.filter(([sql]) => sql.startsWith('select count(*)=1'))).toHaveLength(2);
    expect(t.factory).toHaveBeenCalledWith(expect.objectContaining({ databaseName: 'clinical_core_qualification' }));
  });
  it.each([[false, true], [true, false]])('refuses copy=%s/function=%s drift before consent work', async (copy, fn) => {
    const t = transport(copy, fn); expect((await createTelehealthConsentHandler(signed(environment()), build, t.factory, () => now)(event())).statusCode).toBe(503);
    expect(t.query.mock.calls.some(([sql]) => sql.startsWith('select clinical_core.production_telehealth'))).toBe(false);
  });
  it('refuses dirty, wrong-generation, malformed or missing compiled metadata', async () => {
    for (const b of [{ ...build, sourceClean: false }, { ...build, migrationCount: 106 }, { ...build, assemblySha256: review },
      { ...build, sqlSha256: review }, { ...build, functions: build.functions.slice(1) }, { ...build, telehealthFunctionSha256: '' }]) {
      const t = transport(); expect((await createTelehealthConsentHandler(signed(environment()), b as TelehealthConsentBuild, t.factory)(event())).statusCode).toBe(503);
      expect(t.factory).not.toHaveBeenCalled();
    }
  });
  it('refuses stale configuration identities even when every review is present', async () => {
    const e = signed(environment()); e.CONSENT_REVIEW_SHA256 = '5'.repeat(64); const t = transport();
    expect((await createTelehealthConsentHandler(e, build, t.factory)(event())).statusCode).toBe(503); expect(t.factory).not.toHaveBeenCalled();
  });
  it('refuses wrong pool, clinic, route, malformed and non-designated identities before database work', async () => {
    const t = transport(), handle = createTelehealthConsentHandler(signed(environment()), build, t.factory, () => now);
    const cross = event(); cross.requestContext!.authorizer!.jwt!.claims!['custom:organization_id'] = person;
    expect((await handle(cross)).statusCode).toBe(403);
    const workforce = event(); workforce.requestContext!.authorizer!.jwt!.claims!.iss = environment().WORKFORCE_ISSUER;
    expect((await handle(workforce)).statusCode).toBe(401);
    const other = event(); other.requestContext!.authorizer!.jwt!.claims!.sub = 'not-designated-owner';
    expect((await handle(other)).statusCode).toBe(503);
    expect((await handle({ ...event(), routeKey: 'POST /clinical-core/consumer/connection' })).statusCode).toBe(404);
    expect((await handle({ ...event(), body: '{}' })).statusCode).toBe(400); expect(t.factory).not.toHaveBeenCalled();
  });
  it('keeps grants independently disabled, but current-state reads and withdrawal survive', async () => {
    const grant = event({ action: 'grant', connectionId, scope: 'telehealth_recording', artifactId, contentSha256: review, expectedVersion: 0 });
    const t = transport(), e = signed({ ...environment(), TELEHEALTH_CONSENT_ENABLED: 'false' });
    expect((await createTelehealthConsentHandler(e, build, t.factory, () => now)(grant)).statusCode).toBe(403); expect(t.factory).not.toHaveBeenCalled();
    expect((await createTelehealthConsentHandler(e, build, t.factory, () => now)(event())).statusCode).toBe(200);
    const w = transport(true, true, { connectionId, scope: 'telehealth_recording', status: 'revoked', artifactId: null, version: 2, alreadyApplied: false });
    const withdrawal = event({ action: 'withdraw', connectionId, scope: 'telehealth_recording', expectedVersion: 1 });
    withdrawal.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect((await createTelehealthConsentHandler(e, build, w.factory, () => now)(withdrawal)).statusCode).toBe(200);
  });
  it('keeps qualification separate from independently approved production', async () => {
    const e = signed({ ...environment(), QUALIFICATION_EXECUTION: 'disabled', PHI_ALLOWED: 'true', TELEHEALTH_CONSENT_ACTIVATION: 'approved',
      TELEHEALTH_CONSENT_EVIDENCE_SHA256: review, DEPLOYMENT_ACCOUNT_ID: '173535830222', CLINICAL_DATABASE_NAME: 'clinical_core',
      CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:173535830222:cluster:fictional',
      CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional-AbCd12' });
    const t = transport(), r = await createTelehealthConsentHandler(e, build, t.factory, () => now)(event());
    expect(r.statusCode).toBe(200); expect(r.headers).not.toHaveProperty('x-clinical-execution');
    const refused = transport(); expect((await createTelehealthConsentHandler(signed({ ...e, TELEHEALTH_CONSENT_EVIDENCE_SHA256: '' }), build, refused.factory)(event())).statusCode).toBe(503);
    expect(refused.factory).not.toHaveBeenCalled();
  });
});
