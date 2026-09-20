import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
import { POST } from './route';
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', hash = 'a'.repeat(64);
const capabilities = { transcription: true, aiDrafting: false, reason: 'ai_drafting_not_configured' };
const listing = { recordingId: id, status: 'closed', job: null, versions: [] };
const upstream = vi.fn();
function req(body: unknown = { operation: 'list', input: { recordingId: id } }, headers: Record<string, string> = {}, search = '') {
  return new Request('https://desktop.example/api/live/scribe/transcription' + search, { method: 'POST',
    headers: { origin: 'https://desktop.example', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', upstream);
  vi.stubEnv('RECORDING_TRANSCRIPTION_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  session.mockResolvedValue({ signedIn: true, token: 'fictional-cookie-token' });
  upstream.mockImplementation(async () => Response.json({ data: listing, capabilities }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('forwards only the cookie identity to the distinct pinned transcription service and validates the listing', async () => {
  const r = await POST(req(undefined, { authorization: 'Bearer attacker' }));
  expect(r.status).toBe(200); expect(await r.json()).toEqual({ data: listing, capabilities });
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(upstream.mock.calls[0][0]).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/encounter-recording/transcription');
  expect(upstream.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fictional-cookie-token' }, cache: 'no-store', redirect: 'error' });
  expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({ operation: 'list', input: { recordingId: id } });
  upstream.mockImplementation(async () => Response.json({ data: { ...listing, recordingId: other }, capabilities }));
  expect((await POST(req())).status).toBe(503);
  upstream.mockImplementation(async () => Response.json({ data: listing, capabilities: { ...capabilities, aiDrafting: true } }));
  expect((await POST(req())).status).toBe(503);
});
it('passes transcript text through read only, correlated to the requested transcript, and correlates request receipts', async () => {
  const content = { transcriptId: other, recordingId: id, version: 1, contentSha256: hash, text: 'FICTIONAL TRANSCRIPT' };
  upstream.mockImplementation(async () => Response.json({ data: content, capabilities }));
  const r = await POST(req({ operation: 'read', input: { transcriptId: other } }));
  expect(r.status).toBe(200); expect((await r.json()).data.text).toBe('FICTIONAL TRANSCRIPT');
  expect((await POST(req({ operation: 'read', input: { transcriptId: id } }))).status).toBe(503);
  const receipt = { jobId: other, recordingId: id, commandId: other, status: 'requested', segmentCount: 1, inventorySha256: hash, replayed: false };
  upstream.mockImplementation(async () => Response.json({ data: receipt, capabilities }));
  expect((await POST(req({ operation: 'request', input: { recordingId: id, commandId: other } }))).status).toBe(200);
  expect((await POST(req({ operation: 'request', input: { recordingId: id, commandId: id } }))).status).toBe(503);
});
it('rejects caller-selected releases, unknown operations, queries, encodings and oversized or malformed bodies before contacting the service', async () => {
  for (const body of [{ operation: 'request', input: { recordingId: id, commandId: other, releaseId: other } }, { operation: 'list', input: { recordingId: id, organizationId: other } },
    { operation: 'delete', input: { recordingId: id } }, { operation: 'correct', input: { recordingId: id, text: 'x', reason: '' } }, 'not json', { operation: 'list', input: { recordingId: 'x' } }])
    expect((await POST(req(body))).status).toBe(400);
  expect((await POST(req(undefined, {}, '?recordingId=' + other))).status).toBe(400);
  expect((await POST(req(undefined, { 'content-encoding': 'gzip' }))).status).toBe(400);
  expect((await POST(req(undefined, { 'content-type': 'text/plain' }))).status).toBe(400);
  expect((await POST(req({ operation: 'correct', input: { recordingId: id, text: 'x'.repeat(2_300_000), reason: 'too long' } }))).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  const ok = await POST(req({ operation: 'correct', input: { recordingId: id, text: 'corrected text', reason: 'speaker' } }));
  expect(ok.status).toBe(200); expect(upstream).toHaveBeenCalledOnce();
});
it.each<Record<string, string>>([{ origin: '' }, { origin: 'https://other.example' }, { 'sec-fetch-site': 'same-site' }])('blocks foreign origins before identity: %o', async headers => {
  expect((await POST(req(undefined, headers))).status).toBe(403); expect(session).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
});
it('refuses without a cookie session, without a pinned origin, and maps upstream statuses without forwarding detail', async () => {
  session.mockResolvedValue({ signedIn: false, token: null });
  expect((await POST(req())).status).toBe(401); expect(upstream).not.toHaveBeenCalled();
  session.mockResolvedValue({ signedIn: true, token: 'cookie' });
  for (const origin of ['', 'http://abcdefghij.execute-api.us-east-2.amazonaws.com', 'https://abcdefghij.execute-api.eu-west-1.amazonaws.com', 'https://desktop.example/'])
    { vi.stubEnv('RECORDING_TRANSCRIPTION_AWS_API_ORIGIN', origin); expect((await POST(req())).status).toBe(503); }
  expect(upstream).not.toHaveBeenCalled();
  vi.stubEnv('RECORDING_TRANSCRIPTION_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  for (const [status, expected] of [[403, 403], [401, 401], [409, 409], [413, 400], [400, 400], [503, 503], [500, 500]] as const) {
    upstream.mockImplementation(async () => new Response(JSON.stringify({ error: 'arn:aws:secret detail', text: 'PHI' }), { status, headers: { 'content-type': 'application/json' } }));
    const r = await POST(req()); expect(r.status).toBe(expected); expect(await r.text()).not.toMatch(/arn:aws|PHI/);
  }
  upstream.mockImplementation(async () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }));
  expect((await POST(req())).status).toBe(503);
  upstream.mockImplementation(async () => Response.redirect('https://elsewhere.example', 302));
  expect((await POST(req())).status).toBe(503);
});
