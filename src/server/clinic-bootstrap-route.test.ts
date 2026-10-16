import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Desktop's new-clinic route (workforce-clinic-bootstrap/1): held by its own release first, then a strict body
// (a request id and a name, nothing else), only the session token upstream, named refusals, and an answer that must be
// this request's. The real route, session and shared upstream; only cookies, headers, the release constant and the
// network are faked. Fictional identifiers only.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find(cookie => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter(cookie => cookie.name === name) : browser.cookies),
  }),
  headers: async () => browser.headers,
}));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
const release = vi.hoisted(() => ({ value: 'blocked' as 'blocked' | 'qualification' }));
vi.mock('@/server/clinic-bootstrap-release', () => ({ get DESKTOP_CLINIC_BOOTSTRAP_RELEASE() { return release.value; } }));
const discovery = vi.hoisted(() => vi.fn());
vi.mock('@/server/clinic-choices', () => ({ clinicChoices: discovery }));

import { GET as readClinic, POST as createClinic } from '@/app/api/onboarding/clinic-bootstrap/route';

const ORIGIN = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const sub = randomUUID(), otherSub = randomUUID(), requestId = randomUUID(), clinic = randomUUID(), membership = randomUUID(), clinicA = randomUUID();
const idToken = (subject: string) => [{ alg: 'RS256' }, { sub: subject, token_use: 'id' }]
  .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fictional';
const binding = (subject: string) => createHash('sha256').update(`aidp-selected-clinic/1|${subject}`).digest('hex');
const signIn = (subject = sub, selectedClinic: string | null = null) => {
  browser.cookies = [{ name: 'aidp_at', value: idToken(subject) }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) },
    { name: 'aidp_em', value: 'fictional.founder@example.test' },
    ...(selectedClinic ? [{ name: 'aidp_org', value: selectedClinic }, { name: 'aidp_org_sub', value: binding(subject) }] : [])];
};
const PATH = '/api/onboarding/clinic-bootstrap';
const get = () => new Request(`http://0.0.0.0:3000${PATH}`, { headers: { host } });
const post = (body: unknown, extra: Record<string, string> = {}) => new Request(`http://0.0.0.0:3000${PATH}`, { method: 'POST',
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body) });
const answer = (extra: Record<string, unknown> = {}) => ({ requestId, organizationId: clinic, membershipId: membership, status: 'active',
  clinicalAccess: 'available', duplicate: false, ...extra });

let fetchMock: ReturnType<typeof vi.fn>;
let logs: Array<ReturnType<typeof vi.spyOn>>;
const sent = () => (fetchMock.mock.calls as Array<[string, RequestInit]>);
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
  vi.stubEnv('WORKFORCE_APPLICATIONS_API_ORIGIN', ORIGIN);
  release.value = 'qualification';
  signIn();
});
afterEach(() => {
  for (const spy of logs) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; discovery.mockReset();
});

