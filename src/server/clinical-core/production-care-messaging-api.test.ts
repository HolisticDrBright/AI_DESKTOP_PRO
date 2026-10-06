import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductionCareMessagingApi, PRODUCTION_CARE_MESSAGE_ROUTES, type ProductionCareMessagingConfiguration } from './production-care-messaging-api';
import { ProductionCareMessageError } from './production-care-messaging';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { createRdsDataClinicalCoreDatabase } from './rds-data-database';
import { ClinicalCoreDatabaseRejection } from './database';
const now = 1800000000000, org = randomUUID(), person = randomUUID(), hash = 'a'.repeat(64);
const config: ProductionCareMessagingConfiguration = {
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce', workforceAudience: 'w'.repeat(26),
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer', consumerAudience: 'c'.repeat(26),
  organizationId: org, phiAllowed: false, activation: 'blocked', databaseReviewSha256: hash, mfaReviewSha256: hash,
  messagingReviewSha256: hash, retentionReviewSha256: hash,
  qualification: { accountId: '588966314750', databaseName: 'clinical_core_qualification', reviewSha256: hash,
    identitySubjects: ['consumer-fixture-00001', 'workforce-fixture-00001'] },
};
function event(pool: 'consumer' | 'workforce' = 'consumer', privacy = false): ApiGatewayV2Event {
  return { routeKey: PRODUCTION_CARE_MESSAGE_ROUTES[privacy ? 2 : pool === 'consumer' ? 0 : 1], headers: { 'content-type': 'application/json' },
    body: JSON.stringify(privacy ? { action: 'export', section: 'messages' } : { action: 'list' }),
    requestContext: { authorizer: { jwt: { claims: { iss: config[pool === 'consumer' ? 'consumerIssuer' : 'workforceIssuer'],
      aud: config[pool === 'consumer' ? 'consumerAudience' : 'workforceAudience'], sub: pool + '-fixture-00001',
      'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true',
      token_use: 'id', iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - 10 } } } } };
}
function setup(configuration = config) {
  const messaging = vi.fn(async () => ({ action: 'list' as const, threads: [], nextBefore: null }));
  const exporter = vi.fn(async () => ({ contract: 'care-message-export/1' as const, section: 'messages' as const,
    records: [], nextBefore: null, coverage: 'retained_in_app_messages_live_pages' as const }));
  const factory = vi.fn(() => messaging), exportFactory = vi.fn(() => exporter);
  const api = createProductionCareMessagingApi({ configuration, messaging: factory, exporter: exportFactory, now: () => now });
  return { api, messaging, exporter, factory, exportFactory };
}
describe('unreleased care messaging API boundary', () => {
  it('is off by default and touches no database factory', async () => {
    const test = setup({ ...config, qualification: undefined });
    expect(await test.api(event())).toMatchObject({ statusCode: 503 }); expect(test.factory).not.toHaveBeenCalled();
  });
  it('admits only designated fixtures and marks qualification evidence', async () => {
    const test = setup();
    for (const pool of ['consumer', 'workforce'] as const) {
      const response = await test.api(event(pool));
      expect(response).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification', 'cache-control': 'no-store' } });
      expect(test.messaging).toHaveBeenLastCalledWith(expect.objectContaining({ actorPersonId: person, organizationId: org, identityPool: pool }), { action: 'list' });
    }
    const foreign = event(); foreign.requestContext!.authorizer!.jwt!.claims!.sub = 'consumer-not-designated';
    expect(await test.api(foreign)).toMatchObject({ statusCode: 503 }); expect(test.messaging).toHaveBeenCalledTimes(2);
  });
  it('refuses missing independent messaging, retention and MFA reviews in qualification', () => {
    for (const key of ['messagingReviewSha256', 'retentionReviewSha256', 'mfaReviewSha256'] as const) expect(() => setup({ ...config, [key]: undefined })).toThrow('care_message_review_required');
    expect(() => setup({ ...config, phiAllowed: true, activation: 'approved', activationEvidenceSha256: hash })).toThrow('qualification_execution_invalid');
  });
  it('does not accept raw bearer headers or consumer claims on a workforce route', async () => {
    const test = setup(); const spoof = event(); spoof.requestContext = undefined; spoof.headers!.authorization = 'Bearer fictional';
    expect(await test.api(spoof)).toMatchObject({ statusCode: 401 });
    const wrong = event(); wrong.routeKey = PRODUCTION_CARE_MESSAGE_ROUTES[1];
    expect(await test.api(wrong)).toMatchObject({ statusCode: 401 }); expect(test.factory).not.toHaveBeenCalled();
  });
  it('refuses owner/tenant substitution, expired and stale credentials', async () => {
    for (const [key, value] of [['custom:organization_id', randomUUID()], ['exp', now / 1000 - 1], ['custom:production_bound', 'false'], ['custom:synthetic_attested', 'true']]) {
      const test = setup(), changed = event(); changed.requestContext!.authorizer!.jwt!.claims![key] = value;
      expect((await test.api(changed)).statusCode).toBeGreaterThanOrEqual(400); expect(test.factory).not.toHaveBeenCalled();
    }
    const changed = event('workforce'); changed.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect(await setup().api(changed)).toMatchObject({ statusCode: 401 });
  });
  it('requires a fresh sign-in for privacy exports and invokes only the owner exporter', async () => {
    const test = setup(), request = event('consumer', true);
    expect(await test.api(request)).toMatchObject({ statusCode: 200 }); expect(test.messaging).not.toHaveBeenCalled();
    expect(test.exporter).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'consent_management', actorPersonId: person }), { action: 'export', section: 'messages' });
    request.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect(await test.api(request)).toMatchObject({ statusCode: 401 }); expect(test.exporter).toHaveBeenCalledTimes(1);
  });
  it('rejects queries, unexpected keys, media types, oversized and corrupt encoded bodies before data access', async () => {
    const test = setup();
    const requests: ApiGatewayV2Event[] = [
      { ...event(), queryStringParameters: { owner: person } },
      { ...event(), body: JSON.stringify({ action: 'list', ownerId: person }) },
      { ...event(), headers: { 'content-type': 'text/plain' } },
      { ...event(), body: 'x'.repeat(30001) },
      { ...event(), isBase64Encoded: true, body: '%%%bad' },
      { ...event(), isBase64Encoded: true, body: Buffer.from([0xff]).toString('base64') },
    ];
    for (const request of requests) expect(await test.api(request)).toMatchObject({ statusCode: 400 });
    expect(test.factory).not.toHaveBeenCalled();
  });
  it('preserves decided consent and conflict codes without leaking transport details', async () => {
    const test = setup();
    for (const [category, status] of [['consent_required', 403], ['conflict', 409], ['identity_refused', 403]] as const) {
      test.messaging.mockRejectedValueOnce(new ProductionCareMessageError(category));
      expect(await test.api(event())).toMatchObject({ statusCode: status, body: JSON.stringify({ error: category }) });
    }
    test.messaging.mockRejectedValueOnce(new Error('SECRET SQL health content'));
    expect(await test.api(event())).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' });
  });
  it('classifies actual RDS consent errors instead of replacing them with an outage', async () => {
    const database = createRdsDataClinicalCoreDatabase({ clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
      secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', databaseName: 'clinical_core_qualification' }, {
      async send(command) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === 'BeginTransactionCommand') return { transactionId: 'fictional' };
        if (name === 'ExecuteStatementCommand' && (command as unknown as { input: { sql: string } }).input.sql !== 'set local role clinical_core_api') {
          throw Object.assign(new Error('care_message_consent_required'), { name: 'DatabaseErrorException' });
        }
        return {};
      },
    });
    await expect(database.transaction(tx => tx.query('select fictional'))).rejects.toEqual(new ClinicalCoreDatabaseRejection('consent_required'));
  });
});
