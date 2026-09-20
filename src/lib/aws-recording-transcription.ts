import { AdapterError } from '@/adapters/errors';
import { requestRecordingTranscription } from './recording-transcription-client';
import type { TranscriptionListing, TranscriptContent, TranscriptionOperation } from '@/contracts/encounterRecordingTranscription';

export type TranscriptionSnapshot = {
  recordingId: string; listing: TranscriptionListing | null; content: TranscriptContent | null;
  /** The exact request whose outcome is unknown. Only `request` is replayed, with its original command ID. */
  pending: Extract<TranscriptionOperation, { operation: 'request' }> | null;
  busy: boolean; error: string | null; notice: string;
};
type Options = { recordingId: string; changed?: (snapshot: TranscriptionSnapshot) => void; request?: typeof requestRecordingTranscription; uuid?: () => string };
const MESSAGES = {
  unauthenticated: 'Sign in again to renew workforce authorization, then return to this encounter.',
  forbidden: 'Transcription was refused. Every participant needs effective transcription consent, the recording must be finished, and no hold or deletion may apply.',
  conflict: 'The transcript changed elsewhere or this content is already the latest version. Load the latest version before trying again.',
  invalid: 'This request could not be accepted. Check the correction text and reason.',
  unavailable: 'The transcription service is unavailable. Nothing was changed on this page.',
} as const;

/** One page-owned transcription review per finished recording. One network
 * writer, explicit steps only: the service performs at most one bounded provider
 * or storage step per call and never drafts a note. Text stays in page memory. */
export class AwsRecordingTranscription {
  private readonly life = new AbortController();
  private readonly request: typeof requestRecordingTranscription;
  private readonly uuid: () => string;
  private state: TranscriptionSnapshot;
  private running = false;
  constructor(private readonly options: Options) {
    this.request = options.request ?? requestRecordingTranscription;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.state = { recordingId: options.recordingId, listing: null, content: null, pending: null, busy: false, error: null, notice: '' };
  }
  snapshot(): TranscriptionSnapshot { return { ...this.state }; }
  dispose() { this.life.abort(); this.state = { ...this.state, content: null, busy: false }; }
  private set(patch: Partial<TranscriptionSnapshot>) {
    if (this.life.signal.aborted) return;
    this.state = { ...this.state, ...patch }; this.options.changed?.(this.snapshot());
  }
  private async run<T>(operation: TranscriptionOperation, apply: (result: T) => Partial<TranscriptionSnapshot>) {
    if (this.running || this.life.signal.aborted) return;
    if (this.state.pending && !(operation.operation === 'request' && operation.input.commandId === this.state.pending.input.commandId)) return;
    this.running = true; this.set({ busy: true, error: null, notice: '' });
    try {
      const result = await this.request(operation, this.life.signal);
      if (this.life.signal.aborted) return;
      this.set({ ...apply(result.data as T), pending: null });
    } catch (failure) {
      if (this.life.signal.aborted) return;
      const safe = failure instanceof AdapterError ? failure : new AdapterError('unavailable');
      const uncertain = operation.operation === 'request' && ['unavailable', 'unknown'].includes(safe.code);
      this.set({ error: MESSAGES[safe.code as keyof typeof MESSAGES] ?? MESSAGES.unavailable,
        pending: uncertain ? operation : null, content: ['conflict', 'forbidden', 'unauthenticated', 'not_found'].includes(safe.code) ? null : this.state.content,
        notice: uncertain ? 'The request outcome is uncertain. Retry the same request; a second request is refused by the service.' : '' });
    } finally { this.running = false; this.set({ busy: false }); }
  }
  /** Reads the job and versions. Never returns text. */
  load() { return this.run<TranscriptionListing>({ operation: 'list', input: { recordingId: this.state.recordingId } }, listing => ({ listing })); }
  /** Starts a new job with a fresh command ID, or replays the pending one. */
  requestTranscription() {
    const operation = this.state.pending ?? { operation: 'request' as const, input: { recordingId: this.state.recordingId, commandId: this.uuid() } };
    return this.run<{ status: string; replayed: boolean }>(operation, receipt => ({
      notice: receipt.replayed ? 'The earlier request was already accepted.' : 'Transcription requested. Advance to run the next step.',
      listing: this.state.listing ? { ...this.state.listing, job: { ...(this.state.listing.job ?? { jobId: '', providerJobName: null, failureCode: null, segmentCount: 1,
        inventorySha256: '0'.repeat(64), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }), status: receipt.status as 'requested' } } : null }));
  }
  /** One bounded service step: assemble and start, or poll and store. */
  advance() { return this.run<TranscriptionListing>({ operation: 'advance', input: { recordingId: this.state.recordingId } }, listing => ({ listing,
    notice: listing.job?.status === 'completed' ? 'Transcript stored. Open a version to review it.' : listing.job?.status === 'failed'
      ? 'Transcription failed and no transcript was stored.' : listing.job?.status === 'processing' ? 'The provider is working. Advance again to check.' : '' })); }
  /** Fetches one version's text into page memory after digest verification by the service. */
  read(transcriptId: string) { return this.run<TranscriptContent>({ operation: 'read', input: { transcriptId } }, content => ({ content })); }
  /** Appends a correction as a new immutable version. */
  correct(text: string, reason: string) {
    if (!text.trim() || !reason.trim()) { this.set({ error: MESSAGES.invalid }); return Promise.resolve(); }
    return this.run<TranscriptionListing>({ operation: 'correct', input: { recordingId: this.state.recordingId, text, reason: reason.trim() } },
      listing => ({ listing, content: null, notice: 'Correction stored as a new version. Earlier versions remain unchanged.' }));
  }
  closeText() { this.set({ content: null }); }
}
