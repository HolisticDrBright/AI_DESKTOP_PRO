import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { createCareConnectionsHandler, type CareConnectionsBuild } from './care-connections-deployment';
import { CARE_CLAIM_RECOVERY_ROUTE } from './care-claim-recovery-api';

// Fictional placeholders only. No review or approval is created by this suite.
const sourceCommit = '1'.repeat(40), review = '2'.repeat(64), now = 1800000000000;
const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
let build: CareConnectionsBuild;
beforeAll(() => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000,
  }));
  const sql: string = artifact.files['20261006020000_production_care_connections.sql'];
  build = { sourceCommit, sourceClean: true, migrationCount: 106,
    migrationReleaseSha256: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
    functions: [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: createHash('sha256').update(body).digest('hex'), apiExecute: name.startsWith('clinical_core.') })),
    claimFunctions: [...artifact.files['20261006030000_production_care_claim_recovery.sql'].matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
      .map(([, name, body]) => ({ name, bodySha256: createHash('sha256').update(body).digest('hex'), apiExecute: name.startsWith('clinical_core.') })) };
});
const env = (): Record<string, string | undefined> => ({ SOURCE_COMMIT: sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256,
  AWS_REGION: 'us-east-2', CARE_CONNECTIONS_ACTIVATION: 'blocked', PHI_ALLOWED: 'false', DEPLOYMENT_ACCOUNT_ID: '588966314750',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
  WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
  CARE_CONNECTIONS_ORGANIZATION_ID: org, DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review,
  CONNECTION_REVIEW_SHA256: review, CONSENT_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review, ENABLED_CONSENT_SCOPES: 'messaging',
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
  QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001,fictional-workforce-00001',
});
const event = (body: unknown = { action: 'connection' }, pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event => ({
  routeKey: `POST /clinical-core/${pool}/connection`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: { iss: env()[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
    aud: env()[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: `fictional-${pool}-00001`, token_use: 'id',
    'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: true,
    iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } },
});
function transport(valid = true, response: unknown = { connection: null }) {
  const query = vi.fn(async (sql: string, args: readonly unknown[] = []) => {
    void args;
    return sql.startsWith('with expected') ? { rows: [{ valid }] }
      : /production_care_(?:connection|claim)_request/.test(sql) ? { rows: [{ data: response }] } : { rows: [] };
  });
  const database: ClinicalCoreDatabase = { transaction: work => work({ query } as unknown as ClinicalCoreTransaction) };
  const factory = vi.fn(() => database);
  return { query, factory };
}
describe('artifact-bound connection runtime', () => {
  it('does not construct a data client in default blocked mode', async () => {
    const t = transport(); const handle = createCareConnectionsHandler({ ...env(), QUALIFICATION_EXECUTION: 'disabled' }, build, t.factory, () => now);
    expect(await handle(event())).toMatchObject({ statusCode: 503, body: '{"error":"production_not_activated","phiAllowed":false}' });
    expect(t.factory).not.toHaveBeenCalled();
  });
  it.each([
    ['SOURCE_COMMIT', '3'.repeat(40)], ['MIGRATION_RELEASE_SHA256', '4'.repeat(64)], ['AWS_REGION', 'us-west-2'],
    ['DEPLOYMENT_ACCOUNT_ID', '173535830222'], ['CLINICAL_DATABASE_NAME', 'clinical_core'], ['CLINICAL_DATABASE_NAME', 'other_qualification'],
    ['QUALIFICATION_ACCOUNT_ID', '123456789012'], ['CLINICAL_DATABASE_CLUSTER_ARN', 'arn:aws:rds:us-east-2:173535830222:cluster:wrong'],
    ['CLINICAL_DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:us-east-2:173535830222:secret:wrong'],
    ['CARE_CONNECTIONS_ACTIVATION', 'yes'], ['PHI_ALLOWED', 'true'], ['ENABLED_CONSENT_SCOPES', 'messaging,messaging'],
    ['ENABLED_CONSENT_SCOPES', 'messaging, invented'], ['CONSUMER_ISSUER', 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Wrong'],
  ])('refuses mismatched %s before client construction', async (key, value) => {
    const t = transport(); const reply = await createCareConnectionsHandler({ ...env(), [key]: value }, build, t.factory, () => now)(event());
    expect(reply.statusCode).toBe(503); expect(reply.headers).not.toHaveProperty('x-clinical-execution'); expect(t.factory).not.toHaveBeenCalled();
  });
  it.each(['DATABASE_REVIEW_SHA256', 'WORKFORCE_MFA_REVIEW_SHA256', 'CONNECTION_REVIEW_SHA256', 'CONSENT_REVIEW_SHA256',
    'RETENTION_REVIEW_SHA256', 'QUALIFICATION_REVIEW_SHA256'])('requires independent %s', async key => {
    const t = transport(); expect((await createCareConnectionsHandler({ ...env(), [key]: '' }, build, t.factory)(event())).statusCode).toBe(503);
    expect(t.factory).not.toHaveBeenCalled();
  });
  it('validates all compiled functions and clean serving source before creating a client', async () => {
    for (const invalid of [{ ...build, sourceClean: false }, { ...build, functions: build.functions.slice(1) },
      { ...build, functions: build.functions.map((f, i) => i ? f : { ...f, apiExecute: true }) },
      { ...build, functions: build.functions.map((f, i) => i ? f : { ...f, bodySha256: '' }) }]) {
      const t = transport(); expect((await createCareConnectionsHandler(env(), invalid, t.factory)(event())).statusCode).toBe(503);
      expect(t.factory).not.toHaveBeenCalled();
    }
  });
  it('freezes both environment and compiled metadata before lazy client creation', async () => {
    const e = env(), b = structuredClone(build), t = transport(); const handle = createCareConnectionsHandler(e, b, t.factory, () => now);
    e.CLINICAL_DATABASE_NAME = 'clinical_core'; e.CLINICAL_DATABASE_SECRET_ARN = 'changed'; e.ENABLED_CONSENT_SCOPES = 'invented';
    b.functions[0].bodySha256 = 'changed'; b.functions = [];
    expect(await handle(event())).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    expect(t.factory).toHaveBeenCalledWith(expect.objectContaining({ databaseName: 'clinical_core_qualification', secretArn: env().CLINICAL_DATABASE_SECRET_ARN }));
    expect(t.query.mock.calls[0][0]).toContain('with expected');
  });
  it('rechecks deployed metadata before every business transaction even with a cached client', async () => {
    const t = transport(); const handle = createCareConnectionsHandler(env(), build, t.factory, () => now);
    expect((await handle(event())).statusCode).toBe(200); expect((await handle(event())).statusCode).toBe(200);
    expect(t.factory).toHaveBeenCalledOnce(); expect(t.query.mock.calls.filter(([sql]) => sql.startsWith('with expected'))).toHaveLength(2);
    const drift = transport(false); expect((await createCareConnectionsHandler(env(), build, drift.factory, () => now)(event())).statusCode).toBe(503);
    expect(drift.query).toHaveBeenCalledOnce();
  });
  it('never constructs a client for missing, substituted, stale or un-designated gateway identities', async () => {
    const t = transport(), handle = createCareConnectionsHandler(env(), build, t.factory, () => now);
    const missing = event(); missing.requestContext = undefined;
    expect((await handle(missing)).statusCode).toBe(401);
    const other = event(); other.requestContext!.authorizer!.jwt!.claims!.sub = 'not-designated-fixture';
    expect((await handle(other)).statusCode).toBe(503);
    const cross = event(); cross.requestContext!.authorizer!.jwt!.claims!['custom:organization_id'] = person;
    expect((await handle(cross)).statusCode).toBe(403);
    const stale = event({ action: 'claim', token: 'ABCD-EFGH-JKLMN' }); stale.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect((await handle(stale)).statusCode).toBe(401); expect(t.factory).not.toHaveBeenCalled();
  });
  it('keeps grants off by default without removing status and withdrawal', async () => {
    const t = transport(), handle = createCareConnectionsHandler({ ...env(), ENABLED_CONSENT_SCOPES: undefined }, build, t.factory, () => now);
    expect((await handle(event({ action: 'grant', connectionId: connection, scope: 'messaging', artifactId: person, contentSha256: review, expectedVersion: 0 }))).statusCode).toBe(403);
    expect(t.factory).not.toHaveBeenCalled(); expect((await handle(event())).statusCode).toBe(200);
    const withdrawing = transport(true, { connectionId: connection, scope: 'messaging', status: 'revoked', version: 2, alreadyApplied: false });
    const stale = event({ action: 'withdraw', connectionId: connection, scope: 'messaging', expectedVersion: 1 });
    stale.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect((await createCareConnectionsHandler({ ...env(), ENABLED_CONSENT_SCOPES: '' }, build, withdrawing.factory, () => now)(stale)).statusCode).toBe(200);
  });
  it('uses independent workforce identity only for invitation issuance', async () => {
    const t = transport(true, { ok: true, message: 'Invitation created', connectionId: connection, invitationId: person,
      token: 'ABCDEFGHJKLMN', expiresAt: '2027-01-01T00:00:00Z', state: 'invitation_pending', version: 1 });
    expect((await createCareConnectionsHandler(env(), build, t.factory, () => now)(event({ action: 'issue', patientRecordId: person }, 'workforce'))).statusCode).toBe(200);
    expect(t.query.mock.calls.some(([sql]) => sql.includes('set_request_context'))).toBe(true);
  });
  it('keeps qualification separate from production and requires all production reviews', async () => {
    const production = { ...env(), QUALIFICATION_EXECUTION: 'disabled', PHI_ALLOWED: 'true', CARE_CONNECTIONS_ACTIVATION: 'approved',
      CARE_CONNECTIONS_EVIDENCE_SHA256: review, DEPLOYMENT_ACCOUNT_ID: '173535830222', CLINICAL_DATABASE_NAME: 'clinical_core',
      CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:173535830222:cluster:fictional',
      CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional-AbCd12' };
    const t = transport(); const response = await createCareConnectionsHandler(production, build, t.factory, () => now)(event());
    expect(response.statusCode).toBe(200); expect(response.headers).not.toHaveProperty('x-clinical-execution');
    for (const changed of [{ CARE_CONNECTIONS_EVIDENCE_SHA256: '' }, { RETENTION_REVIEW_SHA256: '' }, { CONSENT_REVIEW_SHA256: '' },
      { WORKFORCE_MFA_REVIEW_SHA256: '' }, { DEPLOYMENT_ACCOUNT_ID: '588966314750' }, { CLINICAL_DATABASE_NAME: 'clinical_core_qualification' }]) {
      const denied = transport(); expect((await createCareConnectionsHandler({ ...production, ...changed }, build, denied.factory)(event())).statusCode).toBe(503);
      expect(denied.factory).not.toHaveBeenCalled();
    }
  });
  it.each([undefined, '', 'false', 'yes', 'TRUE'])('keeps recovery disabled for opt-in %s without breaking connections', async enabled => {
    const t = transport(), handle = createCareConnectionsHandler({ ...env(), CARE_CLAIM_RECOVERY_ENABLED: enabled }, build, t.factory, () => now);
    const response = await handle({ ...event({ action: 'receipt', requestId: person }), routeKey: CARE_CLAIM_RECOVERY_ROUTE });
    expect(response.statusCode).toBe(503); expect(response.headers).not.toHaveProperty('x-clinical-execution');
    expect(t.factory).not.toHaveBeenCalled(); expect((await handle(event())).statusCode).toBe(200);
  });
  it.each([undefined, '', 'not-a-review'])('refuses an enabled recovery route without independent review %s', async reviewHash => {
    const t = transport(), handle = createCareConnectionsHandler({ ...env(), CARE_CLAIM_RECOVERY_ENABLED: 'true',
      CARE_CLAIM_RECOVERY_REVIEW_SHA256: reviewHash }, build, t.factory, () => now);
    expect((await handle({ ...event({ action: 'receipt', requestId: person }), routeKey: CARE_CLAIM_RECOVERY_ROUTE })).statusCode).toBe(503);
    expect(t.factory).not.toHaveBeenCalled(); expect((await handle(event())).statusCode).toBe(200);
  });
  it('binds recovery to both compiled contracts, captures its review and rechecks every transaction', async () => {
    const t = transport(true, { requestId: person, status: 'unresolved' }), e = { ...env(), CARE_CLAIM_RECOVERY_ENABLED: 'true',
      CARE_CLAIM_RECOVERY_REVIEW_SHA256: review }, b = structuredClone(build);
    const handle = createCareConnectionsHandler(e, b, t.factory, () => now);
    e.CARE_CLAIM_RECOVERY_ENABLED = 'false'; e.CARE_CLAIM_RECOVERY_REVIEW_SHA256 = ''; b.claimFunctions[0].bodySha256 = 'changed';
    const request = { ...event({ action: 'receipt', requestId: person }), routeKey: CARE_CLAIM_RECOVERY_ROUTE };
    for (let i = 0; i < 2; i++) expect(await handle(request)).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' },
      body: JSON.stringify({ data: { requestId: person, status: 'unresolved' } }) });
    expect(t.factory).toHaveBeenCalledOnce(); expect(t.query.mock.calls.filter(([sql]) => sql.startsWith('with expected'))).toHaveLength(4);
    const expected = t.query.mock.calls.filter(([sql]) => sql.startsWith('with expected')).map(([, pins]) => JSON.parse((pins as string[])[0]));
    expect(expected.map(v => v.length)).toEqual([7, 2, 7, 2]);
  });
  it('refuses drift in the recovery SQL before context setup or claim execution', async () => {
    const t = transport(); t.query.mockImplementation(async (sql: string) => ({ rows: [{ valid: !sql.includes('care_claim_requests') }] }));
    const handle = createCareConnectionsHandler({ ...env(), CARE_CLAIM_RECOVERY_ENABLED: 'true', CARE_CLAIM_RECOVERY_REVIEW_SHA256: review }, build, t.factory, () => now);
    expect((await handle({ ...event({ action: 'receipt', requestId: person }), routeKey: CARE_CLAIM_RECOVERY_ROUTE })).statusCode).toBe(503);
    expect(t.query).toHaveBeenCalledTimes(2); expect(t.query.mock.calls.some(([sql]) => sql.includes('set_request_context'))).toBe(false);
  });
  it('refuses malformed compiled recovery pins before any data client', async () => {
    for (const pins of [[], build.claimFunctions.slice(1), build.claimFunctions.map(f => ({ ...f, bodySha256: '' })),
      build.claimFunctions.map(f => ({ ...f, apiExecute: !f.apiExecute }))]) {
      const t = transport(); const handle = createCareConnectionsHandler(env(), { ...build, claimFunctions: pins }, t.factory, () => now);
      expect((await handle(event())).statusCode).toBe(503); expect(t.factory).not.toHaveBeenCalled();
    }
  });
});
