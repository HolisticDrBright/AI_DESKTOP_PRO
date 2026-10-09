import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { createCareMessagingHandler, bindCareMessagingDatabase, type CareMessagingBuild } from './care-messaging-deployment';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';

const sourceCommit = '1'.repeat(40), review = '2'.repeat(64), now = 1800000000000;
const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
let build: CareMessagingBuild;
beforeAll(() => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }));
  const sql: string = artifact.files['20261006010000_production_care_messaging.sql'];
  // Fictional build/review values for local tests only, never deployment reviews.
  build = { sourceCommit, sourceClean: true, migrationCount: 106, migrationReleaseSha256: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
    functions: [...sql.matchAll(/create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
      .map(([, schema, name, body]) => ({ schema, name, sha256: createHash('sha256').update(body).digest('hex'), callable: schema === 'clinical_core' })) };
});
const env = () => ({ SOURCE_COMMIT: sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256, AWS_REGION: 'us-east-2',
  CARE_MESSAGING_ACTIVATION: 'blocked', PHI_ALLOWED: 'false', DEPLOYMENT_ACCOUNT_ID: '588966314750',
  CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
  WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26), CARE_MESSAGING_ORGANIZATION_ID: org,
  DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, MESSAGING_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750', QUALIFICATION_IDENTITY_SUBJECTS: 'fictional-consumer-00001,fictional-workforce-00001',
});
const event = (pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event => ({
  routeKey: `POST /clinical-core/${pool}/messages`, headers: { 'content-type': 'application/json' }, body: '{"action":"list"}',
  requestContext: { authorizer: { jwt: { claims: { iss: env()[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
    aud: env()[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: `fictional-${pool}-00001`,
    'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true', token_use: 'id',
    iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } },
});
function transport(valid = true) {
  const query = vi.fn(async (sql: string) => sql.startsWith('with expected') ? { rows: [{ valid }] } : sql.includes('production_care_message_request')
    ? { rows: [{ data: { action: 'list', threads: [], nextBefore: null } }] } : { rows: [] });
  const database: ClinicalCoreDatabase = { transaction: work => work({ query } as unknown as ClinicalCoreTransaction) };
  const factory = vi.fn(() => database);
  return { query, factory };
}
describe('artifact-bound messaging runtime', () => {
  it('is blocked by default without constructing a database client', async () => {
    const test = transport(); const config = { ...env(), QUALIFICATION_EXECUTION: 'disabled' };
    expect(await createCareMessagingHandler(config, build, test.factory, () => now)(event())).toMatchObject({ statusCode: 503, body: '{"error":"production_not_activated","phiAllowed":false}' });
    expect(test.factory).not.toHaveBeenCalled();
  });
  it('refuses wrong source/release, dirty serving builds and cross-account/region/plane bindings before client construction', async () => {
    const changes = [ { SOURCE_COMMIT: '3'.repeat(40) }, { MIGRATION_RELEASE_SHA256: '4'.repeat(64) }, { AWS_REGION: 'us-west-2' },
      { DEPLOYMENT_ACCOUNT_ID: '173535830222' }, { CLINICAL_DATABASE_NAME: 'clinical_core' }, { QUALIFICATION_ACCOUNT_ID: '123456789012' },
      { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:wrong' },
      { CARE_MESSAGING_ACTIVATION: 'approved', PHI_ALLOWED: 'true' } ];
    for (const changed of changes) {
      const test = transport(); expect(await createCareMessagingHandler({ ...env(), ...changed }, build, test.factory)(event())).toMatchObject({ statusCode: 503 });
      expect(test.factory).not.toHaveBeenCalled();
    }
    const test = transport(); expect(await createCareMessagingHandler(env(), { ...build, sourceClean: false }, test.factory)(event())).toMatchObject({ statusCode: 503 });
    expect(test.factory).not.toHaveBeenCalled();
  });
  it('requires every independent review and separate consumer/workforce identities before data construction', async () => {
    for (const key of ['DATABASE_REVIEW_SHA256', 'WORKFORCE_MFA_REVIEW_SHA256', 'MESSAGING_REVIEW_SHA256', 'RETENTION_REVIEW_SHA256', 'QUALIFICATION_REVIEW_SHA256']) {
      const test = transport(); expect(await createCareMessagingHandler({ ...env(), [key]: '' }, build, test.factory)(event())).toMatchObject({ statusCode: 503 });
      expect(test.factory).not.toHaveBeenCalled();
    }
    const test = transport(); expect(await createCareMessagingHandler({ ...env(), CONSUMER_ISSUER: env().WORKFORCE_ISSUER }, build, test.factory)(event())).toMatchObject({ statusCode: 503 });
    expect(test.factory).not.toHaveBeenCalled();
  });
  it('requires Gateway-verified claims, designated subjects and workforce reauthentication', async () => {
    const test = transport(), handler = createCareMessagingHandler(env(), build, test.factory, () => now);
    const raw = { ...event(), requestContext: undefined, headers: { authorization: 'Bearer fictional' } };
    expect(await handler(raw)).toMatchObject({ statusCode: 401 });
    const foreign = event(); foreign.requestContext!.authorizer!.jwt!.claims!.sub = 'fictional-not-designated';
    expect(await handler(foreign)).toMatchObject({ statusCode: 503 });
    const stale = event('workforce'); stale.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect(await handler(stale)).toMatchObject({ statusCode: 401 }); expect(test.factory).not.toHaveBeenCalled();
  });
  it('checks the contract before each operation, caches no verification result and marks every qualification response', async () => {
    const test = transport(), handler = createCareMessagingHandler(env(), build, test.factory, () => now);
    for (const pool of ['consumer', 'workforce'] as const) expect(await handler(event(pool))).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    expect(test.factory).toHaveBeenCalledOnce();
    expect(test.query.mock.calls.filter(([sql]) => sql.startsWith('with expected'))).toHaveLength(2);
    expect(test.query.mock.calls[0][0]).toContain("current_user='clinical_core_api'");
    expect(test.query.mock.calls[0][0]).not.toContain('schema_migrations');
  });
  it('refuses contract drift before context/message SQL and returns no raw database details', async () => {
    const test = transport(false); expect(await createCareMessagingHandler(env(), build, test.factory, () => now)(event())).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' });
    expect(test.query).toHaveBeenCalledOnce(); expect(test.query.mock.calls[0][0]).toContain('checked_functions');
    expect(() => bindCareMessagingDatabase(test.factory(), { ...build, functions: [] })).toThrow('binding_refused');
  });
});
