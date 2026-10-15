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
  const currentApplicant = vi.fn(async () => ({ subject,email,emailVerified: true,enabled: true,mfaMethods: ['SOFTWARE_TOKEN_MFA'] }));
  const store: WorkforceApplicationStore = {
    submit: vi.fn(async ({ requestId: id }) => id),
    // The status function's row shape (workforce_access_status_for_subject).
    list: vi.fn(async () => [{ id: requestId,kind: 'join',status: 'pending',createdAt: '2026-10-15T12:00:00Z',organizationId: organization }]),
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
    f.currentApplicant.mockResolvedValueOnce({ subject: randomUUID(),email,emailVerified: true,enabled: true,mfaMethods: ['SOFTWARE_TOKEN_MFA'] });
    expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(403);
    f.currentApplicant.mockResolvedValueOnce({ subject,email: 'changed@example.invalid',emailVerified: true,enabled: true,mfaMethods: ['SOFTWARE_TOKEN_MFA'] });
    expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(403);
    f.currentApplicant.mockRejectedValueOnce(new Error('provider details must not leak'));
    const unavailable = await f.handler(event('GET /clinical-core/workforce/applications'));
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain('provider details');
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it('refuses an account without a currently configured Cognito MFA method before status or submission', async () => {
    const f = setup();
    for (const mfaMethods of [[], ['UNRECOGNIZED_MFA']]) {
      f.currentApplicant.mockResolvedValueOnce({ subject,email,emailVerified: true,enabled: true,mfaMethods });
      expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(403);
      f.currentApplicant.mockResolvedValueOnce({ subject,email,emailVerified: true,enabled: true,mfaMethods });
      expect((await f.handler(event('POST /clinical-core/workforce/applications',
        { requestId,kind: 'join',organizationId: organization }))).statusCode).toBe(403);
    }
    expect(f.store.list).not.toHaveBeenCalled();
    expect(f.store.submit).not.toHaveBeenCalled();
  });

  it.each(['SOFTWARE_TOKEN_MFA','SMS_MFA','EMAIL_OTP'])('accepts a current Cognito %s MFA setting in qualification', async method => {
    const f = setup();
    f.currentApplicant.mockResolvedValueOnce({ subject,email,emailVerified: true,enabled: true,mfaMethods: [method] });
    expect((await f.handler(event('GET /clinical-core/workforce/applications'))).statusCode).toBe(200);
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

describe('the applicant\'s own next step, retries and projection', () => {
  const pendingRow = (id = requestId) => ({ id,kind: 'join',status: 'pending',createdAt: '2026-10-15T12:00:00Z',organizationId: organization });
  function withRows(rows: unknown[], abuse?: Parameters<typeof createWorkforceApplicationsCandidate>[0]['abuse']) {
    const f = setup();
    vi.mocked(f.store.list).mockResolvedValue(rows);
    const handler = createWorkforceApplicationsCandidate({
      configuration: { activation: 'qualification',phiAllowed: false,accountId: ACCOUNT,issuer: ISSUER,audience: AUDIENCE,reviewEvidenceSha256: evidence },
      currentApplicant: f.currentApplicant,store: f.store,abuse,
    });
    return { ...f,handler };
  }

  it('names a missing MFA method and an unverified address, and keeps every other account refusal uniform', async () => {
    const f = setup();
    f.currentApplicant.mockResolvedValueOnce({ subject,email,emailVerified: true,enabled: true,mfaMethods: [] });
    expect(result((await f.handler(event('GET /clinical-core/workforce/applications'))).body)).toEqual({ error: 'workforce_applicant_mfa_required' });
    f.currentApplicant.mockResolvedValueOnce({ subject,email,emailVerified: false,enabled: true,mfaMethods: ['SOFTWARE_TOKEN_MFA'] });
    expect(result((await f.handler(event('GET /clinical-core/workforce/applications'))).body)).toEqual({ error: 'workforce_applicant_email_unverified' });
    for (const current of [null, { subject,email,emailVerified: true,enabled: false,mfaMethods: ['SOFTWARE_TOKEN_MFA'] },
      { subject,email: 'switched.account@example.invalid',emailVerified: true,enabled: true,mfaMethods: ['SOFTWARE_TOKEN_MFA'] }]) {
      f.currentApplicant.mockResolvedValueOnce(current as never);
      expect(result((await f.handler(event('GET /clinical-core/workforce/applications'))).body)).toEqual({ error: 'workforce_applicant_refused' });
    }
    // A direct Cognito sign-up outside the fictional qualification attestation never reaches the account read.
    const direct = await f.handler(event('GET /clinical-core/workforce/applications',undefined,{ 'custom:synthetic_attested': 'false' }));
    expect(result(direct.body)).toEqual({ error: 'workforce_applicant_refused' });
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it('a retried submission converges on the same request; a second one while one is pending is named, not an outage', async () => {
    const f = withRows([pendingRow()]);
    const retry = await f.handler(event('POST /clinical-core/workforce/applications',{ requestId,kind: 'join',organizationId: organization }));
    expect(retry.statusCode).toBe(202);
    const second = await f.handler(event('POST /clinical-core/workforce/applications',{ requestId: randomUUID(),kind: 'join',organizationId: organization }));
    expect(second.statusCode).toBe(409);
    expect(result(second.body)).toEqual({ error: 'workforce_application_already_pending',requestId });
    expect(f.store.submit).toHaveBeenCalledTimes(1);
  });

  it('a withdrawal answers from the applicant\'s own request: unknown, already withdrawn, already decided', async () => {
    const other = randomUUID();
    const f = withRows([{ ...pendingRow(other),status: 'withdrawn' },{ ...pendingRow(),status: 'rejected',decisionReason: 'not_known_to_clinic' }]);
    expect((await f.handler(event('POST /clinical-core/workforce/applications/withdraw',{ requestId: randomUUID() }))).statusCode).toBe(404);
    expect(result((await f.handler(event('POST /clinical-core/workforce/applications/withdraw',{ requestId: other }))).body)).toEqual({ data: { withdrawn: true,duplicate: true } });
    expect((await f.handler(event('POST /clinical-core/workforce/applications/withdraw',{ requestId }))).statusCode).toBe(409);
    expect(f.store.withdraw).not.toHaveBeenCalled();
  });

  it('projects status strictly: a parent row\'s approval reads unknown access, and any extra field is refused', async () => {
    const approved = { ...pendingRow(),status: 'approved' };
    const parent = await withRows([approved]).handler(event('GET /clinical-core/workforce/applications'));
    expect(result(parent.body)).toEqual({ data: [{ ...approved,decisionReason: null,clinicalAccess: 'unknown' }] });
    for (const rows of [[{ ...approved,email_sha256: 'a'.repeat(64) }],[{ ...pendingRow(),clinicalAccess: 'available' }],
      Array.from({ length: 51 },() => pendingRow(randomUUID()))]) {
      const answer = await withRows(rows).handler(event('GET /clinical-core/workforce/applications'));
      expect(answer.statusCode).toBe(503);
      expect(answer.body).toBe('{"error":"workforce_application_unavailable"}');
    }
  });

  it('asks the shared abuse boundary first, with digests only, and fails closed when it cannot answer', async () => {
    const decide = vi.fn(async () => 'limited' as const);
    const limited = withRows([pendingRow()],{ active: true,decide });
    const answer = await limited.handler({ ...event('GET /clinical-core/workforce/applications'),
      requestContext: { ...event('GET /clinical-core/workforce/applications').requestContext,http: { sourceIp: '198.51.100.7' } } as never });
    expect(answer.statusCode).toBe(429);
    expect(limited.currentApplicant).not.toHaveBeenCalled();
    const [surface,keys] = decide.mock.calls[0] as unknown as [string,Record<string,string>];
    expect(surface).toBe('workforce_application_status');
    expect(Object.keys(keys).sort()).toEqual(['client','subject']);
    for (const value of Object.values(keys)) expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(keys)).not.toContain(subject);
    expect(JSON.stringify(keys)).not.toContain('198.51.100.7');
    const down = withRows([],{ active: true,decide: async () => 'unavailable' as const });
    expect((await down.handler(event('POST /clinical-core/workforce/applications',{ requestId,kind: 'join',organizationId: organization }))).statusCode).toBe(503);
    expect(down.store.submit).not.toHaveBeenCalled();
  });

  it('writes nothing to the logs on any path', async () => {
    const spies = (['log','info','warn','error','debug'] as const).map(name => vi.spyOn(console,name).mockImplementation(() => {}));
    try {
      const f = withRows([pendingRow()]);
      vi.mocked(f.store.submit).mockRejectedValue(new Error(`detail with ${email}`));
      await f.handler(event('POST /clinical-core/workforce/applications',{ requestId,kind: 'create_clinic',proposedLabel: 'Fictional Proposed Clinic' }));
      await f.handler(event('GET /clinical-core/workforce/applications'));
      f.currentApplicant.mockRejectedValueOnce(new Error(`provider said ${email}`));
      await f.handler(event('GET /clinical-core/workforce/applications'));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
});
