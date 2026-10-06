import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CareConnectionError } from './production-care-connections';
import { createProductionCareConnectionApi, CARE_CONNECTION_ROUTES, type CareConnectionConfiguration } from './production-care-connections-api';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';
import { ClinicalCoreDatabaseRejection } from './database';
import type { ApiGatewayV2Event } from './aws-identity-api';
const now = 1800000000000, org = randomUUID(), owner = randomUUID(), link = randomUUID(), artifactId = randomUUID(), hash = 'a'.repeat(64);
const config: CareConnectionConfiguration = {
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce', workforceAudience: 'w'.repeat(26),
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer', consumerAudience: 'c'.repeat(26), organizationId: org,
  phiAllowed: false, activation: 'blocked', databaseReviewSha256: hash, mfaReviewSha256: hash, connectionReviewSha256: hash,
  consentReviewSha256: hash, enabledScopes: ['messaging'],
  qualification: { accountId: '588966314750', databaseName: 'clinical_core_qualification', reviewSha256: hash,
    identitySubjects: ['consumer-fixture-00001', 'workforce-fixture-00001'] },
};
function event(body: unknown = { action: 'connection' }, pool: 'consumer' | 'workforce' = 'consumer'): ApiGatewayV2Event {
  return { routeKey: CARE_CONNECTION_ROUTES[pool === 'consumer' ? 0 : 1], headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config[pool === 'consumer' ? 'consumerIssuer' : 'workforceIssuer'],
      aud: config[pool === 'consumer' ? 'consumerAudience' : 'workforceAudience'], sub: pool + '-fixture-00001', token_use: 'id',
      'custom:person_id': owner, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: true,
      iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } } };
}
function setup(configuration: CareConnectionConfiguration = structuredClone(config)) {
  const operation = vi.fn(async () => ({ connection: null })), factory = vi.fn(() => operation);
  const input = { configuration, operations: factory, now: () => now };
  const api = createProductionCareConnectionApi(input);
  return { api, operation, factory, input };
}
const grant = { action: 'grant', connectionId: link, scope: 'messaging', artifactId, contentSha256: hash, expectedVersion: 0 };
describe('unreleased connection gateway boundary', () => {
  it('stays off without activation or qualification, before touching a database', async () => {
    const s = setup({ ...config, qualification: undefined });
    expect(await s.api(event())).toMatchObject({ statusCode: 503 }); expect(s.factory).not.toHaveBeenCalled();
  });
  it('requires separate connection, consent and workforce MFA reviews even in qualification', () => {
    for (const key of ['connectionReviewSha256', 'consentReviewSha256', 'mfaReviewSha256'] as const)
      expect(() => setup({ ...config, [key]: undefined })).toThrow('care_connection_review_required');
    expect(() => setup({ ...config, phiAllowed: true, activation: 'approved', activationEvidenceSha256: hash })).toThrow('qualification_execution_invalid');
  });
  it('admits only designated subjects, and marks responses as qualification rather than activation', async () => {
    const s = setup(); expect(await s.api(event())).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification', 'cache-control': 'no-store' } });
    const other = event(); other.requestContext!.authorizer!.jwt!.claims!.sub = 'not-designated-fixture';
    expect(await s.api(other)).toMatchObject({ statusCode: 503 }); expect(s.factory).toHaveBeenCalledOnce();
  });
  it('uses separate pools and never obtains identity or approvals from body/header claims', async () => {
    const s = setup(), missing = event(); missing.requestContext = undefined; missing.headers!.authorization = 'Bearer fictional';
    expect(await s.api(missing)).toMatchObject({ statusCode: 401 });
    const wrong = event({ action: 'issue', patientRecordId: randomUUID() }); wrong.routeKey = CARE_CONNECTION_ROUTES[1];
    expect(await s.api(wrong)).toMatchObject({ statusCode: 401 });
    expect(await s.api(event({ action: 'connection', ownerId: owner }))).toMatchObject({ statusCode: 400 });
    expect(await s.api(event({ action: 'issue', patientRecordId: randomUUID() }))).toMatchObject({ statusCode: 403 });
    expect(s.factory).not.toHaveBeenCalled();
  });
  it.each(['custom:organization_id', 'custom:production_bound', 'exp', 'email_verified'])('refuses substituted or expired %s claims', async key => {
    const s = setup(), changed = event();
    changed.requestContext!.authorizer!.jwt!.claims![key] = key === 'exp' ? now / 1000 - 1 : key === 'custom:organization_id' ? randomUUID() : 'false';
    expect(await s.api(changed)).toMatchObject({ statusCode: key === 'custom:organization_id' ? 403 : 401 }); expect(s.factory).not.toHaveBeenCalled();
  });
  it('requires fresh authentication for claims and grants, but keeps withdrawal available to a valid older session', async () => {
    const s = setup();
    for (const request of [{ action: 'claim', token: 'ABCD-EFGH-JKLMN' }, grant]) {
      const changed = event(request); changed.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
      expect(await s.api(changed)).toMatchObject({ statusCode: 401 });
    }
    const changed = event({ action: 'withdraw', connectionId: link, scope: 'messaging', expectedVersion: 1 });
    changed.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect(await s.api(changed)).toMatchObject({ statusCode: 200 }); expect(s.factory).toHaveBeenCalledOnce();
  });
  it('does not offer a removed feature copy or allow new grants, without blocking history or withdrawal', async () => {
    const s = setup({ ...config, enabledScopes: [] });
    expect(await s.api(event(grant))).toMatchObject({ statusCode: 403, body: '{"error":"feature_scope_not_enabled"}' });
    s.operation.mockResolvedValueOnce({ connection: null, artifact: { content: 'FICTIONAL' } } as unknown as { connection: null });
    const response = await s.api(event({ action: 'consent', connectionId: link, scope: 'messaging' }));
    expect(JSON.parse(response.body).data.artifact).toBeNull();
    expect(await s.api(event({ action: 'withdraw', connectionId: link, scope: 'messaging', expectedVersion: 0 }))).toMatchObject({ statusCode: 200 });
  });
  it('captures configuration and collaborators so external mutation cannot widen this reviewed boundary', async () => {
    const s = setup({ ...config, enabledScopes: [] });
    (s.input.configuration.enabledScopes as string[]).push('messaging'); s.input.configuration.consumerIssuer = config.workforceIssuer;
    s.input.operations = vi.fn(() => s.operation);
    expect(await s.api(event(grant))).toMatchObject({ statusCode: 403 }); expect(s.factory).not.toHaveBeenCalled();
    expect(await s.api(event())).toMatchObject({ statusCode: 200 }); expect(s.factory).toHaveBeenCalledOnce(); expect(s.input.operations).not.toHaveBeenCalled();
  });
  it('rejects unknown authority, scopes, queries, media types, encodings and bodies before data access', async () => {
    const s = setup();
    for (const changed of [
      event({ ...grant, representativeAuthority: 'guardian' }), event({ ...grant, scope: 'everything' }), event({ ...grant, expectedVersion: -1 }),
      { ...event(), queryStringParameters: { ownerId: owner } }, { ...event(), headers: { 'content-type': 'text/plain' } },
      { ...event(), body: 'x'.repeat(30001) }, { ...event(), isBase64Encoded: true, body: '%%%%' },
      { ...event(), isBase64Encoded: true, body: Buffer.from([0xff]).toString('base64') },
    ]) expect(await s.api(changed)).toMatchObject({ statusCode: 400 });
    expect(s.factory).not.toHaveBeenCalled();
  });
  it('preserves database refusals/conflicts and strips all unexpected provider details', async () => {
    const s = setup();
    for (const [code, status] of [['identity_refused', 403], ['consent_required', 403], ['conflict', 409], ['account_deletion_write_blocked', 403]] as const) {
      s.operation.mockRejectedValueOnce(new CareConnectionError(code));
      expect(await s.api(event())).toMatchObject({ statusCode: status, body: JSON.stringify({ error: code }) });
    }
    s.operation.mockRejectedValueOnce(new Error('private SQL token text'));
    expect(await s.api(event())).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' });
  });
  it.each([['care_connection_refused', 'identity_refused'], ['care_connection_approved_copy_required', 'consent_required'],
    ['care_connection_conflict', 'conflict'], ['care_connection_invalid', 'request_invalid']] as const)
  ('classifies the real RDS %s error without leaking its text', async (message, category) => {
    const database = createRdsDataClinicalCoreDatabase({ clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
      secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', databaseName: 'clinical_core_qualification' }, {
      async send(command) {
        const c = command as unknown as { constructor: { name: string }; input: { sql?: string } };
        if (c.constructor.name === 'BeginTransactionCommand') return { transactionId: 'fictional' };
        if (c.constructor.name === 'ExecuteStatementCommand' && c.input.sql !== 'set local role clinical_core_api')
          throw Object.assign(new Error(message), { name: 'DatabaseErrorException' });
        return {};
      },
    });
    await expect(database.transaction(tx => tx.query('select fictional'))).rejects.toEqual(new ClinicalCoreDatabaseRejection(category));
  });
});
