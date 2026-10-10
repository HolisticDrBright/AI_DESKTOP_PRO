import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProductionClinicRecordsApi, CLINIC_RECORD_ROUTES, type ProductionClinicRecordsConfiguration } from './production-clinic-records-api';
import { ClinicRecordError } from './production-clinic-records';
import type { ApiGatewayV2Event } from './aws-identity-api';
const now = 1800000000000, org = randomUUID(), person = randomUUID(), hash = 'a'.repeat(64), requestId = randomUUID();
const config: ProductionClinicRecordsConfiguration = {
  workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_workforce', workforceAudience: 'w'.repeat(26),
  consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_consumer', consumerAudience: 'c'.repeat(26),
  organizationId: org, phiAllowed: false, activation: 'blocked', databaseReviewSha256: hash, mfaReviewSha256: hash,
  disclosureReviewSha256: hash, retentionReviewSha256: hash,
  qualification: { accountId: '588966314750', databaseName: 'clinical_core_qualification', reviewSha256: hash,
    identitySubjects: ['consumer-fixture-00001', 'workforce-fixture-00001'] },
};
const record = { requestId, kind: 'copy', status: 'submitted', revision: 1, sections: ['signed_notes'], subject: null, reasonCode: null, statement: null,
  submittedAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', decidedAt: null, decisionReasonCode: null, decisionReason: null, fulfillmentId: null, supersededBy: null, outcome: null };
function event(pool: 'consumer' | 'workforce' = 'consumer', body: unknown = pool === 'consumer' ? { action: 'overview' } : { action: 'queue', limit: 10 }, authAge = 10): ApiGatewayV2Event {
  return { routeKey: CLINIC_RECORD_ROUTES[pool === 'consumer' ? 0 : 1], headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config[pool === 'consumer' ? 'consumerIssuer' : 'workforceIssuer'],
      aud: config[pool === 'consumer' ? 'consumerAudience' : 'workforceAudience'], sub: pool + '-fixture-00001',
      'custom:person_id': person, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true',
      token_use: 'id', iat: now / 1000 - 10, exp: now / 1000 + 1000, auth_time: now / 1000 - authAge } } } } };
}
function setup(configuration = config) {
  const consumer = vi.fn(async () => ({ action: 'overview' as const, connection: null, sections: [], requests: [] }));
  const workforce = vi.fn(async () => ({ action: 'queue' as const, requests: [], next: null }));
  const consumerFactory = vi.fn(() => consumer), workforceFactory = vi.fn(() => workforce);
  const api = createProductionClinicRecordsApi({ configuration, consumer: consumerFactory, workforce: workforceFactory, now: () => now });
  return { api, consumer, workforce, consumerFactory, workforceFactory };
}
describe('unreleased clinic-record privacy API boundary', () => {
  it('is off by default and touches no database factory', async () => {
    const test = setup({ ...config, qualification: undefined });
    expect(await test.api(event())).toMatchObject({ statusCode: 503 }); expect(test.consumerFactory).not.toHaveBeenCalled(); expect(test.workforceFactory).not.toHaveBeenCalled();
  });
  it('admits only designated fixtures on their own pool and marks qualification evidence', async () => {
    const test = setup();
    expect(await test.api(event('consumer'))).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification', 'cache-control': 'no-store' } });
    expect(test.consumer).toHaveBeenLastCalledWith(expect.objectContaining({ actorPersonId: person, organizationId: org, identityPool: 'consumer', purpose: 'consent_management' }), { action: 'overview' });
    expect(await test.api(event('workforce'))).toMatchObject({ statusCode: 200 });
    expect(test.workforce).toHaveBeenLastCalledWith(expect.objectContaining({ identityPool: 'workforce', purpose: 'clinical_data' }), { action: 'queue', limit: 10 });
    const foreign = event(); foreign.requestContext!.authorizer!.jwt!.claims!.sub = 'consumer-not-designated';
    expect(await test.api(foreign)).toMatchObject({ statusCode: 503 }); expect(test.consumer).toHaveBeenCalledTimes(1);
  });
  it('refuses missing independent disclosure, retention and MFA reviews when serving', () => {
    for (const key of ['disclosureReviewSha256', 'retentionReviewSha256', 'mfaReviewSha256'] as const) expect(() => setup({ ...config, [key]: undefined })).toThrow('clinic_record_review_required');
    expect(() => setup({ ...config, consumerAudience: config.workforceAudience })).toThrow('clinic_record_api_configuration_invalid');
  });
  it('does not accept raw bearer headers, consumer claims on the workforce route or workforce claims on the consumer route', async () => {
    const test = setup(); const spoof = event(); spoof.requestContext = undefined; spoof.headers!.authorization = 'Bearer fictional';
    expect(await test.api(spoof)).toMatchObject({ statusCode: 401 });
    const wrong = event(); wrong.routeKey = CLINIC_RECORD_ROUTES[1];
    expect(await test.api(wrong)).toMatchObject({ statusCode: 401 });
    const reverse = event('workforce'); reverse.routeKey = CLINIC_RECORD_ROUTES[0];
    expect(await test.api(reverse)).toMatchObject({ statusCode: 401 });
    expect(test.consumerFactory).not.toHaveBeenCalled(); expect(test.workforceFactory).not.toHaveBeenCalled();
  });
  it('refuses owner/tenant substitution, expired, non-production and stale credentials; the body never names a patient, clinic or owner', async () => {
    for (const [key, value] of [['custom:organization_id', randomUUID()], ['exp', now / 1000 - 1], ['custom:production_bound', 'false'], ['custom:synthetic_attested', 'true']]) {
      const test = setup(), changed = event(); changed.requestContext!.authorizer!.jwt!.claims![key] = value;
      expect((await test.api(changed)).statusCode).toBeGreaterThanOrEqual(400); expect(test.consumerFactory).not.toHaveBeenCalled();
    }
    const stale = event('workforce'); stale.requestContext!.authorizer!.jwt!.claims!.auth_time = now / 1000 - 901;
    expect(await setup().api(stale)).toMatchObject({ statusCode: 401 });
    const test = setup();
    expect(await test.api(event('consumer', { action: 'submit_copy', requestId, sections: ['signed_notes'], patientRecordId: randomUUID() }))).toMatchObject({ statusCode: 400 });
    expect(await test.api(event('consumer', { action: 'overview', connectionId: randomUUID() }))).toMatchObject({ statusCode: 400 });
    expect(await test.api(event('workforce', { action: 'queue', limit: 10, organizationId: org }))).toMatchObject({ statusCode: 400 });
    expect(test.consumer).not.toHaveBeenCalled(); expect(test.workforce).not.toHaveBeenCalled();
  });
  it('requires a recent sign-in for patient actions and the download window for reading a copy', async () => {
    const test = setup();
    test.consumer.mockResolvedValue({ action: 'submit_copy', request: record, alreadyApplied: false } as never);
    expect(await test.api(event('consumer', { action: 'submit_copy', requestId, sections: ['signed_notes'] }, 14 * 60))).toMatchObject({ statusCode: 200 });
    expect(await test.api(event('consumer', { action: 'submit_copy', requestId, sections: ['signed_notes'] }, 16 * 60))).toMatchObject({ statusCode: 401, body: '{"error":"reauth_required"}' });
    test.consumer.mockResolvedValue({ action: 'read_copy', requestId, copyId: randomUUID(), section: 'signed_notes', asOf: '2026-10-10T00:00:00Z', items: [], next: null } as never);
    expect(await test.api(event('consumer', { action: 'read_copy', requestId, section: 'signed_notes', limit: 10 }, 4 * 60))).toMatchObject({ statusCode: 200 });
    expect(await test.api(event('consumer', { action: 'read_copy', requestId, section: 'signed_notes', limit: 10 }, 6 * 60))).toMatchObject({ statusCode: 401 });
    expect(test.consumer).toHaveBeenCalledTimes(2);
  });
  it('rejects queries, unexpected keys, media types, oversized and corrupt encoded bodies before data access', async () => {
    const test = setup();
    const requests: ApiGatewayV2Event[] = [
      { ...event(), queryStringParameters: { owner: person } },
      { ...event(), body: JSON.stringify({ action: 'overview', ownerId: person }) },
      { ...event(), headers: { 'content-type': 'text/plain' } },
      { ...event(), body: 'x'.repeat(120001) },
      { ...event(), isBase64Encoded: true, body: '%%%bad' },
      { ...event(), isBase64Encoded: true, body: Buffer.from([0xff]).toString('base64') },
      { ...event(), body: JSON.stringify({ action: 'amend', requestId, expectedRevision: 1, decisionId: randomUUID(), addendumReason: 'r', addendumContent: 'x'.repeat(90000) }) },
    ];
    for (const request of requests) expect(await test.api(request)).toMatchObject({ statusCode: 400 });
    expect(test.consumerFactory).not.toHaveBeenCalled();
  });
  it('maps decided refusals to their status codes without leaking transport details', async () => {
    const test = setup();
    for (const [category, status] of [['connection_required', 403], ['subject_not_disclosed', 403], ['identity_refused', 403], ['account_deletion_write_blocked', 403],
      ['conflict', 409], ['disclosure_release_required', 409], ['not_found', 404], ['request_invalid', 400]] as const) {
      test.consumer.mockRejectedValueOnce(new ClinicRecordError(category));
      expect(await test.api(event())).toMatchObject({ statusCode: status, body: JSON.stringify({ error: category }) });
    }
    test.workforce.mockRejectedValueOnce(Object.assign(new Error('SECRET SQL health content'), { cause: new Error('secret') }));
    expect(await test.api(event('workforce'))).toMatchObject({ statusCode: 503, body: '{"error":"service_unavailable"}' });
  });
});
