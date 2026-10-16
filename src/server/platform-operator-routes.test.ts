import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Desktop's platform operator routes and sign-in: the real routes, session cookies and upstream helper; only the
// cookie jar, the release constant and the network (operator API, Cognito) are faked. Fictional identifiers only.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find(cookie => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter(cookie => cookie.name === name) : browser.cookies),
  }),
  headers: async () => new Headers(),
}));
const release = vi.hoisted(() => ({ value: 'qualification' as 'blocked' | 'qualification' }));
vi.mock('@/server/platform-operator-release', () => ({ get DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE() { return release.value; } }));

import { GET as listProposals, POST as decideProposal } from '@/app/api/operator/clinic-proposals/route';
import { GET as listClinics, POST as suspendClinic } from '@/app/api/operator/bootstrapped-clinics/route';
import { DELETE as signOut, GET as sessionState, POST as signIn } from '@/app/api/operator/session/route';

const OPERATOR_API = 'https://opsconsol1.execute-api.us-east-2.amazonaws.com';
const APPLICANT_API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const OPERATOR_CLIENT = 'o'.repeat(26), WORKFORCE_CLIENT = '4s7jgr4o8sqdq7cvo9gmq96e2h';
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const PRACTITIONER = 'practitioner.id.token', OPERATOR = 'operator.id.token';
const clinic = randomUUID(), request = randomUUID();
const get = (path: string) => new Request(`http://0.0.0.0:3000${path}`, { headers: { host } });
const post = (path: string, body: unknown, extra: Record<string, string> = {}, method = 'POST') => new Request(`http://0.0.0.0:3000${path}`, { method,
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra },
  body: method === 'DELETE' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const practitioner = [{ name: 'aidp_at', value: PRACTITIONER }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) }, { name: 'aidp_org', value: clinic }];
const LISTED = { clinics: [{ organizationId: clinic, clinicLabel: 'FICTIONAL CLINIC', status: 'active', createdAt: '2026-10-16T00:00:00Z', suspendedAt: null,
  suspensionReason: null, events: [{ action: 'bootstrapped', reason: null, occurredAt: '2026-10-16T00:00:00Z', operator: null, byCaller: false }] }] };

let fetchMock: ReturnType<typeof vi.fn>;
let upstream: { status: number; body: unknown };
let cognito: Array<Record<string, unknown>>;
const sent = () => fetchMock.mock.calls as Array<[string, RequestInit]>;
const setCookies = (response: Response) => response.headers.getSetCookie();
beforeEach(() => {
  release.value = 'qualification';
  upstream = { status: 200, body: { data: LISTED } };
  cognito = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('https://cognito-idp.')) {
      const next = cognito.shift() ?? { __status: 400, __type: 'NotAuthorizedException' };
      const { __status, ...body } = next as { __status?: number } & Record<string, unknown>;
      return new Response(JSON.stringify(body), { status: __status ?? 200, headers: { 'content-type': 'application/x-amz-json-1.1' } });
    }
    void init;
    return new Response(JSON.stringify(upstream.body), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PLATFORM_OPERATOR_API_ORIGIN', OPERATOR_API);
  vi.stubEnv('WORKFORCE_APPLICATIONS_API_ORIGIN', APPLICANT_API);
  vi.stubEnv('PLATFORM_OPERATOR_COGNITO_CLIENT_ID', OPERATOR_CLIENT);
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_CLIENT_ID', WORKFORCE_CLIENT);
  browser.cookies = [...practitioner, { name: 'aidp_op', value: OPERATOR }];
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; });

