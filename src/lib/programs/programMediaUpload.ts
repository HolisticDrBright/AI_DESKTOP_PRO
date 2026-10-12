import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { PROGRAM_MEDIA_FAILURES, programMediaArtifact, programMediaReservation, programMediaPreview,
  programMediaReference, programMediaFileName, programMediaExtension,
  type ProgramMediaArtifact, type ProgramMediaReservation, type ProgramMediaReference, type ProgramMediaPreview, type ProgramMediaContentType } from '@/contracts/programMedia';
import { PROGRAM_MEDIA_HTTP_CONTRACT, PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT, PROGRAM_MEDIA_PART_BYTES,
  programMediaControlCommand, programMediaMultipartControlCommand, programMediaMultipartView, programMediaPartManifest,
  type ProgramMediaControlCommand, type ProgramMediaMultipartControlCommand, type ProgramMediaMultipartView,
  type ProgramMediaPartManifest } from '@/contracts/programMediaUpload';

/** No token, endpoint override, provider id, receipt proof or credential belongs
 * in this browser controller. Server cookie authority and SQL remain decisive. */
export type ProgramMediaUploadScope = { programId: string; draftId: string; stepId: string; session: string };
export type MediaUploadFile = Pick<File, 'name' | 'size' | 'type' | 'slice'>;
type Row = ProgramMediaArtifact | ProgramMediaReservation;
type Recipe = { programId: string; kind: 'image' | 'video'; contentType: ProgramMediaContentType; bytes: number; sha256: string; fileName: string };
export type MediaUploadView = {
  state: 'idle' | 'hashing' | 'prepared' | 'uploading' | 'waiting' | 'ready' | 'published' | 'refused';
  busy: boolean; authorityLost: boolean; fileSelected: boolean; hashedBytes: number; totalBytes: number; receivedParts: number; totalParts: number;
  artifact: Row | null; reference: ProgramMediaReference | null; preview: ProgramMediaPreview | null;
  message: string;
};
const empty = (): MediaUploadView => ({ state: 'idle', busy: false, authorityLost: false, fileSelected: false, hashedBytes: 0, totalBytes: 0,
  receivedParts: 0, totalParts: 0, artifact: null, reference: null, preview: null, message: '' });
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const scopeSchema = z.object({ programId: z.string().uuid(), draftId: z.string().uuid(), stepId: z.string().min(1).max(321), session: z.string().min(1).max(256) }).strict();
class UploadError extends Error { constructor(readonly code: string) { super(code); } }
const messages: Record<string, string> = {
  program_media_disabled: 'Media uploads are not enabled on this secure host. No upload was substituted.',
  access_refused: 'Your workforce access changed. Local file and preview information were cleared. Sign in and reopen this program.',
  storage_unverified: 'The educational media store could not be verified. Nothing is shown as uploaded.',
  request_invalid: 'This file or response did not match the upload. Use a supported type and a file name containing letters, numbers, dashes and underscores.',
  conflict: 'The service could not admit this step. Review the saved upload status before trying again.',
  reservation_expired: 'The saved upload expired. Review its status; do not assume its objects were removed.',
  not_found: 'This upload is unavailable to the current author and program.',
  service_unavailable: 'The result could not be confirmed. Check saved status before resuming. Cancellation or deletion is not confirmed.',
  pending: 'A previous write is still pending. Check saved status; no replacement write was started.',
  not_ready: 'This media is held or unavailable. It cannot be resumed, previewed or published as ready.',
  retired: 'This media was retired. It cannot be resumed or newly published.',
};

