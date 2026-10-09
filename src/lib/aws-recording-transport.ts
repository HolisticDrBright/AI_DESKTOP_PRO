import { AdapterError } from '@/adapters/errors';
import { requestRecordingCapture } from './recording-capture-client';
import { isRecordingReadinessCurrent, parseRecordingCaptureResponse, recordingStartReceiptSchema,
  recordingLifecycleReceiptSchema, recordingRecoveryStateSchema, recordingSegmentReceiptSchema,
  type RecordingReadiness, type RecordingCaptureRequest, type RecordingRecoveryState } from '@/contracts/encounterRecordingCapture';

type StartReceipt = ReturnType<typeof recordingStartReceiptSchema.parse>;
type Request = RecordingCaptureRequest;
type Pending = { request: Request; bytes?: ArrayBuffer };
export type CaptureTransportPhase = 'idle' | 'ready' | 'starting' | 'recording' | 'paused' | 'uncertain'
  | 'recovery_required' | 'finished' | 'discarded' | 'disposed';
export type CaptureTransportSnapshot = {
  phase: CaptureTransportPhase; recordingId: string | null; sessionId: string | null;
  bufferedBytes: number; bufferedSegments: number; storedSegments: number;
  incomplete: boolean; pendingOperation: Request['operation'] | null; busy: boolean;
};
type Options = {
  encounterId: string;
  /** Must synchronously pause the recorder and stop/release microphone tracks.
   * This callback is invoked BEFORE exposing a failure or expired authorization. */
  halt: () => void;
  changed?: (snapshot: CaptureTransportSnapshot) => void;
  request?: typeof requestRecordingCapture;
  now?: () => number;
  monotonic?: () => number;
  uuid?: () => string;
  digest?: (bytes: ArrayBuffer) => Promise<string>;
};
const BUFFER_LIMIT = 8 * 1024 * 1024;
const AUTHORITY_FRESHNESS = 20000;

/** One page-owned, memory-only capture transport. There is exactly one network
 * writer, so credential rotation cannot race an upload. No automatic retries,
 * no stored tokens, no provider access and no claims of durable local recovery.
 * A browser media owner must stop on halt(), page hiding and disposal.
 */
export class AwsRecordingTransport {
  private readonly life = new AbortController();
  private readonly request: typeof requestRecordingCapture;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly uuid: () => string;
  private readonly digest: (bytes: ArrayBuffer) => Promise<string>;
  private readiness: RecordingReadiness | null = null;
  private capture: StartReceipt | null = null;
  private phase: CaptureTransportPhase = 'idle';
  private pending: Pending | null = null;
  private queue: Blob[] = [];
  private bufferedBytes = 0;
  private acceptedBytes = 0;
  private sequence = 0;
  private incomplete = false;
  private controlling = false;
  private uploading: Promise<void> | null = null;
  private lastAuthority = 0;
  private haltEpoch = 0;
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(private readonly options: Options) {
    this.request = options.request ?? requestRecordingCapture;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.digest = options.digest ?? (async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(v => v.toString(16).padStart(2, '0')).join(''));
    this.watchdog = setInterval(() => this.tick(), 500);
  }

