import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createProgramMediaUploadController, type MediaUploadFile, type ProgramMediaUploadScope } from './programMediaUpload';
import { PROGRAM_MEDIA_PART_BYTES, type ProgramMediaPartManifest } from '@/contracts/programMediaUpload';
import type { ProgramMediaArtifact, ProgramMediaReservation } from '@/contracts/programMedia';

const programId = '11111111-1111-4111-8111-111111111111', draftId = '22222222-2222-4222-8222-222222222222';
const clinic = '33333333-3333-4333-8333-333333333333', artifactId = '44444444-4444-4444-8444-444444444444';
const scope: ProgramMediaUploadScope = { programId, draftId, stepId: 'phase-1/lesson-1', session: 'fictional-session-1' };
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
type Call = { path: string; method: string; json?: Record<string, unknown>; bytes?: Uint8Array; signal: AbortSignal };
const reply = (contractVersion: string, data: unknown) => new Response(JSON.stringify({ contractVersion, ok: true, data }), { headers: { 'content-type': 'application/json' } });
const refusal = (contractVersion: string, code: string, status = 409) => new Response(JSON.stringify({ contractVersion, ok: false, error: { code } }), { status, headers: { 'content-type': 'application/json' } });
const control = 'program-media-control-http/1', multipart = 'program-media-multipart-control/1';
function fixture(kind: 'image' | 'video' = 'image', overrides: { requestTimeoutMs?: number; hashingTimeoutMs?: number } = {}) {
  const bytes = kind === 'image' ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) : new Uint8Array(PROGRAM_MEDIA_PART_BYTES + 7).fill(37);
  const selected = new File([bytes], kind === 'image' ? 'lesson.png' : 'lesson.mp4', { type: kind === 'image' ? 'image/png' : 'video/mp4' });
  let current: ProgramMediaUploadScope | null = { ...scope }, reservation: ProgramMediaReservation | null = null, artifact: ProgramMediaArtifact | null = null;
  let manifest: ProgramMediaPartManifest | null = null, multipartState = 'prepared', pendingWork = false;
  const received = new Set<number>(), calls: Call[] = [];
  const state = () => ({ artifactId, contentType: selected.type, bytes: selected.size, sha256: digest(bytes), state: multipartState,
    acceptBefore: new Date(Date.now() + 600_000).toISOString(), receivedParts: [...received], pendingParts: [], pendingWork });
  const ready = () => artifact = { artifactId, clinic, programId, kind, contentType: kind === 'image' ? 'image/png' : 'video/mp4',
    bytes: selected.size, sha256: digest(bytes), objectKey: `program-media/${clinic}/${programId}/${artifactId}/${digest(bytes)}.${kind === 'image' ? 'png' : 'mp4'}`,
    version: 1, state: 'ready', objectVersion: 'fictional-v1', committedAt: new Date().toISOString(), retiredAt: null, failure: null, caption: null, transcript: null };
  let intercept: ((call: Call) => Promise<Response | undefined> | Response | undefined) | undefined;
  const transport: typeof fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? 'GET', signal = init!.signal as AbortSignal;
    expect(init?.credentials).toBe('same-origin'); expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    const call: Call = { path, method, signal };
    if (typeof init?.body === 'string') call.json = JSON.parse(init.body); else if (init?.body instanceof Uint8Array) call.bytes = init.body;
    calls.push(call); const intercepted = await intercept?.(call); if (intercepted) return intercepted;
    if (path.endsWith('/control') && path.includes('/multipart/')) {
      const q = call.json!, request = q.request as Record<string, unknown>;
      if (q.operation === 'status' || q.operation === 'reconcile') return manifest ? reply(multipart, state()) : refusal(multipart, 'not_found', 404);
      if (q.operation === 'start') { manifest = request.manifest as ProgramMediaPartManifest; return reply(multipart, state()); }
      if (q.operation === 'create') { multipartState = 'uploading'; return reply(multipart, state()); }
      if (q.operation === 'complete') { multipartState = 'committed'; ready(); return reply(multipart, state()); }
      if (q.operation === 'cancel') { multipartState = 'abort_requested'; pendingWork = true; return reply(multipart, state()); }
    } else if (path === '/api/live/programs/media/control') {
      const q = call.json!, request = q.request as Record<string, unknown>;
      if (q.operation === 'prepare') {
        reservation = { artifactId, clinic, programId, kind, contentType: selected.type as 'image/png' | 'video/mp4', bytes: selected.size,
          sha256: digest(bytes), objectKey: `program-media/${clinic}/${programId}/${artifactId}/${digest(bytes)}.${kind === 'image' ? 'png' : 'mp4'}`,
          commandId: request.commandId as string, state: 'reserved', acceptBefore: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString(), replayed: false, failure: null };
        return reply(control, reservation);
      }
      if (q.operation === 'inspect') return reply(control, artifact ?? reservation);
      if (q.operation === 'attachText') {
        if (!artifact) throw new Error('fixture_not_ready'); const slot = request.slot as 'caption' | 'transcript';
        artifact = { ...artifact, version: artifact.version + 1, [slot]: { text: request.text, sha256: digest(request.text as string), source: 'supplied_by_author', format: 'plain' } };
        return reply(control, artifact);
      }
      if (q.operation === 'publish') {
        if (!artifact) throw new Error('fixture_not_ready');
        return reply(control, { contractVersion: 'program-media-reference/1', artifactId, version: artifact.version, sha256: artifact.sha256,
          kind, contentType: artifact.contentType, bytes: artifact.bytes, origin: { clinic, programId },
          url: 'https://education.example.test/exact-artifact', publishedAt: new Date().toISOString(), caption: artifact.caption && { source: artifact.caption.source, sha256: artifact.caption.sha256 }, transcript: null });
      }
      if (q.operation === 'preview') {
        if (!artifact) throw new Error('fixture_not_ready');
        return reply(control, { artifactId, version: artifact.version, state: artifact.state, kind, contentType: artifact.contentType,
          bytes: artifact.bytes, sha256: artifact.sha256, previewToken: `https://fictional-education.s3.us-east-2.amazonaws.com/${artifact.objectKey}?versionId=fictional-v1&X-Amz-Expires=300`,
          previewUntil: new Date(Date.now() + 290_000).toISOString(), historical: false });
      }
    } else if (path.startsWith('/api/live/programs/media/image/')) return reply('program-media-image-http/1', ready());
    else if (path.includes('/multipart/part/')) { received.add(Number(path.split('/').at(-2))); return reply(multipart, state()); }
    throw new Error('unexpected_fictional_transport');
  };
  const controller = createProgramMediaUploadController({ scope: () => current, fetch: transport, uuid: randomUUID, ...overrides });
  return { controller, selected, bytes, calls, state, ready, received, setScope: (value: ProgramMediaUploadScope | null) => current = value,
    intercept: (value: typeof intercept) => intercept = value, pending: (value: boolean) => pendingWork = value,
    reservation: () => reservation, artifact: () => artifact, setArtifact: (value: ProgramMediaArtifact) => artifact = value,
    setMultipart: (value: string, parts: ProgramMediaPartManifest | null) => { multipartState = value; manifest = parts; } };
}