export function createProgramMediaUploadController(deps: {
  scope(): ProgramMediaUploadScope | null; fetch: typeof fetch; uuid?: () => string;
  requestTimeoutMs?: number; hashingTimeoutMs?: number;
}) {
  const fetcher = deps.fetch, uuid = deps.uuid ?? (() => crypto.randomUUID());
  const requestTimeout = deps.requestTimeoutMs ?? 35_000, hashingTimeout = deps.hashingTimeoutMs ?? 60_000;
  if (![requestTimeout, hashingTimeout].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 60_000)) throw new Error('media_upload_limits_invalid');
  let generation = 0, controller: AbortController | null = null, view = empty();
  let file: MediaUploadFile | null = null, recipe: Recipe | null = null, manifest: ProgramMediaPartManifest | null = null;
  let prepareId: string | null = null;
  const commands = new Map<string, string>(), listeners = new Set<(v: MediaUploadView) => void>();
  const emit = (patch: Partial<MediaUploadView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(structuredClone(view)); };
  const commandId = (key: string) => { const previous = commands.get(key); if (previous) return previous; const id = uuid(); commands.set(key, id); return id; };
  function invalidate() {
    generation++; controller?.abort(); controller = null; file = null; recipe = null; manifest = null; prepareId = null; commands.clear();
    view = empty(); for (const listener of listeners) listener(structuredClone(view));
  }
  function context() {
    const current = scopeSchema.safeParse(deps.scope()); if (!current.success) throw new UploadError('access_refused');
    const key = JSON.stringify(current.data), epoch = generation, signal = controller!.signal;
    const live = () => { const latest = scopeSchema.safeParse(deps.scope());
      if (epoch !== generation || signal.aborted || !latest.success || JSON.stringify(latest.data) !== key) throw new UploadError('access_refused'); };
    return { scope: current.data, signal, live };
  }
  async function wait<T>(pending: Promise<T>, live: () => void, signal: AbortSignal): Promise<T> {
    const observed = pending.then(v => { live(); return v; });
    let abort: (() => void) | undefined;
    try { live(); return await Promise.race([observed, new Promise<never>((_, reject) => {
      abort = () => { try { live(); } catch (error) { reject(error); return; } reject(new UploadError('access_refused')); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    })]); } finally { if (abort) signal.removeEventListener('abort', abort); void observed.catch(() => undefined); }
  }
  async function request(path: string, method: 'POST' | 'PUT', body: string | Uint8Array,
    contract: string, live: () => void, signal: AbortSignal, extra: Record<string, string> = {}) {
    live(); const timerController = new AbortController(), bound = AbortSignal.any([signal, timerController.signal]);
    const timer = setTimeout(() => timerController.abort(), requestTimeout);
    const checked = () => { live(); if (bound.aborted) throw new UploadError('service_unavailable'); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      const response = await wait(fetcher(path, { method, body: body as BodyInit, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: bound,
        headers: { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream', accept: 'application/json', ...extra } }), checked, bound);
      responseBody = response.body; checked(); if (response.status === 401 || response.status === 403) throw new UploadError('access_refused');
      if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new UploadError('service_unavailable');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > 1_048_576)) throw new UploadError('service_unavailable');
      reader = response.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const next = await wait(reader.read(), checked, bound); checked(); if (next.done) break;
        total += next.value.byteLength; if (total > 1_048_576 || (length !== null && total > Number(length))) throw new UploadError('service_unavailable');
        chunks.push(next.value);
      }
      if (length !== null && total !== Number(length)) throw new UploadError('service_unavailable');
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const envelope = z.object({ contractVersion: z.string(), ok: z.boolean(), data: z.unknown().optional(),
        error: z.object({ code: z.enum(PROGRAM_MEDIA_FAILURES) }).strict().optional() }).strict().parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      checked();
      if (!envelope.ok) throw new UploadError(envelope.error?.code ?? 'service_unavailable');
      if (!response.ok || envelope.contractVersion !== contract || envelope.error) throw new UploadError('service_unavailable');
      return envelope.data;
    } catch (error) { live(); if (error instanceof UploadError) throw error; throw new UploadError('service_unavailable'); }
    finally { clearTimeout(timer); timerController.abort();
      if (reader) { void reader.cancel().catch(() => undefined); } else if (responseBody) { void responseBody.cancel().catch(() => undefined); } }
  }
  const metadata = (command: ProgramMediaControlCommand, c: ReturnType<typeof context>) => request('/api/live/programs/media/control', 'POST',
    JSON.stringify(programMediaControlCommand.parse(command)), PROGRAM_MEDIA_HTTP_CONTRACT, c.live, c.signal);
  async function multipart(command: ProgramMediaMultipartControlCommand, c: ReturnType<typeof context>) {
    const answer = programMediaMultipartView.parse(await request('/api/live/programs/media/multipart/control', 'POST',
      JSON.stringify(programMediaMultipartControlCommand.parse(command)), PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT, c.live, c.signal));
    checkMultipart(answer, command.request.artifactId); return answer;
  }
  function checkRow(answer: unknown): Row {
    const row = z.union([programMediaArtifact, programMediaReservation]).parse(answer);
    if (!recipe || row.bytes > (row.kind === 'image' ? 16_777_216 : 268_435_456) || row.programId !== recipe.programId || row.sha256 !== recipe.sha256 || row.bytes !== recipe.bytes || row.kind !== recipe.kind || row.contentType !== recipe.contentType
      || (view.artifact && (row.artifactId !== view.artifact.artifactId || row.clinic !== view.artifact.clinic))
      || row.objectKey !== `program-media/${row.clinic}/${row.programId}/${row.artifactId}/${row.sha256}.${programMediaExtension(row.kind, row.contentType)}`) throw new UploadError('service_unavailable');
    return row;
  }
  function checkMultipart(row: ProgramMediaMultipartView, artifactId: string) {
    if (!recipe || row.artifactId !== artifactId || row.bytes !== recipe.bytes || row.sha256 !== recipe.sha256 || row.contentType !== recipe.contentType) throw new UploadError('service_unavailable');
    emit({ receivedParts: row.receivedParts.length, totalParts: Math.ceil(row.bytes / PROGRAM_MEDIA_PART_BYTES) });
  }
  async function hashFile(selected: MediaUploadFile, c: ReturnType<typeof context>) {
    const kind = selected.type.startsWith('image/') ? 'image' : 'video', extension = programMediaExtension(kind, selected.type);
    if (!extension || !programMediaFileName.safeParse(selected.name).success || !selected.name.endsWith('.' + extension)
      || !Number.isSafeInteger(selected.size) || selected.size < 1 || selected.size > (kind === 'image' ? 16_777_216 : 268_435_456)) throw new UploadError('request_invalid');
    const whole = sha256.create(), parts: ProgramMediaPartManifest['parts'] = [], started = Date.now();
    const deadlineController = new AbortController(), bound = AbortSignal.any([c.signal, deadlineController.signal]);
    const timer = setTimeout(() => deadlineController.abort(), hashingTimeout);
    const live = () => { c.live(); if (bound.aborted || Date.now() - started >= hashingTimeout) throw new UploadError('service_unavailable'); };
    emit({ state: 'hashing', totalBytes: selected.size, hashedBytes: 0 });
    try {
      for (let offset = 0; offset < selected.size; offset += PROGRAM_MEDIA_PART_BYTES) {
        live();
        const size = Math.min(PROGRAM_MEDIA_PART_BYTES, selected.size - offset);
        const data = new Uint8Array(await wait(selected.slice(offset, offset + size).arrayBuffer(), live, bound));
        if (data.byteLength !== size) throw new UploadError('request_invalid'); whole.update(data);
        parts.push({ partNumber: parts.length + 1, bytes: size, sha256: hex(sha256(data)) });
        emit({ hashedBytes: offset + size });
        await wait(new Promise<void>(resolve => setTimeout(resolve, 0)), live, bound);
      }
      return { recipe: { programId: c.scope.programId, kind, contentType: selected.type, bytes: selected.size, sha256: hex(whole.digest()), fileName: selected.name } as Recipe,
        manifest: kind === 'video' ? programMediaPartManifest.parse({ totalBytes: selected.size, parts }) : null };
    } finally { clearTimeout(timer); deadlineController.abort(); whole.destroy(); }
  }
  async function readFilePart(selected: MediaUploadFile, start: number, end: number, c: ReturnType<typeof context>) {
    const deadlineController = new AbortController(), bound = AbortSignal.any([c.signal, deadlineController.signal]);
    const timer = setTimeout(() => deadlineController.abort(), requestTimeout);
    const live = () => { c.live(); if (bound.aborted) throw new UploadError('service_unavailable'); };
    try { return new Uint8Array(await wait(selected.slice(start, end).arrayBuffer(), live, bound)); }
    finally { clearTimeout(timer); deadlineController.abort(); }
  }
  const rowState = (row: Row): MediaUploadView['state'] => row.state === 'ready' ? 'ready' : row.state === 'reserved' ? 'waiting' : 'refused';
  async function run(action: (c: ReturnType<typeof context>) => Promise<void>) {
    if (view.busy) return; controller = new AbortController(); const epoch = generation; emit({ busy: true, message: '' });
    try { await action(context()); }
    catch (error) {
      if (epoch !== generation) return;
      const code = error instanceof UploadError ? error.code : 'service_unavailable';
      if (code === 'access_refused') { invalidate(); emit({ authorityLost: true, message: messages.access_refused }); }
      else emit({ state: view.artifact && view.artifact.state === 'reserved' ? 'waiting'
        : !view.artifact && file && recipe && prepareId && code === 'service_unavailable' ? 'prepared' : 'refused',
        preview: null, message: messages[code] ?? messages.service_unavailable });
    } finally { if (epoch === generation) { controller = null; emit({ busy: false }); } }
  }
  async function inspect(c: ReturnType<typeof context>, artifactId: string) {
    const row = checkRow(await metadata({ operation: 'inspect', request: { artifactId } }, c));
    emit({ artifact: row, state: rowState(row), preview: null,
      message: row.state === 'retired' ? messages.retired : row.state !== 'ready' && row.state !== 'reserved' ? messages.not_ready : '' }); return row;
  }
  return {
    subscribe(listener: (v: MediaUploadView) => void) { listeners.add(listener); listener(structuredClone(view)); return () => { listeners.delete(listener); }; },
    snapshot: () => structuredClone(view), invalidate,
    clearPreview(message?: string) { emit({ preview: null, ...(message ? { message } : {}) }); },
    selectFile(selected: MediaUploadFile) {
      if (view.busy) return Promise.resolve(); const existing = view.artifact;
      if (!existing) invalidate(); else { file = null; emit({ fileSelected: false, preview: null, reference: null }); }
      return run(async c => { const measured = await hashFile(selected, c);
        if (existing && (existing.programId !== c.scope.programId || existing.sha256 !== measured.recipe.sha256 || existing.bytes !== measured.recipe.bytes
          || existing.kind !== measured.recipe.kind || existing.contentType !== measured.recipe.contentType)) throw new UploadError('request_invalid');
        file = selected; recipe = measured.recipe; manifest = measured.manifest; prepareId = uuid();
        emit({ state: 'prepared', fileSelected: true, totalParts: manifest?.parts.length ?? 1,
          message: existing ? 'Exact file checked locally. Check or resume the existing upload; no replacement was prepared.' : 'File checked locally. It has not been sent yet.' }); });
    },
    upload() { return run(async c => {
      if (!recipe || !file || !prepareId) throw new UploadError('request_invalid');
      if (!view.artifact) {
        const row = checkRow(await metadata({ operation: 'prepare', request: { ...recipe, commandId: prepareId } }, c));
        if (!('commandId' in row) || row.commandId !== prepareId) throw new UploadError('service_unavailable'); emit({ artifact: row });
      }
      const artifact = view.artifact!; if (artifact.state === 'ready') { emit({ state: 'ready' }); return; }
      if (artifact.state !== 'reserved') throw new UploadError(artifact.state === 'retired' ? 'retired' : 'not_ready');
      emit({ state: 'uploading' });
      if (recipe.kind === 'image') {
        const body = await readFilePart(file, 0, recipe.bytes, c);
        if (body.byteLength !== recipe.bytes || hex(sha256(body)) !== recipe.sha256) throw new UploadError('request_invalid');
        const row = checkRow(await request('/api/live/programs/media/image/' + artifact.artifactId, 'PUT', body, 'program-media-image-http/1', c.live, c.signal));
        if (row.state !== 'ready') throw new UploadError('service_unavailable'); emit({ artifact: row, state: 'ready', receivedParts: 1 }); return;
      }
      if (!manifest) throw new UploadError('request_invalid');
      let status: ProgramMediaMultipartView;
      try { status = await multipart({ operation: 'status', request: { artifactId: artifact.artifactId } }, c); }
      catch (error) { if (!(error instanceof UploadError) || error.code !== 'not_found') throw error;
        status = await multipart({ operation: 'start', request: { artifactId: artifact.artifactId, commandId: commandId('start'), manifest } }, c); }
      if (status.pendingWork) throw new UploadError('pending');
      if (status.state === 'prepared') status = await multipart({ operation: 'create', request: { artifactId: artifact.artifactId, commandId: commandId('create') } }, c);
      if (status.pendingWork) throw new UploadError('pending');
      if (status.state === 'uploading') for (const part of manifest.parts) {
        if (status.receivedParts.includes(part.partNumber)) continue;
        const start = (part.partNumber - 1) * PROGRAM_MEDIA_PART_BYTES, body = await readFilePart(file, start, start + part.bytes, c);
        if (body.byteLength !== part.bytes || hex(sha256(body)) !== part.sha256) throw new UploadError('request_invalid');
        status = programMediaMultipartView.parse(await request(`/api/live/programs/media/multipart/part/${artifact.artifactId}/${part.partNumber}/${commandId('part:' + part.partNumber)}`,
          'PUT', body, PROGRAM_MEDIA_MULTIPART_REQUEST_CONTRACT, c.live, c.signal, { 'x-alp-part-sha256': part.sha256 }));
        checkMultipart(status, artifact.artifactId); if (status.pendingWork || !status.receivedParts.includes(part.partNumber)) throw new UploadError('pending');
      }
      if (status.state === 'uploading') status = await multipart({ operation: 'complete', request: { artifactId: artifact.artifactId, commandId: commandId('complete') } }, c);
      if (status.state !== 'committed') throw new UploadError('pending');
      await inspect(c, artifact.artifactId);
    }); },
    restore(artifactId: string) { return run(async c => {
      if (!z.string().uuid().safeParse(artifactId).success) throw new UploadError('request_invalid');
      const row = z.union([programMediaArtifact, programMediaReservation]).parse(await metadata({ operation: 'inspect', request: { artifactId } }, c));
      if (row.programId !== c.scope.programId || row.artifactId !== artifactId) throw new UploadError('not_found');
      if (view.artifact && (view.artifact.artifactId !== row.artifactId || view.artifact.clinic !== row.clinic)) throw new UploadError('request_invalid');
      if (recipe && (row.sha256 !== recipe.sha256 || row.bytes !== recipe.bytes || row.kind !== recipe.kind || row.contentType !== recipe.contentType)) throw new UploadError('request_invalid');
      if (row.bytes > (row.kind === 'image' ? 16_777_216 : 268_435_456) || row.objectKey !== `program-media/${row.clinic}/${row.programId}/${row.artifactId}/${row.sha256}.${programMediaExtension(row.kind, row.contentType)}`) throw new UploadError('service_unavailable');
      recipe = { programId: row.programId, kind: row.kind, contentType: row.contentType, bytes: row.bytes, sha256: row.sha256, fileName: '' };
      const totalParts = row.kind === 'image' ? 1 : Math.ceil(row.bytes / PROGRAM_MEDIA_PART_BYTES);
      emit({ artifact: row, totalBytes: row.bytes, totalParts, receivedParts: row.state === 'ready' ? totalParts : 0, state: rowState(row), preview: null, reference: null,
        message: row.state === 'ready' ? 'Saved media is ready for review.' : row.state === 'retired' ? messages.retired : row.state !== 'reserved' ? messages.not_ready
          : 'Saved upload found. Reselect the exact file before resuming; pending writes are not assumed settled.' });
    }); },
    checkStatus() { return run(async c => {
      if (!view.artifact) throw new UploadError('request_invalid');
      if (recipe?.kind === 'video' && view.artifact.state !== 'ready') {
        let state: ProgramMediaMultipartView;
        try { state = await multipart({ operation: 'reconcile', request: { artifactId: view.artifact.artifactId } }, c); }
        catch (error) { if (!(error instanceof UploadError) || error.code !== 'not_found') throw error;
          await inspect(c, view.artifact.artifactId); emit({ message: 'Saved reservation found. No multipart upload has been started.' }); return; }
        if (state.pendingWork || state.state !== 'committed') { emit({ state: 'waiting', message: messages.pending }); return; }
      }
      await inspect(c, view.artifact.artifactId);
    }); },
    attachText(text: string, slot: 'caption' | 'transcript' = 'caption') { return run(async c => {
      const artifact = view.artifact; if (!artifact || !('version' in artifact) || artifact.state !== 'ready') throw new UploadError('request_invalid');
      const row = checkRow(await metadata({ operation: 'attachText', request: { artifactId: artifact.artifactId, expectedVersion: artifact.version,
        slot, text, source: 'supplied_by_author', format: 'plain' } }, c));
      if (!('version' in row) || row[slot]?.text !== text || row[slot]?.sha256 !== hex(sha256(new TextEncoder().encode(text)))) throw new UploadError('service_unavailable');
      emit({ artifact: row, state: 'ready', reference: null, preview: null, message: 'Supplied text saved. It was not generated or clinically approved.' });
    }); },
    preview() { return run(async c => {
      const artifact = view.artifact; if (!artifact || !('version' in artifact) || artifact.state !== 'ready') throw new UploadError('request_invalid');
      const row = programMediaPreview.parse(await metadata({ operation: 'preview', request: { artifactId: artifact.artifactId } }, c));
      const url = new URL(row.previewToken);
      if (row.artifactId !== artifact.artifactId || row.version !== artifact.version || row.sha256 !== artifact.sha256 || row.bytes !== artifact.bytes
        || row.kind !== artifact.kind || row.contentType !== artifact.contentType || row.historical || row.state !== 'ready'
        || new Date(row.previewUntil).getTime() <= Date.now() || new Date(row.previewUntil).getTime() > Date.now() + 300_000
        || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !/^[a-z0-9-]+\.s3\.us-east-2\.amazonaws\.com$/.test(url.hostname)
        || decodeURIComponent(url.pathname) !== '/' + artifact.objectKey || url.searchParams.getAll('versionId').length !== 1
        || url.searchParams.get('versionId') !== artifact.objectVersion) throw new UploadError('service_unavailable');
      emit({ preview: row });
    }); },
    publish() { return run(async c => {
      const artifact = view.artifact; if (!artifact || !('version' in artifact) || artifact.state !== 'ready' || !artifact.caption) throw new UploadError('request_invalid');
      const row = programMediaReference.parse(await metadata({ operation: 'publish', request: { artifactId: artifact.artifactId, expectedVersion: artifact.version } }, c));
      if (row.artifactId !== artifact.artifactId || row.version !== artifact.version || row.sha256 !== artifact.sha256 || row.bytes !== artifact.bytes
        || row.origin.clinic !== artifact.clinic || row.origin.programId !== artifact.programId || row.kind !== artifact.kind || row.contentType !== artifact.contentType
        || row.caption?.sha256 !== artifact.caption.sha256) throw new UploadError('service_unavailable');
      emit({ state: 'published', reference: row, message: 'Exact media reference published. It has not been added to a patient course or protocol.' });
    }); },
    cancel() { return run(async c => {
      if (!view.artifact || recipe?.kind !== 'video') throw new UploadError('request_invalid');
      const status = await multipart({ operation: 'cancel', request: { artifactId: view.artifact.artifactId } }, c);
      emit({ state: 'waiting', preview: null, message: status.state === 'aborted' ? 'The service verified this upload was aborted.'
        : 'Cancellation requested. Remote writes or cleanup may still be pending; deletion is not confirmed.' });
    }); },
  };
}
