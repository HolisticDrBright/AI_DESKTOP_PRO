import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { createWorkforceApplicationsCandidate, type WorkforceApplicationStore } from './aws-workforce-applications-api';
import { ClinicalCoreDatabaseRejection } from './database';
import { BOOTSTRAP_ASSURANCE, createClinicBootstrapSuspension, WORKFORCE_CLINIC_BOOTSTRAP_RELEASE,
  type ClinicBootstrapStore } from './workforce-clinic-bootstrap';

/**
 * The new-clinic door through the applicant API: blocked by default, refused before anything is read; once released in
 * a fictional qualification, the subject and address come only from the token and the current account, retries and
 * account switches are the database's to decide, and the browser can name no clinic, person or role. Fictional values.
 */
const ACCOUNT = '588966314750';
const ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_ueGlFRbNB';
const AUDIENCE = '4s7jgr4o8sqdq7cvo9gmq96e2h';
const ROUTE = 'POST /clinical-core/workforce/clinic-bootstrap';
const subjectA = randomUUID(), subjectB = randomUUID(), requestId = randomUUID(), organization = randomUUID(), membership = randomUUID();
const emailA = 'fictional.founder.a@example.invalid', emailB = 'fictional.founder.b@example.invalid';
const digest = (email: string) => createHash('sha256').update(email).digest('hex');

function event(routeKey: string, body?: Record<string, unknown>, who: { sub: string; email: string } = { sub: subjectA, email: emailA }): ApiGatewayV2Event {
  return { routeKey, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    requestContext: { accountId: ACCOUNT, authorizer: { jwt: { claims: { iss: ISSUER, aud: AUDIENCE, token_use: 'id', sub: who.sub,
      email: who.email, email_verified: 'true', 'custom:synthetic_attested': 'true' } } } } };
}
function setup(options: { bootstrap?: 'blocked' | 'qualification' | 'absent'; mfa?: string[] } = {}) {
  const accounts: Record<string, string> = { [subjectA]: emailA, [subjectB]: emailB };
  const currentApplicant = vi.fn(async (subject: string) => ({ subject, email: accounts[subject]!, emailVerified: true, enabled: true,
    mfaMethods: options.mfa ?? ['SOFTWARE_TOKEN_MFA'] }));
  const store: WorkforceApplicationStore = { submit: vi.fn(async ({ requestId: id }) => id), list: vi.fn(async () => []), withdraw: vi.fn(async () => {}) };
  const bootstrapStore: ClinicBootstrapStore = {
    bootstrap: vi.fn(async input => ({ requestId: input.requestId, organizationId: organization, membershipId: membership,
      status: 'active' as const, clinicalAccess: 'available' as const, duplicate: false })),
    state: vi.fn(async () => null),
  };
  const handler = createWorkforceApplicationsCandidate({
    configuration: { activation: 'qualification', phiAllowed: false, accountId: ACCOUNT, issuer: ISSUER, audience: AUDIENCE, reviewEvidenceSha256: 'a'.repeat(64) },
    currentApplicant, store,
    ...(options.bootstrap === 'absent' ? {} : { clinicBootstrap: { store: bootstrapStore, ...(options.bootstrap ? { release: options.bootstrap } : {}) } }),
  });
  return { handler, currentApplicant, bootstrapStore };
}
const body = (reply: { body: string }) => JSON.parse(reply.body) as Record<string, unknown>;

