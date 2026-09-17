import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
import { POST } from './route';
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const hash = 'a'.repeat(64), time = '2026-09-17T22:00:00Z';
const state = { recordingId: id, sessionId: other, status: 'capturing', credentialVersion: 0, authorityEpoch: 1,
  currentAuthorityEpoch: 1, tokenExpiresAt: time, deletionDeadline: time, storedSegments: 0, pendingSegments: 0,
  reservedBytes: 0, nextSequence: 0, inventorySha256: hash, disposition: null, processingRequested: false, audioDeleted: false };
const upstream = vi.fn();
function req(input: unknown = { recordingId: id }, headers: Record<string, string> = {}, search = '') {
  return new Request('https://desktop.example/api/live/scribe/capture/state' + search, { method: 'POST',
    headers: { origin: 'https://desktop.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
}
const post = (request = req(), operation = 'state') => POST(request, { params: Promise.resolve({ operation }) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', upstream);
  vi.stubEnv('RECORDING_CAPTURE_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  session.mockResolvedValue({ signedIn: true, token: 'fictional-cookie-token' });
  upstream.mockImplementation(async () => Response.json({ data: state }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('forwards only the cookie identity to the distinct pinned service and validates state', async () => {
  const r = await post(req(undefined, { authorization: 'Bearer attacker' }));
  expect(r.status).toBe(200); expect(await r.json()).toEqual({ data: state });
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(upstream.mock.calls[0][0]).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/encounter-recording/state');
  expect(upstream.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fictional-cookie-token' }, cache: 'no-store', redirect: 'error' });
});
it.each<Record<string, string>>([{ origin: '' }, { origin: 'https://other.example' }, { 'sec-fetch-site': 'same-site' }])('blocks foreign origins before identity: %o', async headers => {
  expect((await post(req(undefined, headers))).status).toBe(403); expect(session).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
});
it('refuses bearer-only authentication and never falls back to the consent endpoint', async () => {
  session.mockResolvedValue({ signedIn: false, token: null });
  expect((await post()).status).toBe(401); expect(upstream).not.toHaveBeenCalled();
  session.mockResolvedValue({ signedIn: true, token: 'cookie' });
  vi.stubEnv('RECORDING_CAPTURE_AWS_API_ORIGIN', '');
  vi.stubEnv('RECORDING_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  expect((await post()).status).toBe(503); expect(upstream).not.toHaveBeenCalled();
});
it.each(['https://evil.example', 'http://abcdefghij.execute-api.us-east-2.amazonaws.com',
  'https://abcdefghij.execute-api.us-east-2.amazonaws.com/path', 'https://user@abcdefghij.execute-api.us-east-2.amazonaws.com',
  'https://abcdefghij.execute-api.us-east-2.amazonaws.com:8443', 'https://abcdefghij.execute-api.eu-west-1.amazonaws.com'])
  ('refuses an unqualified configured origin %s', async origin => {
    vi.stubEnv('RECORDING_CAPTURE_AWS_API_ORIGIN', origin); expect((await post()).status).toBe(503); expect(upstream).not.toHaveBeenCalled();
  });
it.each([
  () => post(req({ recordingId: id, actorPersonId: other })),
  () => post(req(), '../authority'),
  () => post(req(undefined, {}, '?captureToken=secret')),
  () => post(req(undefined, { 'x-alp-capture-token': hash })),
  () => post(req(undefined, { 'content-encoding': 'gzip' })),
  () => post(req({ recordingId: id, extra: 'x'.repeat(10000) })),
])('rejects caller-selected identity, destinations and invalid framing before AWS', async run => {
  expect((await run()).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
});
it.each([400,401,403,409,503])('sanitizes upstream %s without returning raw content', async status => {
  upstream.mockResolvedValue(new Response('secret-token patient data sql', { status }));
  const r = await post(); expect(r.status).toBe(status); expect(await r.text()).not.toMatch(/secret-token|patient data|sql/);
});
it.each([{ ...state, recordingId: other }, { ...state, captureToken: hash },
  { ...state, processingRequested: true }, { ...state, audioDeleted: true }, { ...state, nextSequence: 1 }])
  ('rejects invalid or unrelated state receipts', async data => {
    upstream.mockResolvedValue(Response.json({ data })); expect((await post()).status).toBe(503);
  });
it('correlates start and lifecycle receipts including command replay secrets and CAS version', async () => {
  const start = { encounterId: other, commandId: id, contentType: 'audio/webm' };
  const receipt = { recordingId: id, sessionId: other, ...start, status: 'capturing', replayed: false, captureToken: hash,
    credentialVersion: 0, authorityEpoch: 1, expiresAt: time, deletionDeadline: time };
  upstream.mockImplementation(async () => Response.json({ data: receipt }));
  expect((await post(req(start), 'start')).status).toBe(200);
  expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual(start);
  upstream.mockResolvedValue(Response.json({ data: { ...receipt, encounterId: id } }));
  expect((await post(req(start), 'start')).status).toBe(503);
  upstream.mockResolvedValue(Response.json({ data: { ...receipt, replayed: true } }));
  expect((await post(req(start), 'start')).status).toBe(503);
  const command = { recordingId: id, commandId: other, action: 'pause', expectedVersion: 0, inventorySha256: null };
  const result = { recordingId: id, commandId: other, action: 'pause', statusAtCommand: 'paused', credentialVersion: 1,
    expiresAt: time, inventorySha256: null, processingRequested: false, audioDeleted: false, replayed: false,
    captureToken: null, requiresCredentialRecovery: false };
  upstream.mockResolvedValue(Response.json({ data: result }));
  expect((await post(req(command), 'command')).status).toBe(200);
  for (const data of [{ ...result, credentialVersion: 2 }, { ...result, commandId: id }, { ...result, captureToken: hash }]) {
    upstream.mockResolvedValue(Response.json({ data })); expect((await post(req(command), 'command')).status).toBe(503);
  }
});
const audio = new Uint8Array([1,2,3,4]);
const sha = createHash('sha256').update(audio).digest('hex');
function segment(overrides: Record<string,string> = {}, body: Uint8Array = audio) {
  return new Request('https://desktop.example/api/live/scribe/capture/segment', { method:'POST',
    headers: { origin: 'https://desktop.example', 'content-type':'audio/webm', 'x-alp-recording-id':id,
      'x-alp-session-id':other, 'x-alp-capture-token':hash, 'x-alp-sequence':'0', 'x-alp-sha256':sha, ...overrides },
    body: body as BodyInit });
}
it('forwards only verified raw segment bytes and checks the exact stored receipt', async () => {
  const receipt = { segmentId: other, recordingId:id, sequence:0, sha256:sha, bytes:4, authorityEpoch:1, status:'stored' };
  upstream.mockResolvedValue(Response.json({ data:receipt }));
  expect((await post(segment(),'segment')).status).toBe(200);
  expect(new Uint8Array(upstream.mock.calls[0][1].body)).toEqual(audio);
  expect(upstream.mock.calls[0][1].headers).toMatchObject({ Authorization:'Bearer fictional-cookie-token', 'x-alp-sha256':sha });
  upstream.mockResolvedValue(Response.json({ data:{ ...receipt, sha256:hash } }));
  expect((await post(segment(),'segment')).status).toBe(503);
});
it.each<Record<string, string>>([{ 'x-alp-sequence':'00' }, { 'x-alp-sequence':'4096' }, { 'x-alp-recording-id':id + ',' + other },
  { 'x-alp-capture-token':'invalid' }, { 'x-alp-storage-bucket':'override' }, { 'content-type':'audio/webm; codecs=opus' },
  { 'x-alp-sha256':hash }, { 'content-length':'4194305' }])('refuses invalid audio headers/hash before upload: %o', async headers => {
  expect((await post(segment(headers),'segment')).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
});
it('bounds invalid, oversized and stalled upstream responses', async () => {
  upstream.mockResolvedValue(new Response('x'.repeat(16001), { headers:{ 'content-type':'application/json' } }));
  expect((await post()).status).toBe(503);
  upstream.mockResolvedValue(new Response(new Uint8Array([255]), { headers:{ 'content-type':'application/json' } }));
  expect((await post()).status).toBe(503);
  vi.useFakeTimers(); const cancel = vi.fn();
  upstream.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers:{ 'content-type':'application/json' } }));
  const pending = post(); await vi.advanceTimersByTimeAsync(5001);
  expect((await pending).status).toBe(503); expect(cancel).toHaveBeenCalledOnce();
});
