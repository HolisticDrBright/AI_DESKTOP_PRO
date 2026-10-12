import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createProgramMediaImageHandler } from './program-media-image-http';
import { ProgramMediaError } from './program-media-authoring';
const id = (n: number) => `76000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bytes = new TextEncoder().encode('fictional supplied image'), sha256 = createHash('sha256').update(bytes).digest('hex');
const reserved = { artifactId: id(1), clinic: id(2), programId: id(3), commandId: id(4), kind: 'image', contentType: 'image/png', bytes: bytes.byteLength, sha256,
  objectKey: `program-media/${id(2)}/${id(3)}/${id(1)}/${sha256}.png`, state: 'reserved', acceptBefore: '2099-01-01T00:00:00Z', createdAt: '2026-10-11T00:00:00Z', replayed: false, failure: null };
const artifact = { artifactId: reserved.artifactId, clinic: reserved.clinic, programId: reserved.programId, kind: reserved.kind, contentType: reserved.contentType,
  bytes: reserved.bytes, sha256, objectKey: reserved.objectKey, state: 'ready', version: 2, objectVersion: 'fictional-version',
  committedAt: '2026-10-11T00:00:00Z', retiredAt: null, failure: null, caption: null, transcript: null };
const req = (body: BodyInit = bytes, headers: Record<string, string> = {}, url = 'https://desktop.example.test/api/live/programs/media/image/' + id(1)) =>
  new Request(url, { method: 'PUT', headers: { host: 'desktop.example.test', origin: 'https://desktop.example.test', 'content-type': 'application/octet-stream', ...headers }, body });
const crossOriginHeaders: Record<string, string>[] = [{ origin: 'https://elsewhere.example.test' },
  { host: 'wrong.example.test', 'x-forwarded-host': 'desktop.example.test' }, { 'sec-fetch-site': 'cross-site' }];
const unsupportedHeaders: Record<string, string>[] = [{ 'content-type': 'application/json' }, { 'content-encoding': 'gzip' }];
function fixture(enabled?: boolean) {
  const reservation = vi.fn(async () => reserved), admit = vi.fn(async () => artifact), sourceForRequest = vi.fn(async () => ({ reservation, admit }));
  return { reservation, admit, sourceForRequest, handle: createProgramMediaImageHandler({ enabled, sourceForRequest }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('bounded binary image route, fictional source', () => {
  it('is default off before source construction or receiving bytes', async () => {
    const f = fixture(); expect((await f.handle(req())).status).toBe(503); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it('binds measured body bytes to the independently authorized reservation and exact receipt', async () => {
    const f = fixture(true), response = await f.handle(req()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contractVersion: 'program-media-image-http/1', ok: true, data: artifact });
    expect(f.admit.mock.calls[0]).toEqual([id(1), bytes, expect.any(AbortSignal), sha256]); expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each(crossOriginHeaders)('denies cross-origin before receiving bytes %j', async headers => {
    const f = fixture(true); expect((await f.handle(req(bytes, headers))).status).toBe(403); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it.each(['?actor=other', '?'])('refuses authority query %s', async suffix => {
    const f = fixture(true); expect((await f.handle(req(bytes, {}, req().url + suffix))).status).toBe(400); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it.each(unsupportedHeaders)('refuses unsupported transport %j', async headers => {
    const f = fixture(true); expect((await f.handle(req(bytes, headers))).status).toBe(415); expect(f.sourceForRequest).not.toHaveBeenCalled();
  });
  it('authenticates before consuming a stream and never echoes refusal details', async () => {
    const f = fixture(true); f.sourceForRequest.mockRejectedValue(new ProgramMediaError('access_refused'));
    const r = req(); expect((await f.handle(r)).status).toBe(403); expect(r.bodyUsed).toBe(false); expect(f.admit).not.toHaveBeenCalled();
  });
  it.each([new Uint8Array(bytes.length + 1), new Uint8Array(bytes.length - 1), new Uint8Array(bytes.length)])('rejects overflow, short or changed measured bytes %j', async body => {
    const f = fixture(true); expect((await f.handle(req(body))).status).toBe(400); expect(f.admit).not.toHaveBeenCalled();
  });
  it.each(['1', String(bytes.length + 1), '-1', '1.5'])('refuses dishonest or malformed Content-Length %s', async length => {
    const f = fixture(true); expect((await f.handle(req(bytes, { 'content-length': length }))).status).toBe(400); expect(f.admit).not.toHaveBeenCalled();
  });
  it('refuses an other-artifact reservation, video, or too-large image before consuming the body', async () => {
    for (const row of [{ ...reserved, artifactId: id(9) }, { ...reserved, kind: 'video', contentType: 'video/mp4' }, { ...reserved, bytes: 16777217 }]) {
      const f = fixture(true); f.reservation.mockResolvedValue(row as never); const r = req(); expect((await f.handle(r)).status).not.toBe(200); expect(r.bodyUsed).toBe(false);
    }
  });
  it.each(['artifactId', 'programId', 'clinic', 'sha256', 'bytes', 'state', 'contentType'])('refuses an unbound success %s', async key => {
    const f = fixture(true); f.admit.mockResolvedValue({ ...artifact, [key]: key === 'bytes' ? bytes.length + 1 : 'wrong' } as never);
    expect((await f.handle(req())).status).toBe(503);
  });
  it('stops an ignored provider wait at the shared deadline without a success receipt', async () => {
    vi.useFakeTimers(); const f = fixture(true); f.admit.mockImplementation(() => new Promise(() => undefined));
    const work = f.handle(req()); await vi.advanceTimersByTimeAsync(30000); expect((await work).status).toBe(503); expect(vi.getTimerCount()).toBe(0);
  });
});