describe('native lesson media is reachable from the actual authoring editor', () => {
  it('renders upload controls under the current program/draft session instead of URL-only slots', () => {
    const editor = readFileSync('src/components/programs/ConsumerProgramEditor.tsx', 'utf8');
    const studio = readFileSync('src/components/programs/ProgramStudio.tsx', 'utf8');
    expect(editor).toContain('ProgramMediaUploadPanel');
    expect(editor).toContain('mediaScope');
    expect(studio).toContain('mediaScope={{');
    expect(editor).not.toContain('no upload or hosting exists yet');
  });
});

describe('bounded author upload control through the real browser contract', () => {
  it('hashes locally, sends raw image bytes, waits for a ready receipt and publishes only supplied exact text', async () => {
    const f = fixture(); await f.controller.selectFile(f.selected);
    expect(f.calls).toHaveLength(0); expect(f.controller.snapshot()).toMatchObject({ state: 'prepared', fileSelected: true, receivedParts: 0 });
    await f.controller.upload(); expect(f.controller.snapshot()).toMatchObject({ state: 'ready', receivedParts: 1 });
    expect(f.calls.map(c => c.method)).toEqual(['POST', 'PUT']); expect(f.calls[1].bytes).toEqual(f.bytes);
    await f.controller.publish(); expect(f.controller.snapshot().reference).toBeNull();
    await f.controller.attachText('Fictional supplied explanation'); await f.controller.preview(); await f.controller.publish();
    expect(f.controller.snapshot().reference?.caption?.sha256).toBe(digest('Fictional supplied explanation'));
    expect(f.controller.snapshot().preview).not.toBeNull(); f.controller.clearPreview();
    expect(f.controller.snapshot()).toMatchObject({ state: 'published', preview: null }); expect(f.controller.snapshot().artifact).not.toBeNull();
  });

  it('sends only missing bounded video parts and reports server receipts, not transmitted bytes', async () => {
    const f = fixture('video'); await f.controller.selectFile(f.selected);
    const observed: number[] = []; f.controller.subscribe(v => observed.push(v.receivedParts));
    f.intercept(call => { if (call.path.includes('/part/')) expect(f.controller.snapshot().receivedParts).toBe(f.received.size); return undefined; });
    await f.controller.upload();
    const parts = f.calls.filter(c => c.path.includes('/part/'));
    expect(parts.map(p => p.bytes?.byteLength)).toEqual([PROGRAM_MEDIA_PART_BYTES, 7]);
    expect(f.controller.snapshot()).toMatchObject({ state: 'ready', receivedParts: 2, totalParts: 2 });
    expect(observed).toContain(0); expect(observed).toContain(1); expect(observed).toContain(2);
    expect(f.calls.filter(c => c.json?.operation === 'start')).toHaveLength(1);
  });

  it('does not replace an uncertain prepare request or change its idempotency key', async () => {
    const f = fixture(); let failed = false;
    f.intercept(call => { if (call.json?.operation === 'prepare' && !failed) { failed = true; throw new Error('fictional_lost_reply'); } return undefined; });
    await f.controller.selectFile(f.selected); await f.controller.upload();
    expect(f.controller.snapshot()).toMatchObject({ state: 'prepared', fileSelected: true, receivedParts: 0, artifact: null });
    await f.controller.upload();
    const requests = f.calls.filter(c => c.json?.operation === 'prepare');
    expect(requests).toHaveLength(2); expect(requests[0].json).toEqual(requests[1].json); expect(f.controller.snapshot().state).toBe('ready');
  });

  it('restores a saved video read-only, reselects exact bytes and resumes without a second start or first part', async () => {
    const f = fixture('video'); let lost = false;
    f.intercept(call => { if (call.path.includes('/part/') && call.path.split('/').at(-2) === '2' && !lost) { lost = true; throw new Error('fictional_network_loss'); } return undefined; });
    await f.controller.selectFile(f.selected); await f.controller.upload();
    expect(f.controller.snapshot()).toMatchObject({ state: 'waiting', receivedParts: 1 });
    f.controller.invalidate(); await f.controller.restore(artifactId);
    expect(f.controller.snapshot()).toMatchObject({ state: 'waiting', fileSelected: false, totalParts: 2 });
    await f.controller.selectFile(f.selected); await f.controller.upload();
    expect(f.calls.filter(c => c.json?.operation === 'prepare')).toHaveLength(1);
    expect(f.calls.filter(c => c.json?.operation === 'start')).toHaveLength(1);
    expect(f.calls.filter(c => c.path.includes('/part/') && c.path.split('/').at(-2) === '1')).toHaveLength(1);
    expect(f.controller.snapshot()).toMatchObject({ state: 'ready', receivedParts: 2 });
  });

  it('holds a pending writer without sending a create, part or completion, and labels cancellation honestly', async () => {
    const f = fixture('video'); f.pending(true); await f.controller.selectFile(f.selected); await f.controller.upload();
    expect(f.controller.snapshot().message).toContain('previous write is still pending');
    expect(f.calls.some(c => c.json?.operation === 'create' || c.json?.operation === 'complete' || c.path.includes('/part/'))).toBe(false);
    await f.controller.cancel(); expect(f.controller.snapshot().message).toContain('deletion is not confirmed');
    expect(f.controller.snapshot().state).toBe('waiting');
  });

  it('rejects another file on resume, without replacing the saved upload or sending it', async () => {
    const f = fixture('video'); f.pending(true); await f.controller.selectFile(f.selected); await f.controller.upload();
    const callCount = f.calls.length; await f.controller.selectFile(new File(['wrong'], 'lesson.mp4', { type: 'video/mp4' }));
    expect(f.calls).toHaveLength(callCount); expect(f.controller.snapshot().artifact?.artifactId).toBe(artifactId);
    expect(f.controller.snapshot().fileSelected).toBe(false);
  });

  for (const state of ['held', 'error', 'retired'] as const) it(`does not resume or publish a ${state} artifact`, async () => {
    const f = fixture(); const ready = f.ready(); f.setArtifact(state === 'retired' ? { ...ready, state, retiredAt: new Date().toISOString() }
      : { ...ready, state, objectVersion: null, committedAt: null });
    await f.controller.restore(artifactId); expect(f.controller.snapshot().state).toBe('refused');
    await f.controller.selectFile(f.selected); await f.controller.upload(); await f.controller.publish();
    expect(f.calls.map(c => c.json?.operation)).toEqual(['inspect']); expect(f.controller.snapshot().reference).toBeNull();
  });

  it('discards a late response when owner/program/session authority changes', async () => {
    const f = fixture(); let release!: (r: Response) => void;
    f.intercept(call => call.json?.operation === 'prepare' ? new Promise<Response>(resolve => { release = resolve; }) : undefined);
    await f.controller.selectFile(f.selected); const uploading = f.controller.upload();
    await Promise.resolve(); f.setScope({ ...scope, session: 'different-owner-session' });
    // Ignoring abort does not grant permission to commit a late response.
    release(reply(control, { ...f.ready(), state: 'ready' })); await uploading;
    expect(f.controller.snapshot()).toMatchObject({ artifact: null, preview: null, fileSelected: false }); expect(f.calls).toHaveLength(1);
  });

  it('clears an in-flight selection immediately on explicit invalidation', async () => {
    const f = fixture(); let release!: (v: ArrayBuffer) => void;
    const delayed: MediaUploadFile = { name: f.selected.name, size: f.selected.size, type: f.selected.type,
      slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) }) as Blob };
    const hashing = f.controller.selectFile(delayed); await Promise.resolve(); f.controller.invalidate();
    await hashing; release(f.bytes.buffer as ArrayBuffer); await Promise.resolve();
    expect(f.controller.snapshot()).toMatchObject({ state: 'idle', artifact: null, fileSelected: false, busy: false }); expect(f.calls).toHaveLength(0);
  });

  for (const phase of ['hash', 'image-reread', 'response-stream', 'ignored-fetch'] as const) it(`bounds an ignored ${phase} wait`, async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
    const f = fixture('image', { requestTimeoutMs: 15, hashingTimeoutMs: 15 }); let reads = 0;
    if (phase === 'response-stream') f.intercept(() => new Response(new ReadableStream({ start() { /* fictional never-ending stream */ } }), { headers: { 'content-type': 'application/json' } }));
    if (phase === 'ignored-fetch') f.intercept(() => new Promise<Response>(() => undefined));
    const delayed: MediaUploadFile = { name: f.selected.name, size: f.selected.size, type: f.selected.type,
      slice: (start, end) => ({ arrayBuffer: () => {
        reads++; return phase === 'hash' || (phase === 'image-reread' && reads > 1) ? new Promise<ArrayBuffer>(() => undefined)
          : Promise.resolve(f.bytes.buffer.slice(start ?? 0, end ?? f.bytes.length) as ArrayBuffer);
      } }) as Blob };
    const selection = f.controller.selectFile(delayed);
    await vi.advanceTimersByTimeAsync(phase === 'hash' ? 15 : 0); await selection;
    if (phase !== 'hash') {
      expect(f.controller.snapshot().state).toBe('prepared');
      const upload = f.controller.upload(); await vi.advanceTimersByTimeAsync(15); await upload;
      expect(f.calls.length).toBeGreaterThan(0);
    }
    expect(f.controller.snapshot().busy).toBe(false); expect(f.controller.snapshot().state).not.toBe('ready');
    expect(f.controller.snapshot().message).toContain('could not be confirmed');
    } finally { vi.useRealTimers(); }
  });

  for (const mode of ['multibyte-overrun', 'length-short', 'length-long', 'invalid-utf8', 'wrong-artifact'] as const) it(`rejects ${mode} before showing success`, async () => {
    const f = fixture(); let cancelled = false;
    f.intercept(() => {
      if (mode === 'wrong-artifact') return reply(control, { ...f.ready(), artifactId: randomUUID() });
      const payload = mode === 'multibyte-overrun' ? new TextEncoder().encode('€'.repeat(350_000)) : mode === 'invalid-utf8' ? new Uint8Array([255]) : new TextEncoder().encode('{}');
      return new Response(new ReadableStream({ start(c) { c.enqueue(payload); }, cancel() { cancelled = true; } }),
        { headers: { 'content-type': 'application/json', ...(mode === 'length-short' ? { 'content-length': '1' } : mode === 'length-long' ? { 'content-length': '3' } : {}) } });
    });
    // Finite malformed streams must close; the overrun/short cases cancel before another read.
    if (mode === 'length-long' || mode === 'invalid-utf8') f.intercept(() => new Response(mode === 'invalid-utf8' ? new Uint8Array([255]) : '{}',
      { headers: { 'content-type': 'application/json', ...(mode === 'length-long' ? { 'content-length': '3' } : {}) } }));
    await f.controller.selectFile(f.selected); await f.controller.upload();
    expect(f.controller.snapshot().artifact).toBeNull(); expect(f.controller.snapshot().receivedParts).toBe(0);
    if (mode === 'multibyte-overrun' || mode === 'length-short') expect(cancelled).toBe(true);
  });

  it('does not duplicate a busy action and clears private information after an access refusal', async () => {
    const f = fixture(); await f.controller.selectFile(f.selected);
    await Promise.all([f.controller.upload(), f.controller.upload()]); expect(f.calls.filter(c => c.json?.operation === 'prepare')).toHaveLength(1);
    f.intercept(() => refusal(control, 'access_refused', 403)); await f.controller.preview();
    expect(f.controller.snapshot()).toMatchObject({ artifact: null, reference: null, preview: null, fileSelected: false });
  });

  it('keeps the host disabled refusal distinct from success or an empty catalog', async () => {
    const f = fixture(); f.intercept(() => refusal(control, 'program_media_disabled', 503));
    await f.controller.selectFile(f.selected); await f.controller.upload();
    expect(f.controller.snapshot().message).toContain('not enabled'); expect(f.controller.snapshot().artifact).toBeNull();
  });
});
