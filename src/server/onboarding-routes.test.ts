import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two Desktop onboarding routes: the applicant's own application (no clinic, ever) and a clinic administrator's
// join-request review (gated, current membership only). The real routes, session, selection, fence and family gate;
// only the browser's cookies and headers and the network are faked. Fictional identifiers and addresses only.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find(cookie => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter(cookie => cookie.name === name) : browser.cookies),
  }),
  headers: async () => browser.headers,
}));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
const discovery = vi.hoisted(() => vi.fn());
vi.mock('@/server/clinic-choices', () => ({ clinicChoices: discovery }));

import { GET as readApplication, POST as writeApplication } from '@/app/api/onboarding/application/route';
import { GET as listJoinRequests, POST as decideJoinRequest } from '@/app/api/live/org/join-requests/route';

const ORIGIN = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const HEADER = 'x-alp-selected-organization-id';
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const clinicA = randomUUID(), sub = randomUUID(), request = randomUUID();
const EMAIL = 'fictional.applicant@example.test';
const idToken = (subject: string) => [{ alg: 'RS256' }, { sub: subject, token_use: 'id' }]
  .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fictional';
const binding = (subject: string) => createHash('sha256').update(`aidp-selected-clinic/1|${subject}`).digest('hex');
const tabToken = (subject: string, organizationId: string) => 'v1.' + createHash('sha256')
  .update(`aidp-expected-clinic/1|${subject}|${organizationId}`).digest('base64url').slice(0, 32);
const signIn = (selectedClinic: string | null) => {
  browser.cookies = [{ name: 'aidp_at', value: idToken(sub) }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) },
    { name: 'aidp_em', value: EMAIL }, ...(selectedClinic ? [{ name: 'aidp_org', value: selectedClinic }, { name: 'aidp_org_sub', value: binding(sub) }] : [])];
};
const get = (path: string) => new Request(`http://0.0.0.0:3000${path}`, { headers: { host } });
const post = (path: string, body: unknown, extra: Record<string, string> = {}) => new Request(`http://0.0.0.0:3000${path}`, { method: 'POST',
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const row = (status = 'pending', extra: Record<string, unknown> = {}) => ({ id: request, kind: 'join', status, createdAt: '2026-10-15T12:00:00Z', organizationId: clinicA, ...extra });

let fetchMock: ReturnType<typeof vi.fn>;
let logs: Array<ReturnType<typeof vi.spyOn>>;
const sentHeaders = () => (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([, init]) => init.headers as Record<string, string>);
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
  browser.headers = new Headers();
});
afterEach(() => {
  // Nothing on any of these paths writes a log line: no address, no clinic name, no request.
  for (const spy of logs) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; discovery.mockReset();
});

