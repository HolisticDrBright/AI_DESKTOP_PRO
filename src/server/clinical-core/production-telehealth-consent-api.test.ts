import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CareConnectionError } from './production-care-connections';
import { createProductionTelehealthConsentApi, TELEHEALTH_CONSENT_ROUTE } from './production-telehealth-consent-api';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';
import { ClinicalCoreDatabaseRejection } from './database';
import type { ApiGatewayV2Event } from './aws-identity-api';
const now = 1800000000000, org = randomUUID(), owner = randomUUID(), link = randomUUID(), artifactId = randomUUID(), hash = 'a'.repeat(64);
const config = {
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce', workforceAudience: 'w'.repeat(26),
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer', consumerAudience: 'c'.repeat(26), organizationId: org,
  phiAllowed: false, activation: 'blocked' as const, databaseReviewSha256: hash, mfaReviewSha256: hash, connectionReviewSha256: hash,
  consentReviewSha256: hash, telehealthConsentEnabled: true,
  qualification: { accountId: '588966314750', databaseName: 'clinical_core_qualification', reviewSha256: hash,
    identitySubjects: ['consumer-fixture-00001', 'workforce-fixture-00001'] },
};
function event(body: unknown = { action: 'connection' }): ApiGatewayV2Event {
  return { routeKey: TELEHEALTH_CONSENT_ROUTE, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config.consumerIssuer, aud: config.consumerAudience,
      sub: 'consumer-fixture-00001', token_use: 'id', 'custom:person_id': owner, 'custom:organization_id': org,
      'custom:production_bound': 'true', email_verified: true, iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } } };
}
const grant = { action: 'grant', connectionId: link, scope: 'telehealth_recording', artifactId, contentSha256: hash, expectedVersion: 0 };
function setup(configuration: Parameters<typeof createProductionTelehealthConsentApi>[0]['configuration'] = structuredClone(config)) {
  const operation = vi.fn(async () => ({ connection: null })), factory = vi.fn(() => operation);
  const input = { configuration, operations: factory, now: () => now };
  const api = createProductionTelehealthConsentApi(input);
  return { api, factory, operation, input };
}
describe('unreleased telehealth exact-copy API, fictional transports only', () => {
  it('refuses disabled activation before data access', async () => {
    const s = setup({ ...config, qualification: undefined });
    expect((await s.api(event())).statusCode).toBe(503); expect(s.factory).not.toHaveBeenCalled();
  });
  it('requires separate consent, connection and MFA reviews and distinct identity pools', () => {
    for (const key of ['consentReviewSha256', 'connectionReviewSha256', 'mfaReviewSha256'] as const)
      expect(() => setup({ ...config, [key]: undefined })).toThrow('telehealth_consent_review_required');
    expect(() => setup({ ...config, consumerIssuer: config.workforceIssuer })).toThrow();
    expect(() => setup({ ...config, consumerAudience: config.workforceAudience })).toThrow();
  });
  it('marks only designated fictional subjects as qualification, never production evidence', async () => {
    const s = setup();
    expect(await s.api(event())).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification', 'cache-control': 'no-store' } });
    const other = event(); other.requestContext!.authorizer!.jwt!.claims!.sub = 'undesignated';
    expect((await s.api(other)).statusCode).toBe(503); expect(s.factory).toHaveBeenCalledOnce();
  });
  it.each(['custom:organization_id', 'custom:production_bound', 'exp', 'email_verified', 'iss', 'aud', 'token_use'])('refuses substituted %s', async key => {
    const s = setup(), changed = event();
    changed.requestContext!.authorizer!.jwt!.claims![key] = key === 'exp' ? now / 1000 - 1
      : key === 'custom:organization_id' ? randomUUID() : 'false';
    expect([401, 403]).toContain((await s.api(changed)).statusCode); expect(s.factory).not.toHaveBeenCalled();
  });
  it('does not authenticate a body, unverified header or workforce JWT as the patient', async () => {
    const s = setup(), missing = event(); missing.requestContext = undefined; missing.headers!.authorization = 'Bearer fictional';
    expect((await s.api(missing)).statusCode).toBe(401);
    const workforce = event(); Object.assign(workforce.requestContext!.authorizer!.jwt!.claims!, {
      iss: config.workforceIssuer, aud: config.workforceAudience, sub: 'workforce-fixture-00001',
    });
    expect((await s.api(workforce)).statusCode).toBe(401); expect(s.factory).not.toHaveBeenCalled();
  });
  it('requires fresh sign-in for grant but permits status and withdrawal on a valid older session', async () => {
    const s = setup(), changed = event(grant); changed.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect((await s.api(changed)).statusCode).toBe(401);
    changed.body = JSON.stringify({ action: 'withdraw', connectionId: link, scope: 'telehealth_recording', expectedVersion: 1 });
    expect((await s.api(changed)).statusCode).toBe(200); expect(s.factory).toHaveBeenCalledOnce();
  });
  it('hides removed consent copy and blocks new grants without removing withdrawal', async () => {
    const s = setup({ ...config, telehealthConsentEnabled: false });
    expect(await s.api(event(grant))).toMatchObject({ statusCode: 403, body: '{"error":"feature_scope_not_enabled"}' });
    s.operation.mockResolvedValueOnce({ artifact: { content: 'FICTIONAL' } } as unknown as { connection: null });
    expect(JSON.parse((await s.api(event({ action: 'consent', connectionId: link, scope: 'telehealth_recording' }))).body).data.artifact).toBeNull();
    expect((await s.api(event({ action: 'withdraw', connectionId: link, scope: 'telehealth_recording', expectedVersion: 1 }))).statusCode).toBe(200);
  });
  it('captures mutable configuration and collaborators', async () => {
    const s = setup({ ...config, telehealthConsentEnabled: false });
    s.input.configuration.telehealthConsentEnabled = true; s.input.configuration.consumerIssuer = config.workforceIssuer;
    s.input.operations = vi.fn(() => s.operation);
    expect((await s.api(event(grant))).statusCode).toBe(403); expect(s.factory).not.toHaveBeenCalled();
    expect((await s.api(event())).statusCode).toBe(200); expect(s.factory).toHaveBeenCalledOnce(); expect(s.input.operations).not.toHaveBeenCalled();
  });
  it('rejects unknown fields, authority, scope, encoding, query and large body before data access', async () => {
    const s = setup();
    for (const changed of [event({ ...grant, ownerId: owner }), event({ ...grant, representativeAuthority: 'guardian' }),
      event({ ...grant, scope: 'messaging' }), event({ ...grant, expectedVersion: -1 }),
      { ...event(), queryStringParameters: { owner: owner } }, { ...event(), headers: { 'content-type': 'text/plain' } },
      { ...event(), body: 'x'.repeat(30001) }, { ...event(), body: '{}' },
      { ...event(), isBase64Encoded: true, body: '%%%%' },
      { ...event(), isBase64Encoded: true, body: Buffer.from([0xff]).toString('base64') }])
      expect((await s.api(changed)).statusCode).toBe(400);
    expect(s.factory).not.toHaveBeenCalled();
  });
  it('keeps conflicts and refusals explicit while hiding unknown SQL/provider details', async () => {
    const s = setup();
    for (const [category, status] of [['identity_refused', 403], ['consent_required', 403], ['conflict', 409], ['account_deletion_write_blocked', 403]] as const) {
      s.operation.mockRejectedValueOnce(new CareConnectionError(category));
      expect(await s.api(event())).toMatchObject({ statusCode: status, body: JSON.stringify({ error: category }) });
    }
    s.operation.mockRejectedValueOnce(Error('private SQL token information'));
    expect(await s.api(event())).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' });
  });
  it.each([['telehealth_consent_refused', 'identity_refused'], ['telehealth_consent_copy_required', 'consent_required'],
    ['telehealth_consent_conflict', 'conflict'], ['telehealth_consent_invalid', 'request_invalid']] as const)(
    'classifies actual RDS %s without exposing its text', async (message, category) => {
      const database = createRdsDataClinicalCoreDatabase({ clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
        secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', databaseName: 'clinical_core_qualification' }, {
        async send(command) {
          const c = command as unknown as { constructor: { name: string }; input: { sql?: string } };
          if (c.constructor.name === 'BeginTransactionCommand') return { transactionId: 'fictional' };
          if (c.constructor.name === 'ExecuteStatementCommand' && c.input.sql !== 'set local role clinical_core_api')
            throw Object.assign(Error(message), { name: 'DatabaseErrorException' });
          return {};
        },
      });
      await expect(database.transaction(tx => tx.query('select fictional'))).rejects.toEqual(new ClinicalCoreDatabaseRejection(category));
    });
});
