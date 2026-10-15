import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two gated live routes (care messages, program assignments) under clinic-membership sign-in: the real routes, the
// real session, selection, stale-tab fence and family gate. Only the browser's cookie jar and request headers and the
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

import { POST as careMessages } from '@/app/api/live/care-messages/route';
import { POST as programAssignments } from '@/app/api/live/program-assignments/route';

const ORIGIN = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const HEADER = 'x-alp-selected-organization-id';
const host = 'penrnyupn3.us-east-2.awsapprunner.com';
const clinicA = randomUUID(), clinicB = randomUUID(), subA = randomUUID(), subB = randomUUID();
const connection = randomUUID(), thread = randomUUID();
const idToken = (sub: string) => [{ alg: 'RS256' }, { sub, token_use: 'id' }]
  .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fictional';
const binding = (sub: string) => createHash('sha256').update(`aidp-selected-clinic/1|${sub}`).digest('hex');
const tabToken = (sub: string, organizationId: string) => 'v1.' + createHash('sha256')
  .update(`aidp-expected-clinic/1|${sub}|${organizationId}`).digest('base64url').slice(0, 32);
function session(sub: string, organizations: Array<{ name: string; value: string }>) {
  browser.cookies = [{ name: 'aidp_at', value: idToken(sub) }, { name: 'aidp_exp', value: String(Date.now() + 3_600_000) },
    { name: 'aidp_em', value: 'fictional.practitioner@example.test' }, ...organizations];
}
const selected = (organizationId: string, sub: string) => [{ name: 'aidp_org', value: organizationId }, { name: 'aidp_org_sub', value: binding(sub) }];
const fromTab = (expected: string | null) => { browser.headers = new Headers(expected ? { 'x-aidp-expected-clinic': expected } : {}); };
const post = (path: string, body: unknown) => new Request(`http://0.0.0.0:3000${path}`, { method: 'POST',
  headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const LIST = { action: 'list' };
const REPLY = { action: 'send', requestId: randomUUID(), connectionId: connection, threadId: thread, body: 'FICTIONAL reply', acknowledgement: 'care-messages/1' };
const LISTED = { action: 'list', threads: [], nextBefore: null };
const PROGRAMS = { action: 'programs' };
const PROGRAMS_LISTED = { action: 'programs', programs: [] };
const ROUTES = [
  ['care messages', 'care_messages', (body: unknown) => careMessages(post('/api/live/care-messages', body)), LIST, LISTED],
  ['program assignments', 'program_assignments', (body: unknown) => programAssignments(post('/api/live/program-assignments', body)), PROGRAMS, PROGRAMS_LISTED],
] as const;

let fetchMock: ReturnType<typeof vi.fn>;
let decidedIn: string | null;
let answer: unknown;
const sentClinics = () => (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([, init]) =>
  Object.entries(init.headers as Record<string, string>).filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value));
beforeEach(() => {
  vi.stubEnv('CLINICAL_AWS_WORKFORCE_API_ORIGIN', ORIGIN);
  vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', 'database_current');
  vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', 'care_messages,program_assignments');
  decidedIn = clinicA; answer = LISTED;
  fetchMock = vi.fn(async () => Response.json({ data: answer }, { headers: decidedIn ? { [HEADER]: decidedIn } : {} }));
  vi.stubGlobal('fetch', fetchMock);
  session(subA, selected(clinicA, subA));
  fromTab(tabToken(subA, clinicA));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; browser.headers = new Headers(); });

describe.each(ROUTES)('%s under clinic-membership sign-in', (_label, family, run, request, listed) => {
  beforeEach(() => { answer = listed; });

  it('stays refused, with no request, unless this deployment pairs the family with a current-membership service', async () => {
    for (const families of ['', 'telehealth', `${family},telehealth`, family.toUpperCase()]) {
      vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', families);
      const refused = await run(request);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: 'membership_authority_not_configured' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the session\'s own clinic, once, and the answer carries the tab binding it was produced under', async () => {
    const answered = await run(request);
    expect(answered.status).toBe(200);
    expect(answered.headers.get('x-aidp-clinic-binding')).toBe(tabToken(subA, clinicA));
    expect(sentClinics()).toEqual([[clinicA]]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith(ORIGIN + '/clinical-core/workforce/')).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ' + idToken(subA));
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it('a second tab that switched the session to another clinic leaves this tab refused as clinic changed, before any request', async () => {
    session(subA, selected(clinicB, subA));
    const stale = await run(request);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'clinic_selection_changed' });
    expect(fetchMock).not.toHaveBeenCalled();
    // The tab that made the switch is served in the clinic now selected.
    fromTab(tabToken(subA, clinicB)); decidedIn = clinicB;
    expect((await run(request)).status).toBe(200);
    expect(sentClinics()).toEqual([[clinicB]]);
  });

  it('an account switch, a missing, duplicated or malformed selection is refused before the token leaves', async () => {
    for (const cookies of [selected(clinicA, subB), [], [...selected(clinicA, subA), { name: 'aidp_org', value: clinicB }],
      [{ name: 'aidp_org', value: 'not-a-clinic' }, { name: 'aidp_org_sub', value: binding(subA) }]]) {
      session(subA, cookies);
      fromTab(null);
      const refused = await run(request);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'clinic_selection_required' });
    }
    // Signed in as B over A's selection, from A's tab: A's selection is never reused for B.
    session(subB, selected(clinicA, subA)); fromTab(tabToken(subA, clinicA));
    expect((await run(request)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a body naming a clinic is not a way to choose one: it is refused before any request', async () => {
    const forged = await run({ ...request, organizationId: clinicB });
    expect(forged.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an answer that does not name the selected clinic was not decided by current membership in it, and is refused', async () => {
    for (const named of [null, clinicB]) {
      decidedIn = named;
      const refused = await run(request);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: 'membership_authority_not_configured' });
    }
  });

  it('the service\'s own refusals keep their meaning: revoked or pending membership, a conflict, a stale sign-in, an outage', async () => {
    for (const [status, expected] of [[403, 403], [409, 409], [401, 401], [429, 429], [500, 503], [503, 503]] as const) {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'fictional' }, { status }));
      expect((await run(request)).status).toBe(expected);
    }
    fetchMock.mockRejectedValueOnce(new Error('fictional network failure'));
    expect((await run(request)).status).toBe(503);
  });
});