describe('the new-clinic route is held before anything is read', () => {
  it('ships blocked', async () => {
    const shipped = await vi.importActual<typeof import('@/server/clinic-bootstrap-release')>('@/server/clinic-bootstrap-release');
    expect(shipped.DESKTOP_CLINIC_BOOTSTRAP_RELEASE).toBe('blocked');
  });

  it('blocked: both reads and creations answer not released, with no session read, no count and no request', async () => {
    release.value = 'blocked';
    browser.cookies = [];
    for (const reply of [await readClinic(get()), await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' })),
      await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC', organizationId: clinicA }))]) {
      expect(reply.status).toBe(503);
      expect(await reply.json()).toEqual({ error: 'workforce_clinic_bootstrap_not_released' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no service configured, says so (not "no clinic") and asks nothing', async () => {
    vi.stubEnv('WORKFORCE_APPLICATIONS_API_ORIGIN', 'http://127.0.0.1:3999');
    const reply = await readClinic(get());
    expect(reply.status).toBe(503);
    expect(await reply.json()).toEqual({ error: 'application_service_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a signed-out request and a cross-site one before anything is sent', async () => {
    browser.cookies = [];
    expect((await readClinic(get())).status).toBe(401);
    signIn();
    expect((await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the browser names a request id and a clinic name, and nothing else', () => {
  it.each([
    ['an existing clinic', { organizationId: clinicA }], ['a person', { personId: randomUUID() }], ['a role', { role: 'owner' }],
    ['a subject', { subject: otherSub }], ['an address', { email: 'other@example.test' }], ['an assurance', { assurance: 'verified_email_and_mfa' }],
    ['a production flag', { production: true }], ['a membership', { membershipId: membership }],
  ])('a body that names %s is a 400 and nothing is sent', async (_label, extra) => {
    const reply = await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC', ...extra }));
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({ error: 'request_invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([['a short name', { requestId, clinicLabel: 'AB' }], ['a control character', { requestId, clinicLabel: 'FICTIONAL\u0007CLINIC' }],
    ['no request id', { clinicLabel: 'FICTIONAL CLINIC' }], ['a non-UUID request id', { requestId: 'retry-1', clinicLabel: 'FICTIONAL CLINIC' }]])(
    '%s is a 400 and nothing is sent', async (_label, body) => {
      expect((await createClinic(post(body))).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('an oversized or non-JSON body is a 400 and nothing is sent', async () => {
    expect((await createClinic(post({ requestId, clinicLabel: 'X'.repeat(2000) }))).status).toBe(400);
    expect((await createClinic(post('requestId=1', { 'content-type': 'application/x-www-form-urlencoded' }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the session token and the strict body, never the selected clinic or a cookie', async () => {
    signIn(sub, clinicA);
    fetchMock.mockResolvedValue(Response.json({ data: answer() }, { status: 201 }));
    const reply = await createClinic(post({ requestId: requestId.toUpperCase(), clinicLabel: '  FICTIONAL NEW CLINIC  ' }));
    expect(reply.status).toBe(201);
    expect(await reply.json()).toEqual({ data: answer() });
    const [[url, init]] = sent();
    expect(url).toBe(`${ORIGIN}/clinical-core/workforce/clinic-bootstrap`);
    expect(JSON.parse(String(init.body))).toEqual({ requestId, clinicLabel: 'FICTIONAL NEW CLINIC' });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['authorization', 'content-type']);
    expect(JSON.stringify(init)).not.toContain(clinicA);
  });
});

describe('answers', () => {
  it('a lost-reply retry is the same request: the service\'s duplicate answer is a 200 with the same clinic', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: answer({ duplicate: true }) }, { status: 200 }));
    const reply = await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ data: answer({ duplicate: true }) });
  });

  it('an answer for another request, or a malformed one, is not passed on', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: answer({ requestId: randomUUID() }) }, { status: 201 }));
    expect((await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }))).status).toBe(503);
    fetchMock.mockResolvedValueOnce(Response.json({ data: { ...answer(), role: 'owner' } }, { status: 201 }));
    expect((await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }))).status).toBe(503);
  });

  it.each([
    [409, 'workforce_clinic_bootstrap_exists'], [409, 'workforce_clinic_bootstrap_conflict'], [409, 'workforce_application_already_pending'],
    [403, 'workforce_applicant_mfa_required'], [403, 'workforce_applicant_email_unverified'], [403, 'workforce_applicant_refused'],
    [429, 'workforce_application_rate_limited'], [503, 'workforce_clinic_bootstrap_not_released'], [503, 'identity_unavailable'],
  ])('the service\'s %i %s reaches the browser by name, and nothing else', async (status, error) => {
    fetchMock.mockResolvedValue(Response.json({ error, requestId: randomUUID(), detail: 'fictional upstream detail' }, { status }));
    const reply = await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    expect(reply.status).toBe(status);
    expect(await reply.json()).toEqual({ error });
  });

  it('an unlisted error, an outage or non-JSON is "unavailable", with no upstream text', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'relation "workforce_identity_directory" violates unique constraint' }, { status: 500 }));
    const first = await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    expect([first.status, await first.json()]).toEqual([503, { error: 'workforce_application_unavailable' }]);
    fetchMock.mockRejectedValueOnce(new Error('fictional network failure'));
    expect((await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }))).status).toBe(503);
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await readClinic(get())).status).toBe(503);
  });

  it('the read: no clinic yet is null (an answer), and a created clinic says whether it is among this session\'s clinics', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: null }));
    expect(await (await readClinic(get())).json()).toEqual({ data: { clinic: null, clinicSignIn: 'legacy_claims', inSession: null } });
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    const state = { requestId, organizationId: clinic, status: 'active', suspensionReason: null, clinicalAccess: 'available', createdAt: '2026-10-16T00:00:00Z' };
    fetchMock.mockResolvedValueOnce(Response.json({ data: state }));
    discovery.mockResolvedValueOnce({ clinics: [{ organizationId: clinic, name: 'FICTIONAL NEW CLINIC', slug: clinic, role: 'owner' }], pending: [] });
    expect(await (await readClinic(get())).json()).toEqual({ data: { clinic: state, clinicSignIn: 'current_membership', inSession: true } });
    fetchMock.mockResolvedValueOnce(Response.json({ data: state }));
    discovery.mockRejectedValueOnce(new Error('clinic_discovery_unavailable'));
    expect(await (await readClinic(get())).json()).toEqual({ data: { clinic: state, clinicSignIn: 'current_membership', inSession: null } });
  });

  it('a suspended clinic is reported with its reason and no access; the session is not asked about it', async () => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    const state = { requestId, organizationId: clinic, status: 'suspended', suspensionReason: 'security_concern', clinicalAccess: 'not_available', createdAt: '2026-10-16T00:00:00Z' };
    fetchMock.mockResolvedValue(Response.json({ data: state }));
    expect(await (await readClinic(get())).json()).toEqual({ data: { clinic: state, clinicSignIn: 'current_membership', inSession: null } });
    expect(discovery).not.toHaveBeenCalled();
  });

  it('an account switch: each request carries the account signed in now, never the previous one', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'workforce_clinic_bootstrap_conflict' }, { status: 409 }));
    signIn(otherSub);
    await createClinic(post({ requestId, clinicLabel: 'FICTIONAL CLINIC' }));
    const [[, init]] = sent();
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${idToken(otherSub)}`);
    expect(JSON.stringify(init)).not.toContain(sub);
  });
});