  snapshot(): CaptureTransportSnapshot {
    return { phase: this.phase, recordingId: this.capture?.recordingId ?? null, sessionId: this.capture?.sessionId ?? null,
      bufferedBytes: this.bufferedBytes, bufferedSegments: this.queue.length, storedSegments: this.sequence,
      incomplete: this.incomplete, pendingOperation: this.pending?.request.operation ?? null,
      busy: this.controlling || this.uploading !== null };
  }
  private emit() { if (!this.life.signal.aborted) this.options.changed?.(this.snapshot()); }
  private halt(phase: CaptureTransportPhase) {
    this.haltEpoch++;
    this.phase = phase;
    try { this.options.halt(); } finally { this.emit(); }
  }
  private alive() { if (this.life.signal.aborted) throw new Error('recording_disposed'); }
  private fresh() {
    const elapsed = this.monotonic() - this.lastAuthority;
    return this.capture?.captureToken && elapsed >= 0 && elapsed < AUTHORITY_FRESHNESS
      && this.now() < Math.min(Date.parse(this.capture.expiresAt), Date.parse(this.capture.deletionDeadline));
  }
  private tick() {
    if (this.phase !== 'recording') return;
    if (!this.fresh()) { this.halt('paused'); return; }
    // Upload receipts already recheck consent. In silence/no-data periods,
    // renewal rechecks the actual grants; a recovery-state read would not.
    if (!this.controlling && !this.uploading && !this.pending && (this.monotonic() - this.lastAuthority >= 10000
      || Date.parse(this.capture!.expiresAt) - this.now() <= 30000)) void this.renew().catch(() => {});
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.alive();
    if (this.controlling) throw new Error('recording_busy');
    this.controlling = true; this.emit();
    try { await this.uploading; this.alive(); return await work(); }
    finally { this.controlling = false; this.emit(); this.pump(); }
  }
  private async read(request: Request, signal?: AbortSignal) {
    this.alive();
    const controller = new AbortController();
    const combined = AbortSignal.any([this.life.signal, controller.signal, ...(signal ? [signal] : [])]);
    let cancel = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(new AdapterError('unavailable'));
      combined.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), request.operation === 'start' ? 8000 : 15000);
    try {
      if (combined.aborted) throw new AdapterError('unavailable');
      const value = await Promise.race([this.request(request, combined, undefined), interrupted]);
      this.alive();
      if (combined.aborted) throw new AdapterError('unavailable');
      return parseRecordingCaptureResponse(request, value).data;
    } finally { clearTimeout(timer); combined.removeEventListener('abort', cancel); controller.abort(); }
  }
  private async write(pending: Pending, signal?: AbortSignal) {
    this.alive(); this.pending = pending;
    const controller = new AbortController();
    const combined = AbortSignal.any([this.life.signal, controller.signal, ...(signal ? [signal] : [])]);
    let cancel = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(new AdapterError('unavailable'));
      combined.addEventListener('abort', cancel, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), pending.request.operation === 'start' ? 8000 : 15000);
    try {
      if (combined.aborted) throw new AdapterError('unavailable');
      const response = await Promise.race([this.request(pending.request, combined, pending.bytes), interrupted]);
      this.alive();
      if (combined.aborted) throw new AdapterError('unavailable');
      const data = parseRecordingCaptureResponse(pending.request, response).data;
      this.pending = null;
      return data;
    } catch (error) {
      if (!this.life.signal.aborted) this.halt('uncertain');
      throw error;
    } finally { clearTimeout(timer); combined.removeEventListener('abort', cancel); controller.abort(); }
  }
  private noPending() { if (this.pending) throw new Error('recording_outcome_uncertain'); }

  async check(): Promise<RecordingReadiness> {
    return this.exclusive(async () => {
      this.noPending();
      if (this.capture) throw new Error('recording_disposition_required');
      this.readiness = null; this.phase = 'idle';
      const data = await this.read({ operation: 'readiness', input: { encounterId: this.options.encounterId } });
      if (!isRecordingReadinessCurrent(data, this.options.encounterId, this.now())) throw new Error('recording_not_ready');
      this.readiness = data; this.phase = 'ready'; return data;
    });
  }
  async start(contentType: StartReceipt['contentType'], signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      this.noPending();
      if (this.capture || !isRecordingReadinessCurrent(this.readiness, this.options.encounterId, this.now())
        || !this.readiness.contentTypes.includes(contentType)) throw new Error('recording_not_ready');
      this.phase = 'starting';
      const epoch = this.haltEpoch;
      const result = recordingStartReceiptSchema.parse(await this.write({ request: { operation: 'start', input: {
        encounterId: this.options.encounterId, commandId: this.uuid(), contentType } } }, signal));
      this.acceptStart(result);
      if (epoch !== this.haltEpoch && this.snapshot().phase === 'recording') this.halt('paused');
      if (this.snapshot().phase !== 'recording') throw new Error('recording_recovery_required');
    });
  }
  private acceptStart(receipt: StartReceipt) {
    this.capture = receipt;
    if (receipt.replayed || !receipt.captureToken || Date.parse(receipt.expiresAt) <= this.now()
      || Date.parse(receipt.deletionDeadline) <= this.now() || receipt.authorityEpoch !== this.readiness?.authorityEpoch) {
      this.halt('recovery_required'); return;
    }
    this.lastAuthority = this.monotonic(); this.phase = 'recording';
  }

  /** Split encoded bytes, never infer audio duration or combine a new recorder
   * header with an existing capture. The media owner keeps ONE recorder. */
  enqueue(chunk: Blob): boolean {
    if (this.life.signal.aborted || !this.capture || !this.readiness || this.incomplete
      || !['recording', 'paused', 'uncertain', 'recovery_required'].includes(this.phase) || !chunk.size) return false;
    const count = Math.ceil(chunk.size / this.readiness.maxSegmentBytes);
    if (this.bufferedBytes + chunk.size > BUFFER_LIMIT || this.acceptedBytes + chunk.size > this.readiness.maxRecordingBytes
      || this.sequence + this.queue.length + count > this.readiness.maxSegments) {
      this.incomplete = true; this.halt('recovery_required'); return false;
    }
    for (let offset = 0; offset < chunk.size; offset += this.readiness.maxSegmentBytes)
      this.queue.push(chunk.slice(offset, offset + this.readiness.maxSegmentBytes));
    this.bufferedBytes += chunk.size; this.acceptedBytes += chunk.size;
    this.emit(); this.pump(); return true;
  }
  private pump() {
    if (this.life.signal.aborted || this.controlling || this.uploading || this.pending || this.phase !== 'recording' || !this.queue.length) return;
    this.uploading = this.drain().catch(() => {
      if (!this.life.signal.aborted && !this.pending) this.halt('recovery_required');
    }).finally(() => { this.uploading = null; this.emit(); this.pump(); });
  }
  private async drain(all = false) {
    while (this.queue.length && this.phase === 'recording' && !this.pending) {
      this.alive();
      if (!this.fresh()) { this.halt('paused'); return; }
      const chunk = this.queue[0], bytes = await chunk.arrayBuffer(), sha256 = await this.digest(bytes);
      this.alive();
      if (!this.fresh() || this.phase !== 'recording') { this.halt('paused'); return; }
      const c = this.capture!;
      const request: Request = { operation: 'segment', input: { recordingId: c.recordingId, sessionId: c.sessionId,
        captureToken: c.captureToken!, sequence: this.sequence, sha256, bytes: bytes.byteLength, contentType: c.contentType } };
      const receipt = recordingSegmentReceiptSchema.parse(await this.write({ request, bytes }));
      this.acceptSegment(receipt, chunk);
      this.emit();
      if (this.controlling && !all) return;
    }
  }
  private acceptSegment(receipt: ReturnType<typeof recordingSegmentReceiptSchema.parse>, chunk: Blob) {
    if (receipt.authorityEpoch !== this.capture?.authorityEpoch || this.queue[0] !== chunk) {
      this.halt('recovery_required'); throw new Error('recording_authority_mismatch');
    }
    this.queue.shift(); this.bufferedBytes -= chunk.size; this.sequence++;
    this.lastAuthority = this.monotonic();
  }
  private async state(signal?: AbortSignal): Promise<RecordingRecoveryState> {
    if (!this.capture) throw new Error('recording_not_started');
    const state = recordingRecoveryStateSchema.parse(await this.read({ operation: 'state', input: { recordingId: this.capture.recordingId } }, signal));
    if (state.sessionId !== this.capture.sessionId) throw new Error('recording_session_mismatch');
    return state;
  }
  private async command(action: 'pause' | 'resume' | 'renew' | 'finish' | 'discard', state?: RecordingRecoveryState, signal?: AbortSignal) {
    this.noPending();
    if (!this.capture) throw new Error('recording_not_started');
    const request: Request = { operation: 'command', input: { recordingId: this.capture.recordingId, commandId: this.uuid(), action,
      expectedVersion: state?.credentialVersion ?? this.capture.credentialVersion,
      inventorySha256: action === 'finish' || action === 'discard' ? state!.inventorySha256 : null } };
    const epoch = this.haltEpoch;
    const receipt = recordingLifecycleReceiptSchema.parse(await this.write({ request }, signal));
    this.acceptCommand(receipt);
    if (epoch !== this.haltEpoch && this.phase === 'recording') this.halt('paused');
  }
  private acceptCommand(receipt: ReturnType<typeof recordingLifecycleReceiptSchema.parse>) {
    this.capture = { ...this.capture!, credentialVersion: receipt.credentialVersion, expiresAt: receipt.expiresAt,
      status: receipt.statusAtCommand, captureToken: receipt.captureToken };
    if (receipt.action === 'finish' || receipt.action === 'discard') {
      this.phase = receipt.action === 'finish' ? 'finished' : 'discarded';
      this.queue = []; this.bufferedBytes = 0; return;
    }
    if (receipt.requiresCredentialRecovery) { this.halt('recovery_required'); return; }
    if (receipt.action === 'pause') { this.phase = 'paused'; return; }
    if (!receipt.captureToken || Date.parse(receipt.expiresAt) <= this.now()) { this.halt('recovery_required'); return; }
    this.lastAuthority = this.monotonic(); this.phase = 'recording';
  }
  async pause(): Promise<void> {
    if (!this.capture || !['recording', 'paused'].includes(this.phase)) throw new Error('recording_not_active');
    this.alive(); this.halt('paused');
    return this.exclusive(async () => { this.noPending(); await this.command('pause'); });
  }
  async resume(signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      this.noPending();
      if (!['paused','recovery_required'].includes(this.phase) || this.incomplete) throw new Error('recording_recovery_required');
      const state = await this.state(signal);
      if (!this.capture || state.currentAuthorityEpoch !== this.capture.authorityEpoch
        || state.authorityEpoch !== this.capture.authorityEpoch || state.nextSequence !== this.sequence
        || state.pendingSegments || state.storedSegments !== this.sequence || state.credentialVersion !== this.capture.credentialVersion
        || !['paused', 'capturing'].includes(state.status)) {
        this.halt('recovery_required'); throw new Error('recording_state_changed');
      }
      await this.command(state.status === 'paused' ? 'resume' : 'renew', state, signal);
    });
  }
  private async renew(): Promise<void> {
    return this.exclusive(async () => {
      this.noPending(); if (this.phase !== 'recording') return;
      await this.command('renew');
    });
  }
  /** Called only after the media owner's final dataavailable + stop event. */
  async finish(): Promise<void> {
    return this.exclusive(async () => {
      this.noPending();
      if (this.incomplete || this.phase !== 'recording') throw new Error('recording_recovery_required');
      await this.drain(true); this.noPending();
      if (this.queue.length || !this.sequence) throw new Error('recording_upload_incomplete');
      this.halt('paused');
      const state = await this.state();
      if (state.pendingSegments || state.storedSegments !== this.sequence || state.currentAuthorityEpoch !== this.capture!.authorityEpoch
        || state.credentialVersion !== this.capture!.credentialVersion || !['capturing','paused'].includes(state.status))
        throw new Error('recording_state_changed');
      await this.command('finish', state);
    });
  }
  async discard(): Promise<void> {
    if (!this.capture || ['finished','discarded','disposed'].includes(this.phase)) throw new Error('recording_not_active');
    this.alive(); this.halt('paused');
    return this.exclusive(async () => {
      this.noPending(); const state = await this.state(); await this.command('discard', state);
    });
  }
  /** Explicit retry only. A secret-free replay never starts/resumes a microphone.
   * An acknowledged upload is removed only once, with original sequence/hash. */
  async retry(): Promise<void> {
    return this.exclusive(async () => {
      const pending = this.pending; if (!pending) throw new Error('recording_no_pending_request');
      const result = await this.write(pending);
      if (pending.request.operation === 'start') this.acceptStart(recordingStartReceiptSchema.parse(result));
      else if (pending.request.operation === 'command') this.acceptCommand(recordingLifecycleReceiptSchema.parse(result));
      else if (pending.request.operation === 'segment') this.acceptSegment(recordingSegmentReceiptSchema.parse(result), this.queue[0]);
      if (this.phase === 'recording' || pending.request.operation === 'segment') this.halt('paused');
    });
  }
  /** Safety stop is local and synchronous, even while an HTTP request is stuck.
   * The server outcome is not assumed rolled back; use explicit recovery. */
  interrupt() {
    if (!this.life.signal.aborted && ['starting','recording'].includes(this.phase)) this.halt('paused');
  }
  failCapture() {
    if (!this.life.signal.aborted && !['finished','discarded'].includes(this.phase)) {
      this.incomplete = true; this.halt('recovery_required');
    }
  }
  dispose() {
    if (this.life.signal.aborted) return;
    try { this.halt('disposed'); } finally {
      this.life.abort(); clearInterval(this.watchdog);
      this.queue = []; this.bufferedBytes = 0; this.pending = null;
      if (this.capture) this.capture = { ...this.capture, captureToken: null };
      this.readiness = null;
    }
  }
}