describe('care messages: retry and cancellation', () => {
  it('an interrupted reply is retried as the same request; the service decides it once', async () => {
    answer = { action: 'send', threadId: thread, messageId: randomUUID(), duplicate: false, status: 'stored', receivedAt: new Date().toISOString() };
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    expect((await careMessages(post('/api/live/care-messages', REPLY))).status).toBe(503);
    expect((await careMessages(post('/api/live/care-messages', REPLY))).status).toBe(200);
    const bodies = (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toEqual([REPLY, REPLY]);
    expect(sentClinics()).toEqual([[clinicA], [clinicA]]);
  });
});

describe('the legacy default', () => {
  it('is unchanged: no selection is read or sent, no binding is returned, and no clinic is required in the answer', async () => {
    vi.stubEnv('CLINICAL_WORKFORCE_AUTHORITY_MODE', '');
    vi.stubEnv('CLINICAL_CURRENT_MEMBERSHIP_FAMILIES', '');
    decidedIn = null;
    browser.cookies = browser.cookies.filter(cookie => !cookie.name.startsWith('aidp_org'));
    const answered = await careMessages(post('/api/live/care-messages', LIST));
    expect(answered.status).toBe(200);
    expect(answered.headers.get('x-aidp-clinic-binding')).toBeNull();
    expect(sentClinics()).toEqual([[]]);
  });
});
