import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('@/server/session', () => ({ getRequestSession: session }));
vi.mock('@/adapters/mode', () => ({ USE_LIVE_API: true }));
import { POST } from './route';
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', third = '33333333-3333-4333-8333-333333333333', hash = 'a'.repeat(64);
const capabilities = { aiDrafting: true, writesClinicalNotes: false, reason: 'review_only' };
const listing = { recordingId: id, status: 'closed', latestTranscript: { transcriptId: third, version: 1 }, job: null, versions: [] };
const upstream = vi.fn();
function req(body: unknown = { operation: 'list', input: { recordingId: id } }, headers: Record<string, string> = {}, search = '') {
  return new Request('https://desktop.example/api/live/scribe/drafting' + search, { method: 'POST',
    headers: { origin: 'https://desktop.example', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', upstream);
  vi.stubEnv('RECORDING_DRAFTING_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  session.mockResolvedValue({ signedIn: true, token: 'fictional-cookie-token' });
  upstream.mockImplementation(async () => Response.json({ data: listing, capabilities }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('forwards only the cookie identity to the distinct pinned drafting service and requires the review-only capability declaration', async () => {
  const r = await POST(req(undefined, { authorization: 'Bearer attacker' }));
  expect(r.status).toBe(200); expect(await r.json()).toEqual({ data: listing, capabilities });
  expect(upstream.mock.calls[0][0]).toBe('https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/encounter-recording/drafting');
  expect(upstream.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer fictional-cookie-token' }, cache: 'no-store', redirect: 'error' });
  upstream.mockImplementation(async () => Response.json({ data: { ...listing, recordingId: other }, capabilities }));
  expect((await POST(req())).status).toBe(503);
  upstream.mockImplementation(async () => Response.json({ data: listing, capabilities: { ...capabilities, writesClinicalNotes: true } }));
  expect((await POST(req())).status).toBe(503);
});
it('passes a proposed note through read only, correlated, and correlates request receipts to transcript, command and note type', async () => {
  const document = { contract: 'proposed-note/1', noteType: 'soap', transcriptId: third, transcriptSha256: hash, model: 'fictional-model-1', promptSha256: hash,
    sections: [{ key: 'S', label: 'Subjective', text: 'FICTIONAL' }, { key: 'O', label: 'Objective', text: '' }, { key: 'A', label: 'Assessment', text: '' }, { key: 'P', label: 'Plan', text: '' }], cautions: [] };
  upstream.mockImplementation(async () => Response.json({ data: { proposedNoteId: other, recordingId: id, version: 1, contentSha256: hash, document }, capabilities }));
  const r = await POST(req({ operation: 'read', input: { proposedNoteId: other } }));
  expect(r.status).toBe(200); expect((await r.json()).data.document.sections[0].text).toBe('FICTIONAL');
  expect((await POST(req({ operation: 'read', input: { proposedNoteId: id } }))).status).toBe(503);
  const receipt = { jobId: other, recordingId: id, transcriptId: third, commandId: other, noteType: 'soap', status: 'requested', replayed: false };
  upstream.mockImplementation(async () => Response.json({ data: receipt, capabilities }));
  expect((await POST(req({ operation: 'request', input: { recordingId: id, transcriptId: third, commandId: other, noteType: 'soap' } }))).status).toBe(200);
  expect((await POST(req({ operation: 'request', input: { recordingId: id, transcriptId: third, commandId: other, noteType: 'narrative' } }))).status).toBe(503);
  expect((await POST(req({ operation: 'request', input: { recordingId: id, transcriptId: id, commandId: other, noteType: 'soap' } }))).status).toBe(503);
});
it('rejects caller-selected releases or models, unknown operations, queries, encodings and malformed bodies before contacting the service', async () => {
  for (const body of [{ operation: 'request', input: { recordingId: id, transcriptId: third, commandId: other, noteType: 'soap', releaseId: other } },
    { operation: 'request', input: { recordingId: id, transcriptId: third, commandId: other, noteType: 'soap', model: 'x' } },
    { operation: 'correct', input: { recordingId: id } }, { operation: 'list', input: { recordingId: 'x' } }, 'not json'])
    expect((await POST(req(body))).status).toBe(400);
  expect((await POST(req(undefined, {}, '?recordingId=' + other))).status).toBe(400);
  expect((await POST(req(undefined, { 'content-encoding': 'gzip' }))).status).toBe(400);
  expect((await POST(req(undefined, { 'content-type': 'text/plain' }))).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([{ origin: '' }, { origin: 'https://other.example' }, { 'sec-fetch-site': 'same-site' }])('blocks foreign origins before identity: %o', async headers => {
  expect((await POST(req(undefined, headers))).status).toBe(403); expect(session).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
});
it('refuses without a cookie session or a pinned origin and maps upstream statuses without forwarding detail', async () => {
  session.mockResolvedValue({ signedIn: false, token: null });
  expect((await POST(req())).status).toBe(401); expect(upstream).not.toHaveBeenCalled();
  session.mockResolvedValue({ signedIn: true, token: 'cookie' });
  for (const origin of ['', 'http://abcdefghij.execute-api.us-east-2.amazonaws.com', 'https://desktop.example/'])
    { vi.stubEnv('RECORDING_DRAFTING_AWS_API_ORIGIN', origin); expect((await POST(req())).status).toBe(503); }
  expect(upstream).not.toHaveBeenCalled();
  vi.stubEnv('RECORDING_DRAFTING_AWS_API_ORIGIN', 'https://abcdefghij.execute-api.us-east-2.amazonaws.com');
  for (const [status, expected] of [[403, 403], [401, 401], [409, 409], [400, 400], [503, 503], [302, 503]] as const) {
    upstream.mockImplementation(async () => new Response(JSON.stringify({ error: 'arn:aws:secret detail', text: 'PHI' }), { status, headers: { 'content-type': 'application/json' } }));
    const r = await POST(req()); expect(r.status).toBe(expected); expect(await r.text()).not.toMatch(/arn:aws|PHI/);
  }
});
