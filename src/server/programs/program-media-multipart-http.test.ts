import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createProgramMediaMultipartHandler } from './program-media-multipart-http';
import { ProgramMediaError } from './program-media-authoring';
import { PROGRAM_MEDIA_PART_BYTES } from './program-media-parts';

const id = (n: number) => '75000000-0000-4000-8000-' + String(n).padStart(12, '0');
const control = 'https://desktop.example.test/api/live/programs/media/multipart/control';
const partUrl = `https://desktop.example.test/api/live/programs/media/multipart/part/${id(1)}/1/${id(2)}`;
const bytes = new TextEncoder().encode('Fictional lesson bytes');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const view = { artifactId: id(1), contentType: 'video/mp4', bytes: bytes.length, sha256: hash(bytes), state: 'uploading',
  acceptBefore: '2099-01-01T00:00:00Z', receivedParts: [1], pendingParts: [], pendingWork: false };
const headers = (value?: Record<string, string | undefined>) => Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
function json(body: unknown, options: { url?: string; origin?: string; headers?: Record<string, string | undefined>; signal?: AbortSignal } = {}) {
  return new Request(options.url ?? control, { method: 'POST', headers: { host: 'desktop.example.test', origin: options.origin ?? 'https://desktop.example.test',
    'content-type': 'application/json', ...headers(options.headers) }, body: JSON.stringify(body), signal: options.signal });
}
function binary(body = bytes, options: { url?: string; headers?: Record<string, string | undefined>; signal?: AbortSignal } = {}) {
  return new Request(options.url ?? partUrl, { method: 'PUT', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test',
    'content-type': 'application/octet-stream', 'x-alp-part-sha256': hash(body), ...headers(options.headers) }, body: Buffer.from(body), signal: options.signal });
}
function fixture() {
  const execute = vi.fn<(value: unknown, signal: AbortSignal, bytes?: Uint8Array) => Promise<unknown>>(async () => ({ ...view }));
  const admitPartBody = vi.fn(async () => ({ totalBytes: bytes.length, partNumber: 1, sha256: hash(bytes) }));
  const sourceForRequest = vi.fn(async () => ({ execute, admitPartBody }));
  const handler = createProgramMediaMultipartHandler({ enabled: true, sourceForRequest });
  return { execute, admitPartBody, sourceForRequest, handler };
}
const command = { operation: 'status', request: { artifactId: id(1) } };
describe('uninstalled bounded multipart HTTP source with fictional authenticated authority', () => {
  it('is OFF by default without authority or body consumption', async () => {
    const f = fixture(), handler = createProgramMediaMultipartHandler({ sourceForRequest: f.sourceForRequest });
    expect((await handler(json(command))).status).toBe(503); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it.each(['?ignored=1', '?', '#anchor'])('rejects ambiguous URL suffix %s before auth', async suffix => {
    const f = fixture(); expect((await f.handler(json(command, { url: control + suffix }))).status).toBe(400); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it('refuses unknown paths, noncanonical part ids and methods', async () => {
    const f = fixture(); expect((await f.handler(json(command, { url: control + '/other' }))).status).toBe(404);
    expect((await f.handler(new Request(control, { method: 'GET' }))).status).toBe(405);
    expect((await f.handler(binary(bytes, { url: partUrl.replace('/1/', '/01/') }))).status).toBe(404);
    expect((await f.handler(binary(bytes, { url: partUrl.replace(id(1), '-'.repeat(36)) }))).status).toBe(400);
    expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it.each([{ origin: 'https://other.example.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])('refuses cross-origin authority %j', async headers => {
    const f = fixture(); expect((await f.handler(json(command, { headers }))).status).toBe(403); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it('refuses a missing Host or Origin and never trusts a spoofed forwarded host', async () => {
    for (const header of ['host', 'origin']) {
      const f = fixture(), request = json(command); request.headers.delete(header);
      expect((await f.handler(request)).status).toBe(403); expect(f.sourceForRequest).not.toHaveBeenCalled();
    }
    const f = fixture();
    expect((await f.handler(binary(bytes, { headers: { host: 'attacker.example.test', 'x-forwarded-host': 'desktop.example.test' } }))).status).toBe(403);
    expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it('requires host authority before either metadata or binary body is read', async () => {
    const f = fixture(); f.sourceForRequest.mockRejectedValue(new ProgramMediaError('access_refused'));
    for (const [url, method, type] of [[control, 'POST', 'application/json'], [partUrl, 'PUT', 'application/octet-stream']] as const) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({ pull() { pulled++; throw new Error('must not read'); } }, { highWaterMark: 0 });
      const request = new Request(url, { method, headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': type }, body, duplex: 'half' } as RequestInit);
      expect((await f.handler(request)).status).toBe(403); expect(pulled).toBe(0);
    }
    expect(f.admitPartBody).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('binds the durable immutable part recipe before body reading and sends only measured bytes', async () => {
    const f = fixture(), sequence: string[] = [];
    f.sourceForRequest.mockImplementationOnce(async () => { sequence.push('auth'); return { execute: f.execute, admitPartBody: f.admitPartBody }; });
    f.admitPartBody.mockImplementationOnce(async () => { sequence.push('recipe'); return { totalBytes: bytes.length, partNumber: 1, sha256: hash(bytes) }; });
    const body = new ReadableStream<Uint8Array>({ pull(c) { sequence.push('body'); c.enqueue(bytes); c.close(); } }, { highWaterMark: 0 });
    const request = new Request(partUrl, { method: 'PUT', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/octet-stream', 'x-alp-part-sha256': hash(bytes) }, body, duplex: 'half' } as RequestInit);
    const response = await f.handler(request); expect(response.status).toBe(200); expect(sequence).toEqual(['auth', 'recipe', 'body']);
    expect(f.execute.mock.calls[0][0]).toEqual({ operation: 'part', request: { artifactId: id(1), commandId: id(2), partNumber: 1 } });
    expect(f.execute.mock.calls[0][2]).toEqual(bytes);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('carries an actual 8 MiB binary part without a JSON/base64 envelope', async () => {
    const f = fixture(), body = new Uint8Array(PROGRAM_MEDIA_PART_BYTES).fill(7);
    f.admitPartBody.mockResolvedValueOnce({ totalBytes: body.length, partNumber: 1, sha256: hash(body) });
    f.execute.mockResolvedValueOnce({ ...view, bytes: body.length, sha256: hash(body) });
    expect((await f.handler(binary(body))).status).toBe(200); expect(f.execute.mock.calls[0][2]!.length).toBe(PROGRAM_MEDIA_PART_BYTES);
  });
  it.each([
    { 'content-length': String(PROGRAM_MEDIA_PART_BYTES + 1) }, { 'content-length': '-1' }, { 'content-encoding': 'gzip' },
    { 'content-type': 'application/json' },
  ])('refuses bad part framing before auth %j', async headers => {
    const f = fixture(); expect((await f.handler(binary(bytes, { headers }))).status).not.toBe(200); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it.each([{ 'content-length': '1' }, { 'x-alp-part-sha256': '0'.repeat(64) }])('refuses dishonest length or substituted digest before write admission %j', async headers => {
    const f = fixture(); expect((await f.handler(binary(bytes, { headers }))).status).toBe(400); expect(f.execute).not.toHaveBeenCalled();
  });
  it('refuses short, altered and oversized streams, including no Content-Length, before executing a write', async () => {
    for (const data of [bytes.subarray(0, 1), new Uint8Array(bytes.length), new Uint8Array(bytes.length + 1)]) {
      const f = fixture(), request = binary(data, { headers: { 'x-alp-part-sha256': hash(bytes) } });
      expect((await f.handler(request)).status).toBe(400); expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('does not expose internal proof commands or allow part bytes in JSON', async () => {
    for (const operation of ['commit', 'certifyAbort', 'recordCompletion', 'recordPart', 'part']) {
      const f = fixture(); expect((await f.handler(json({ operation, request: { artifactId: id(1), commandId: id(2), partNumber: 1 } }))).status).toBe(400);
      expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it('bounds streamed metadata bytes rather than trusting missing Content-Length', async () => {
    const f = fixture(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const request = new Request(control, { method: 'POST', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    expect((await f.handler(request)).status).toBe(400); expect(cancelled).toBe(true); expect(f.execute).not.toHaveBeenCalled();
  });
  it('refuses wrong-artifact and private-field replies instead of leaking provider identities', async () => {
    for (const answer of [{ ...view, artifactId: id(9) }, { ...view, uploadId: 'private-provider-id' }]) {
      const f = fixture(); f.execute.mockResolvedValueOnce(answer);
      const response = await f.handler(json(command)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-provider-id');
    }
  });
  it.each([
    { ...view, receivedParts: [1, 1] },
    { ...view, receivedParts: [2] },
    { ...view, pendingParts: [2], pendingWork: true },
    { ...view, pendingParts: [1], pendingWork: true },
    { ...view, receivedParts: [], pendingParts: [1], pendingWork: false },
    { ...view, state: 'committed', receivedParts: [] },
    { ...view, state: 'committed', pendingWork: true },
  ])('refuses inconsistent progress rather than claiming received or committed bytes %j', async answer => {
    const f = fixture(); f.execute.mockResolvedValueOnce(answer);
    expect((await f.handler(json(command))).status).toBe(503);
  });
  it('keeps an admitted but uncertain part visibly pending, not claimed received', async () => {
    const f = fixture(); f.execute.mockResolvedValueOnce({ ...view, receivedParts: [], pendingParts: [1], pendingWork: true });
    const response = await f.handler(binary()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { pendingWork: true, receivedParts: [], pendingParts: [1] } });
  });
  it('terminates ignored auth and source waits at the one request deadline with no private errors', async () => {
    const f = fixture(); f.sourceForRequest.mockImplementationOnce(async () => new Promise<never>(() => undefined));
    const handler = createProgramMediaMultipartHandler({ enabled: true, sourceForRequest: f.sourceForRequest, timeoutMs: 10 });
    expect((await handler(json(command))).status).toBe(503); expect(f.execute).not.toHaveBeenCalled();
    f.execute.mockRejectedValueOnce(new Error('private provider detail'));
    const response = await f.handler(json(command)); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private provider');
  });
  it('stops an ignored body reader on withdrawal without issuing a write', async () => {
    const f = fixture(), controller = new AbortController(); let cancelled = false, reading!: () => void;
    const entered = new Promise<void>(r => { reading = r; });
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); return new Promise<never>(() => undefined); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const request = new Request(partUrl, { method: 'PUT', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/octet-stream', 'x-alp-part-sha256': hash(bytes) }, body, duplex: 'half', signal: controller.signal } as RequestInit);
    const pending = f.handler(request); await entered; controller.abort(); expect((await pending).status).toBe(403);
    expect(cancelled).toBe(true); expect(f.execute).not.toHaveBeenCalled();
  });
});