describe('the new-clinic bootstrap route', () => {
  it('ships blocked: refused before the account, the abuse counter or the database is read', async () => {
    expect(WORKFORCE_CLINIC_BOOTSTRAP_RELEASE).toBe('blocked');
    for (const mode of [undefined, 'blocked', 'absent'] as const) {
      const f = setup({ bootstrap: mode });
      for (const route of [ROUTE, 'GET /clinical-core/workforce/clinic-bootstrap']) {
        const reply = await f.handler(event(route, route === ROUTE ? { requestId, clinicLabel: 'FICTIONAL CLINIC' } : undefined));
        expect(reply.statusCode).toBe(503);
        expect(body(reply)).toEqual({ error: 'workforce_clinic_bootstrap_not_released' });
      }
      expect(f.currentApplicant).not.toHaveBeenCalled();
      expect(f.bootstrapStore.bootstrap).not.toHaveBeenCalled();
    }
  });

  it('released in a fictional qualification: the subject and address come from the token and the current account only', async () => {
    const f = setup({ bootstrap: 'qualification' });
    const reply = await f.handler(event(ROUTE, { requestId, clinicLabel: '  FICTIONAL NEW CLINIC  ' }));
    expect(reply.statusCode).toBe(201);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(f.currentApplicant).toHaveBeenCalledWith(subjectA);
    expect(f.bootstrapStore.bootstrap).toHaveBeenCalledWith({ requestId, subject: subjectA, emailSha256: digest(emailA),
      clinicLabel: 'FICTIONAL NEW CLINIC', assurance: BOOTSTRAP_ASSURANCE });
    expect(body(reply)).toEqual({ data: { requestId, organizationId: organization, membershipId: membership, status: 'active', clinicalAccess: 'available', duplicate: false } });
  });

  it.each([
    ['an existing clinic', { organizationId: organization }], ['a person', { personId: randomUUID() }], ['a role', { role: 'owner' }],
    ['a subject', { subject: subjectB }], ['a production flag', { production: true }], ['an assurance', { assurance: BOOTSTRAP_ASSURANCE }],
  ])('refuses a body that names %s, with nothing sent', async (_label, extra) => {
    const f = setup({ bootstrap: 'qualification' });
    const reply = await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC', ...extra }));
    expect(reply.statusCode).toBe(400);
    expect(f.bootstrapStore.bootstrap).not.toHaveBeenCalled();
  });

  it('an account without an active MFA method is told so, and nothing is created', async () => {
    const f = setup({ bootstrap: 'qualification', mfa: [] });
    const reply = await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    expect(reply.statusCode).toBe(403);
    expect(body(reply)).toEqual({ error: 'workforce_applicant_mfa_required' });
    expect(f.bootstrapStore.bootstrap).not.toHaveBeenCalled();
  });

  it('MFA removed after the clinic was created: the next status read and a retry are refused by name, reading no row', async () => {
    const f = setup({ bootstrap: 'qualification' });
    expect((await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }))).statusCode).toBe(201);
    // The account's factor is removed in the identity provider; the service reads the current account every time.
    f.currentApplicant.mockImplementation(async subject => ({ subject, email: emailA, emailVerified: true, enabled: true, mfaMethods: [] }));
    for (const reply of [await f.handler(event('GET /clinical-core/workforce/clinic-bootstrap')),
      await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }))]) {
      expect(reply.statusCode).toBe(403);
      expect(body(reply)).toEqual({ error: 'workforce_applicant_mfa_required' });
    }
    expect(f.bootstrapStore.bootstrap).toHaveBeenCalledTimes(1);
    expect(f.bootstrapStore.state).not.toHaveBeenCalled();
  });

  it('a lost-reply retry is answered 200 with the same clinic', async () => {
    const f = setup({ bootstrap: 'qualification' });
    vi.mocked(f.bootstrapStore.bootstrap).mockResolvedValueOnce({ requestId, organizationId: organization, membershipId: membership,
      status: 'active', clinicalAccess: 'available', duplicate: true });
    const reply = await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    expect(reply.statusCode).toBe(200);
    expect(body(reply)).toMatchObject({ data: { organizationId: organization, duplicate: true } });
  });

  it('an account switch before the retry sends the new account, never the old one, and the database\'s conflict is a 409', async () => {
    const f = setup({ bootstrap: 'qualification' });
    vi.mocked(f.bootstrapStore.bootstrap).mockRejectedValueOnce(new ClinicalCoreDatabaseRejection('conflict', 'workforce_bootstrap_conflict'));
    const reply = await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }, { sub: subjectB, email: emailB }));
    expect(f.bootstrapStore.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ subject: subjectB, emailSha256: digest(emailB) }));
    expect(f.bootstrapStore.bootstrap).not.toHaveBeenCalledWith(expect.objectContaining({ subject: subjectA }));
    expect(reply.statusCode).toBe(409);
    expect(body(reply)).toEqual({ error: 'workforce_clinic_bootstrap_conflict' });
  });

  it.each([
    ['workforce_clinic_bootstrap_exists', 409, 'workforce_clinic_bootstrap_exists'],
    ['workforce_request_pending', 409, 'workforce_application_already_pending'],
    ['workforce_binding_conflict', 403, 'workforce_applicant_refused'],
    ['workforce_operator_refused', 403, 'workforce_applicant_refused'],
    ['workforce_clinic_bootstrap_not_released', 503, 'workforce_clinic_bootstrap_not_released'],
    [undefined, 503, 'workforce_application_unavailable'],
  ])('maps the database refusal %s to %i %s, with no SQL text', async (reason, status, error) => {
    const f = setup({ bootstrap: 'qualification' });
    vi.mocked(f.bootstrapStore.bootstrap).mockRejectedValueOnce(reason ? new ClinicalCoreDatabaseRejection('operation_refused', reason) : new Error('fictional SQL text with a subject'));
    const reply = await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    expect(reply.statusCode).toBe(status);
    expect(body(reply)).toEqual({ error });
  });

  it('an answer for another request is not passed on', async () => {
    const f = setup({ bootstrap: 'qualification' });
    vi.mocked(f.bootstrapStore.bootstrap).mockResolvedValueOnce({ requestId: randomUUID(), organizationId: organization, membershipId: membership,
      status: 'active', clinicalAccess: 'available', duplicate: false });
    expect((await f.handler(event(ROUTE, { requestId, clinicLabel: 'FICTIONAL CLINIC' }))).statusCode).toBe(503);
  });

  it('the applicant reads only their own bootstrapped clinic', async () => {
    const f = setup({ bootstrap: 'qualification' });
    vi.mocked(f.bootstrapStore.state).mockResolvedValueOnce({ requestId, organizationId: organization, status: 'suspended',
      suspensionReason: 'security_concern', clinicalAccess: 'not_available', createdAt: '2026-10-16T00:00:00Z' });
    const reply = await f.handler(event('GET /clinical-core/workforce/clinic-bootstrap'));
    expect(f.bootstrapStore.state).toHaveBeenCalledWith(subjectA);
    expect(body(reply)).toMatchObject({ data: { organizationId: organization, clinicalAccess: 'not_available' } });
  });
});

