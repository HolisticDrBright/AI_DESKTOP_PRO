import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { createWorkforceApplicationsCandidate,
  type WorkforceApplicationStore } from './aws-workforce-applications-api';

const ACCOUNT = '588966314750';
const ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_ueGlFRbNB';
const AUDIENCE = '4s7jgr4o8sqdq7cvo9gmq96e2h';
const subject = randomUUID(), organization = randomUUID(), requestId = randomUUID();
const evidence = 'a'.repeat(64);
const email = 'fictional.practitioner@example.invalid';

function event(routeKey: string, body?: Record<string, unknown>, claims: Record<string, string> = {}): ApiGatewayV2Event {
  return { routeKey,headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    requestContext: { accountId: ACCOUNT,authorizer: { jwt: { claims: {
      iss: ISSUER,aud: AUDIENCE,token_use: 'id',sub: subject,
      email,email_verified: 'true','custom:synthetic_attested': 'true',...claims,
    } } } } };
}
function setup(activation: 'blocked' | 'qualification' = 'qualification') {
  const currentApplicant = vi.fn(async () => ({ subject,email,emailVerified: true,enabled: true }));
  const store: WorkforceApplicationStore = {
    submit: vi.fn(async ({ requestId: id }) => id),
    list: vi.fn(async () => [{ id: requestId,status: 'pending' }]),
    withdraw: vi.fn(async () => {}),
  };
  const handler = createWorkforceApplicationsCandidate({
    configuration: { activation,phiAllowed: false,accountId: ACCOUNT,issuer: ISSUER,
      audience: AUDIENCE,reviewEvidenceSha256: activation === 'qualification' ? evidence : undefined },
    currentApplicant,store,
  });
  return { handler,currentApplicant,store };
}
function result(body: string): Record<string, unknown> { return JSON.parse(body) as Record<string, unknown>; }

describe('blocked workforce applications API candidate', () => {
  it('never touches identity or the database in the real blocked release', async () => {
    const f = setup('blocked');
    const reply = await f.handler(event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'join',organizationId: organization }));
    expect(reply.statusCode).toBe(503);
    expect(f.currentApplicant).not.toHaveBeenCalled();
    expect(f.store.submit).not.toHaveBeenCalled();
  });

  it('accepts only the isolated fictional qualification identity and reviewed configuration', () => {
    expect(() => createWorkforceApplicationsCandidate({
      configuration: { activation: 'qualification',phiAllowed: false,accountId: '173535830222',
        issuer: ISSUER,audience: AUDIENCE,reviewEvidenceSha256: evidence },
      currentApplicant: async () => null,store: setup().store,
    })).toThrow(/configuration_invalid/);
    expect(() => createWorkforceApplicationsCandidate({
      configuration: { activation: 'qualification',phiAllowed: false,accountId: ACCOUNT,
        issuer: ISSUER,audience: AUDIENCE },
      currentApplicant: async () => null,store: setup().store,
    })).toThrow(/configuration_invalid/);
  });

  it('derives subject and email digest from a current verified Cognito account, never the request body', async () => {
    const f = setup();
    const reply = await f.handler(event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'join',organizationId: organization }));
    expect(reply.statusCode).toBe(202);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(f.currentApplicant).toHaveBeenCalledWith(subject);
    expect(f.store.submit).toHaveBeenCalledWith({ requestId,subject,
      emailSha256: createHash('sha256').update(email).digest('hex'),
      kind: 'join',organizationId: organization,proposedLabel: null });
    expect(result(reply.body)).toEqual({ data: { requestId,status: 'pending' } });
  });

  it('accepts a bounded clinic proposal but never creates a clinic in the applicant route', async () => {
    const f = setup();
    const reply = await f.handler(event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'create_clinic',proposedLabel: '  FICTIONAL NEW CLINIC  ' }));
    expect(reply.statusCode).toBe(202);
    expect(f.store.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create_clinic',organizationId: null,proposedLabel: 'FICTIONAL NEW CLINIC',
    }));
  });

  it('accepts a case-insensitive JSON header without weakening the body bound', async () => {
    const f = setup();
    const request = event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'join',organizationId: organization });
    request.headers = { 'Content-Type': 'application/json; charset=utf-8' };
    expect((await f.handler(request)).statusCode).toBe(202);
  });

  it.each([
    ['wrong issuer', { iss: 'https://example.invalid' }],
    ['wrong client', { aud: 'other' }],
    ['access token', { token_use: 'access' }],
    ['missing attestation', { 'custom:synthetic_attested': 'false' }],
    ['production bound', { 'custom:production_bound': 'true' }],
    ['client-supplied clinic claim', { 'custom:organization_id': organization }],
    ['unverified email', { email_verified: 'false' }],
    ['wrong subject shape', { sub: 'other-subject' }],
  ])('refuses %s before any store call', async (_name, claims) => {
    const f = setup();
    const reply = await f.handler(event('GET /clinical-core/workforce/applications',undefined,claims));
    expect(reply.statusCode).toBe(403);
    expect(f.currentApplicant).not.toHaveBeenCalled();
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it('refuses account changes and current-identity outages before any application read', async () => {
    const f = setup();
    f.currentApplicant.mockResolvedValueOnce({ subject: randomUUID(),email,emailVerified: true,enabled: true });
    expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(403);
    f.currentApplicant.mockResolvedValueOnce({ subject,email: 'changed@example.invalid',emailVerified: true,enabled: true });
    expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(403);
    f.currentApplicant.mockRejectedValueOnce(new Error('provider details must not leak'));
    const unavailable = await f.handler(event('GET /clinical-core/workforce/applications'));
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain('provider details');
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it('binds status and withdrawal to the authenticated subject', async () => {
    const f = setup();
    expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(200);
    expect(f.store.list).toHaveBeenCalledWith(subject);
    expect((await f.handler(event('POST /clinical-core/workforce/applications/withdraw',
      { requestId }))).statusCode).toBe(200);
    expect(f.store.withdraw).toHaveBeenCalledWith(requestId,subject);
  });

  it('rejects extra identity fields, oversize and wrong content without calling the database', async () => {
    const f = setup();
    for (const body of [
      { requestId,kind: 'join',organizationId: organization,subject: randomUUID() },
      { requestId,kind: 'join',organizationId: organization,email: 'attacker@example.invalid' },
      { requestId,kind: 'create_clinic',proposedLabel: 'A'.repeat(200) },
    ]) expect((await f.handler(event('POST /clinical-core/workforce/applications',body))).statusCode).toBe(400);
    const oversized = event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'join',organizationId: organization,extra: 'x'.repeat(3000) });
    expect((await f.handler(oversized)).statusCode).toBe(400);
    const encoded = event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'join',organizationId: organization });
    encoded.headers = { 'content-type': 'text/plain' };
    expect((await f.handler(encoded)).statusCode).toBe(400);
    expect(f.store.submit).not.toHaveBeenCalled();
  });

  it('does not reveal clinic existence or SQL errors on store refusal', async () => {
    const f = setup();
    vi.mocked(f.store.submit).mockRejectedValue(new Error('workforce_clinic_unavailable SQL detail'));
    const reply = await f.handler(event('POST /clinical-core/workforce/applications',
      { requestId,kind: 'join',organizationId: organization }));
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toBe('{"error":"workforce_application_unavailable"}');
  });
});