describe('the applicant\'s own application', () => {
  beforeEach(() => { vi.stubEnv('WORKFORCE_APPLICATIONS_API_ORIGIN', ORIGIN); signIn(null); });

  it('with no service configured, says so for every action and calls nothing', async () => {
    vi.stubEnv('WORKFORCE_APPLICATIONS_API_ORIGIN', '');
    for (const answer of [await readApplication(get('/api/onboarding/application')),
      await writeApplication(post('/api/onboarding/application', { action: 'submit', requestId: request, kind: 'join', organizationId: clinicA }))]) {
      expect(answer.status).toBe(503);
      expect(await answer.json()).toEqual({ error: 'application_service_not_configured' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a signed-out request before anything is sent', async () => {
    browser.cookies = [];
    expect((await readApplication(get('/api/onboarding/application'))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the session token and never a clinic, even when the session has selected one', async () => {
    signIn(clinicA);
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    fetchMock.mockResolvedValue(Response.json({ data: [row('approved', { clinicalAccess: 'available', decisionReason: 'identity_confirmed_by_clinic' })] }));
    discovery.mockResolvedValue({ clinics: [{ organizationId: clinicA, name: 'FICTIONAL CLINIC A', slug: clinicA, role: 'practitioner' }], pending: [] });
    const answer = await readApplication(get('/api/onboarding/application'));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual({ data: { entries: [row('approved', { clinicalAccess: 'available', decisionReason: 'identity_confirmed_by_clinic' })],
      clinicSignIn: 'current_membership', clinicIds: [clinicA] } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/clinical-core/workforce/applications`);
    expect(Object.keys(init.headers as Record<string, string>).map(key => key.toLowerCase())).toEqual(['authorization']);
    expect(JSON.stringify(init.headers)).not.toContain(clinicA);
  });

  it('under the legacy sign-in says so, so an approval is never shown as access', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [row('approved', { clinicalAccess: 'available' })] }));
    expect((await (await readApplication(get('/api/onboarding/application'))).json()).data).toMatchObject({ clinicSignIn: 'legacy_claims', clinicIds: null });
    expect(discovery).not.toHaveBeenCalled();
  });

  it('refuses an answer with fields the contract does not know, and passes only named refusals', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [row('pending', { email_sha256: 'a'.repeat(64) })] }));
    expect((await readApplication(get('/api/onboarding/application'))).status).toBe(503);
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'workforce_applicant_mfa_required' }, { status: 403 }));
    const mfa = await readApplication(get('/api/onboarding/application'));
    expect([mfa.status, await mfa.json()]).toEqual([403, { error: 'workforce_applicant_mfa_required' }]);
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'select * from clinical_private.workforce_access_requests' }, { status: 403 }));
    expect(await (await readApplication(get('/api/onboarding/application'))).json()).toEqual({ error: 'workforce_application_unavailable' });
    fetchMock.mockRejectedValueOnce(new Error(`network detail ${EMAIL}`));
    expect(await (await readApplication(get('/api/onboarding/application'))).json()).toEqual({ error: 'workforce_application_unavailable' });
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(70_000), { headers: { 'content-type': 'application/json' } }));
    expect((await readApplication(get('/api/onboarding/application'))).status).toBe(503);
  });

  it('forwards exactly the submission, and reports a retry\'s pending request instead of an outage', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { requestId: request, status: 'pending' } }, { status: 202 }));
    const sent = await writeApplication(post('/api/onboarding/application', { action: 'submit', requestId: request, kind: 'create_clinic', proposedLabel: '  Fictional New Clinic  ' }));
    expect([sent.status, await sent.json()]).toEqual([202, { data: { requestId: request, status: 'pending' } }]);
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ requestId: request, kind: 'create_clinic', proposedLabel: 'Fictional New Clinic' });
    const other = randomUUID();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'workforce_application_already_pending', requestId: request }, { status: 409 }));
    const second = await writeApplication(post('/api/onboarding/application', { action: 'submit', requestId: other, kind: 'join', organizationId: clinicA }));
    expect([second.status, await second.json()]).toEqual([409, { error: 'workforce_application_already_pending', requestId: request }]);
  });

  it('refuses a browser-supplied identity, role, clinic authority or flag, a cross-origin post, and an oversized body, sending nothing', async () => {
    for (const body of [
      { action: 'submit', requestId: request, kind: 'join', organizationId: clinicA, personId: randomUUID() },
      { action: 'submit', requestId: request, kind: 'join', organizationId: clinicA, role: 'owner' },
      { action: 'submit', requestId: request, kind: 'join', organizationId: clinicA, productionBound: true },
      { action: 'submit', requestId: request, kind: 'join', organizationId: clinicA, email: EMAIL },
      { action: 'approve', requestId: request },
      { action: 'submit', requestId: 'not-a-uuid', kind: 'join', organizationId: clinicA },
      { action: 'submit', requestId: request, kind: 'create_clinic', proposedLabel: 'x'.repeat(121) },
      { action: 'withdraw', requestId: request, subject: sub },
    ]) expect((await writeApplication(post('/api/onboarding/application', body))).status).toBe(400);
    expect((await writeApplication(post('/api/onboarding/application', { action: 'withdraw', requestId: request }, { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await writeApplication(post('/api/onboarding/application', { action: 'submit', requestId: request, kind: 'create_clinic', proposedLabel: 'x'.repeat(3000) }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a clinic administrator\'s join-request review', () => {
  const LISTED = { action: 'list', requests: [{ id: request, status: 'pending', createdAt: '2026-10-15T12:00:00Z', decidedAt: null, decisionReason: null, membershipId: null }] };
  beforeEach(() => {
    vi.stubEnv('WORKFORCE_JOIN_REVIEW_API_ORIGIN', ORIGIN);
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', 'workforce_join_review');
    signIn(clinicA);
    browser.headers = new Headers({ 'x-aidp-expected-clinic': tabToken(sub, clinicA) });
    fetchMock.mockImplementation(async () => Response.json({ data: LISTED }, { headers: { [HEADER]: clinicA } }));
  });

  it('does not exist under the legacy sign-in, and stays refused until the deployment pairs the family', async () => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', '');
    expect(await (await listJoinRequests(get('/api/live/org/join-requests'))).json()).toEqual({ error: 'membership_authority_not_configured' });
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
    for (const families of ['', 'care_messages', 'WORKFORCE_JOIN_REVIEW', 'workforce_join_review,unknown']) {
      vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', families);
      const answer = await listJoinRequests(get('/api/live/org/join-requests'));
      expect([answer.status, await answer.json()]).toEqual([503, { error: 'membership_authority_not_configured' }]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the session\'s own clinic, and accepts only an answer that names it', async () => {
    const listed = await listJoinRequests(get('/api/live/org/join-requests'));
    expect([listed.status, await listed.json()]).toEqual([200, { data: LISTED }]);
    expect(sentHeaders()[0]![HEADER]).toBe(clinicA);
    fetchMock.mockImplementationOnce(async () => Response.json({ data: LISTED }));
    expect(await (await listJoinRequests(get('/api/live/org/join-requests'))).json()).toEqual({ error: 'membership_authority_not_configured' });
    fetchMock.mockImplementationOnce(async () => Response.json({ data: LISTED }, { headers: { [HEADER]: randomUUID() } }));
    expect((await listJoinRequests(get('/api/live/org/join-requests'))).status).toBe(503);
  });

  it('a stale tab is refused as "clinic changed" before its body is read, and nothing is sent', async () => {
    browser.headers = new Headers({ 'x-aidp-expected-clinic': tabToken(sub, randomUUID()) });
    const stale = await decideJoinRequest(post('/api/live/org/join-requests', { action: 'reject', requestId: request, reason: 'not_known_to_clinic' }));
    expect([stale.status, await stale.json()]).toEqual([409, { error: 'clinic_selection_changed' }]);
    signIn(null); browser.headers = new Headers();
    expect((await decideJoinRequest(post('/api/live/org/join-requests', { action: 'reject', requestId: request, reason: 'not_known_to_clinic' }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards an approval with the address only to the review service, and passes only named refusals', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'applicant_mismatch' }, { status: 422, headers: { [HEADER]: clinicA } }));
    const mismatch = await decideJoinRequest(post('/api/live/org/join-requests', { action: 'approve', requestId: request, applicantEmail: ` ${EMAIL.toUpperCase()} ` }));
    expect([mismatch.status, await mismatch.json()]).toEqual([422, { error: 'applicant_mismatch' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/clinical-core/workforce/join-requests/decisions`);
    expect(JSON.parse(init.body as string)).toEqual({ action: 'approve', requestId: request, applicantEmail: EMAIL });
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'workforce_review_conflict detail' }, { status: 409 }));
    expect(await (await decideJoinRequest(post('/api/live/org/join-requests', { action: 'reject', requestId: request, reason: 'duplicate_request' }))).json()).toEqual({ error: 'service_unavailable' });
    for (const body of [{ action: 'approve', requestId: request }, { action: 'reject', requestId: request, reason: 'free text reason' },
      { action: 'list' }, { action: 'revoke', membershipId: randomUUID(), reason: 'left_clinic', organizationId: clinicA },
      { action: 'approve', requestId: request, applicantEmail: EMAIL, role: 'owner' }]) {
      expect((await decideJoinRequest(post('/api/live/org/join-requests', body))).status).toBe(400);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a lost reply is never shown as a decision', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const lost = await decideJoinRequest(post('/api/live/org/join-requests', { action: 'reject', requestId: request, reason: 'clinic_not_accepting' }));
    expect([lost.status, await lost.json()]).toEqual([503, { error: 'service_unavailable' }]);
    // The retry is the same decision; the service answers the recorded one.
    fetchMock.mockImplementationOnce(async () => Response.json({ data: { action: 'reject', requestId: request, status: 'rejected', reason: 'clinic_not_accepting', duplicate: true } }, { headers: { [HEADER]: clinicA } }));
    expect(await (await decideJoinRequest(post('/api/live/org/join-requests', { action: 'reject', requestId: request, reason: 'clinic_not_accepting' }))).json())
      .toEqual({ data: { action: 'reject', requestId: request, status: 'rejected', reason: 'clinic_not_accepting', duplicate: true } });
  });
});