describe('the operator\'s suspension of a bootstrapped clinic', () => {
  const database = (data: unknown) => ({ transaction: vi.fn(async (work: (tx: { query: () => Promise<{ rows: unknown[] }> }) => unknown) =>
    work({ query: async () => ({ rows: [{ data }] }) })) });
  it('ships blocked, and takes the operator subject only from the separate operator sign-in', async () => {
    const verifiedOperatorSubject = vi.fn(async () => randomUUID());
    const blocked = createClinicBootstrapSuspension({ database: database(null) as never, verifiedOperatorSubject });
    await expect(blocked('Bearer x', { organizationId: organization, reason: 'security_concern' })).rejects.toMatchObject({ code: 'not_released' });
    expect(verifiedOperatorSubject).not.toHaveBeenCalled();
    const refused = createClinicBootstrapSuspension({ database: database(null) as never, release: 'qualification',
      verifiedOperatorSubject: async () => { throw new Error('workforce token'); } });
    await expect(refused('Bearer x', { organizationId: organization, reason: 'security_concern' })).rejects.toMatchObject({ code: 'operator_refused' });
    await expect(refused('Bearer x', { organizationId: organization, reason: 'because' })).rejects.toMatchObject({ code: 'request_invalid' });
    const released = createClinicBootstrapSuspension({ database: database({ organizationId: organization, status: 'suspended', reason: 'security_concern', duplicate: false }) as never,
      release: 'qualification', verifiedOperatorSubject });
    await expect(released('Bearer x', { organizationId: organization, reason: 'security_concern' })).resolves.toMatchObject({ status: 'suspended' });
  });
});