describe('the operator console routes', () => {
  it('ship blocked: every route and the sign-in answer not released, and nothing is read or sent', async () => {
    const shipped = await vi.importActual<typeof import('@/server/platform-operator-release')>('@/server/platform-operator-release');
    expect(shipped.DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE).toBe('blocked');
    release.value = 'blocked';
    for (const reply of [await listProposals(get('/api/operator/clinic-proposals')), await listClinics(get('/api/operator/bootstrapped-clinics')),
      await suspendClinic(post('/api/operator/bootstrapped-clinics', { organizationId: clinic, reason: 'security_concern' })),
      await decideProposal(post('/api/operator/clinic-proposals', { action: 'approve', requestId: request })),
      await sessionState(), await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional' })),
      await signOut(post('/api/operator/session', null, {}, 'DELETE'))]) {
      expect(reply.status).toBe(503);
      expect(await reply.json()).toEqual({ error: 'platform_operator_not_released' });
      expect(setCookies(reply)).toEqual([]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a practitioner session is not an operator session: without the operator cookie nothing is sent', async () => {
    browser.cookies = [...practitioner];
    for (const reply of [await listClinics(get('/api/operator/bootstrapped-clinics')),
      await suspendClinic(post('/api/operator/bootstrapped-clinics', { organizationId: clinic, reason: 'security_concern' }))]) {
      expect(reply.status).toBe(401);
      expect(await reply.json()).toEqual({ error: 'operator_sign_in_required' });
    }
    // Two operator cookies, or a malformed one, are no session either.
    browser.cookies = [...practitioner, { name: 'aidp_op', value: OPERATOR }, { name: 'aidp_op', value: 'other.id.token' }];
    expect((await listClinics(get('/api/operator/bootstrapped-clinics'))).status).toBe(401);
    browser.cookies = [...practitioner, { name: 'aidp_op', value: PRACTITIONER + ' extra' }];
    expect((await listClinics(get('/api/operator/bootstrapped-clinics'))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the operator token to the operator API, never the practitioner token, a cookie or a clinic', async () => {
    const reply = await listClinics(get('/api/operator/bootstrapped-clinics'));
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(await reply.json()).toEqual({ data: LISTED });
    const [url, init] = sent()[0]!;
    expect(url).toBe(`${OPERATOR_API}/clinical-core/platform-operator/bootstrapped-clinics`);
    expect(init.headers).toEqual({ authorization: `Bearer ${OPERATOR}` });
    expect(JSON.stringify(init)).not.toContain(PRACTITIONER);
    expect(JSON.stringify(init)).not.toContain(clinic);
    expect(init.redirect).toBe('error');
  });

  it('is not configured unless the operator API has an execute-api origin of its own', async () => {
    for (const origin of [APPLICANT_API, 'https://operator.example.test', '']) {
      vi.stubEnv('PLATFORM_OPERATOR_API_ORIGIN', origin);
      const reply = await listClinics(get('/api/operator/bootstrapped-clinics'));
      expect(await reply.json()).toEqual({ error: 'operator_service_not_configured' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a decision is same-origin, strict and from the closed lists: anything else is refused and nothing is sent', async () => {
    expect((await suspendClinic(post('/api/operator/bootstrapped-clinics', { organizationId: clinic, reason: 'security_concern' }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    for (const body of [{ organizationId: clinic, reason: 'because' }, { organizationId: clinic, reason: 'security_concern', operatorSubject: randomUUID() },
      { organizationId: clinic, action: 'reinstate' }, 'not json', { organizationId: clinic, reason: 'security_concern', padding: 'x'.repeat(1100) }]) {
      const reply = await suspendClinic(post('/api/operator/bootstrapped-clinics', body));
      expect(reply.status).toBe(400);
    }
    for (const body of [{ action: 'approve', requestId: request, organizationId: clinic }, { action: 'reject', requestId: request }, { action: 'activate', requestId: request }]) {
      expect((await decideProposal(post('/api/operator/clinic-proposals', body))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    upstream = { status: 200, body: { data: { organizationId: clinic, status: 'suspended', reason: 'security_concern', duplicate: false } } };
    const done = await suspendClinic(post('/api/operator/bootstrapped-clinics', { organizationId: clinic.toUpperCase(), reason: 'security_concern' }));
    expect(await done.json()).toEqual({ data: { organizationId: clinic, status: 'suspended', reason: 'security_concern', duplicate: false } });
    expect(JSON.parse(String(sent()[0]![1].body))).toEqual({ organizationId: clinic, reason: 'security_concern' });
  });

  it('an answer outside the contract, or an approval that is not held, is never shown as one', async () => {
    upstream = { status: 200, body: { data: { clinics: [{ ...LISTED.clinics[0], ownerSubject: randomUUID() }] } } };
    expect(await (await listClinics(get('/api/operator/bootstrapped-clinics'))).json()).toEqual({ error: 'platform_operator_unavailable' });
    upstream = { status: 200, body: { data: { action: 'approve', requestId: request, status: 'approved', organizationId: clinic, membershipId: randomUUID(),
      decisionReason: 'clinic_proposal_verified', activation: null, duplicate: false } } };
    expect(await (await decideProposal(post('/api/operator/clinic-proposals', { action: 'approve', requestId: request }))).json()).toEqual({ error: 'platform_operator_unavailable' });
  });

  it('passes the named refusals, ends the operator session when the operator is refused, and hides anything unnamed', async () => {
    upstream = { status: 403, body: { error: 'platform_operator_refused' } };
    const refused = await listClinics(get('/api/operator/bootstrapped-clinics'));
    expect(refused.status).toBe(403);
    expect(setCookies(refused).some(line => /^aidp_op=;/.test(line) && /Path=\/api\/operator/i.test(line) && /Max-Age=0/i.test(line))).toBe(true);
    expect(setCookies(refused).some(line => line.startsWith('aidp_at='))).toBe(false);
    upstream = { status: 403, body: { error: 'operator_self_approval_refused' } };
    expect(await (await suspendClinic(post('/api/operator/bootstrapped-clinics', { organizationId: clinic, reason: 'security_concern' }))).json()).toEqual({ error: 'operator_self_approval_refused' });
    upstream = { status: 500, body: { error: 'database exploded at row 7' } };
    expect(await (await listClinics(get('/api/operator/bootstrapped-clinics'))).json()).toEqual({ error: 'platform_operator_unavailable' });
  });
});

describe('the operator sign-in', () => {
  it('uses the operator pool client only, and refuses a client shared with the practitioner login', async () => {
    vi.stubEnv('PLATFORM_OPERATOR_COGNITO_CLIENT_ID', WORKFORCE_CLIENT);
    expect(await (await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional' }))).json()).toEqual({ error: 'operator_service_not_configured' });
    vi.stubEnv('PLATFORM_OPERATOR_COGNITO_CLIENT_ID', '');
    expect((await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional' }))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a password continues only to the TOTP challenge; the code step writes the 15-minute operator cookie and nothing else', async () => {
    browser.cookies = [...practitioner];
    cognito = [{ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'fictional-cognito-session', ChallengeParameters: { USER_ID_FOR_SRP: 'operator-user' } }];
    const first = await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional' }));
    expect(first.status).toBe(202);
    const [, init] = sent()[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: OPERATOR_CLIENT });
    expect(String(init.body)).not.toContain(WORKFORCE_CLIENT);
    const challengeCookies = setCookies(first);
    expect(challengeCookies.filter(line => /^aidp_op_mf[au]=/.test(line))).toHaveLength(2);
    for (const line of challengeCookies) expect(line).toMatch(/Path=\/api\/operator.*HttpOnly|HttpOnly.*Path=\/api\/operator/i);
    expect(challengeCookies.every(line => /SameSite=strict/i.test(line) && /Max-Age=300/i.test(line))).toBe(true);
    browser.cookies = [...practitioner, { name: 'aidp_op_mfa', value: 'fictional-cognito-session' }, { name: 'aidp_op_mfu', value: 'operator-user' }];
    cognito = [{ AuthenticationResult: { IdToken: 'header.operator-claims.signature', RefreshToken: 'never-kept', AccessToken: 'not-used' } }];
    const second = await signIn(post('/api/operator/session', { code: '123456' }));
    expect(second.status).toBe(200);
    const written = setCookies(second);
    expect(written.find(line => line.startsWith('aidp_op='))).toMatch(/^aidp_op=header\.operator-claims\.signature;.*Max-Age=900/i);
    expect(written.some(line => line.includes('never-kept'))).toBe(false);
    expect(written.some(line => /^aidp_(at|rt|exp|em|org|org_sub)=/.test(line))).toBe(false);
    expect(JSON.parse(String(sent()[1]![1].body))).toMatchObject({ ChallengeName: 'SOFTWARE_TOKEN_MFA', ClientId: OPERATOR_CLIENT, ChallengeResponses: { SOFTWARE_TOKEN_MFA_CODE: '123456' } });
  });

  it.each([
    ['a password that signs in without MFA', { AuthenticationResult: { IdToken: 'a.b.c' } }],
    ['an MFA-setup challenge', { ChallengeName: 'MFA_SETUP', Session: 'fictional' }],
    ['an SMS factor', { ChallengeName: 'SMS_MFA', Session: 'fictional' }],
    ['wrong credentials', { __status: 400, __type: 'NotAuthorizedException' }],
  ])('refuses %s, the same way, and stores nothing', async (_label, answer) => {
    browser.cookies = [];
    cognito = [answer];
    const reply = await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional' }));
    expect(reply.status).toBe(401);
    expect(await reply.json()).toEqual({ error: 'platform_operator_refused' });
    expect(setCookies(reply).every(line => /Max-Age=0/i.test(line))).toBe(true);
  });

  it('a code without a pending challenge, extra fields or a cross-site post go nowhere; sign-out clears only operator cookies', async () => {
    browser.cookies = [...practitioner];
    expect(await (await signIn(post('/api/operator/session', { code: '123456' }))).json()).toEqual({ error: 'operator_sign_in_required' });
    expect((await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional', mfa: 'skip' }))).status).toBe(400);
    expect((await signIn(post('/api/operator/session', { email: 'operator@example.test', password: 'fictional' }, { origin: 'https://example.org' }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    const out = await signOut(post('/api/operator/session', null, {}, 'DELETE'));
    expect(setCookies(out).map(line => line.split('=')[0]).sort()).toEqual(['aidp_op', 'aidp_op_mfa', 'aidp_op_mfu']);
    browser.cookies = [...practitioner, { name: 'aidp_op', value: OPERATOR }];
    expect(await (await sessionState()).json()).toEqual({ data: { signedIn: true, mfaPending: false } });
  });
});
