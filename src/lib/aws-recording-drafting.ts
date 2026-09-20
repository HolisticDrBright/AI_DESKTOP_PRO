import { AdapterError } from '@/adapters/errors';
import { requestRecordingDrafting } from './recording-drafting-client';
import type { DraftingListing, DraftingNoteType, DraftingOperation, ProposedNoteContent } from '@/contracts/encounterRecordingDrafting';

export type DraftingSnapshot = {
  recordingId: string; listing: DraftingListing | null; content: ProposedNoteContent | null;
  /** The exact request whose outcome is unknown. Only `request` is replayed, with its original command ID. */
  pending: Extract<DraftingOperation, { operation: 'request' }> | null;
  busy: boolean; error: string | null; notice: string;
};
type Options = { recordingId: string; changed?: (snapshot: DraftingSnapshot) => void; request?: typeof requestRecordingDrafting; uuid?: () => string };
const MESSAGES = {
  unauthenticated: 'Sign in again to renew workforce authorization, then return to this encounter.',
  forbidden: 'Drafting was refused. Every participant needs effective AI-drafting consent, the recording needs a stored transcript, and no hold or deletion may apply.',
  conflict: 'The transcript or drafting state changed. Load the latest state; a proposed note can only be drafted from the newest transcript version.',
  invalid: 'This request could not be accepted.',
  unavailable: 'The drafting service is unavailable. Nothing was changed on this page or in any note.',
} as const;

/** One page-owned drafting review per finished recording. Explicit steps only;
 * the service performs one bounded provider step per call and never writes a
 * clinical note. Proposed text stays in page memory while open; inserting it into
 * an editable note is a separate, visible action through the composer. */
export class AwsRecordingDrafting {
  private readonly life = new AbortController();
  private readonly request: typeof requestRecordingDrafting;
  private readonly uuid: () => string;
  private state: DraftingSnapshot;
  private running = false;
  constructor(private readonly options: Options) {
    this.request = options.request ?? requestRecordingDrafting;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.state = { recordingId: options.recordingId, listing: null, content: null, pending: null, busy: false, error: null, notice: '' };
  }
  snapshot(): DraftingSnapshot { return { ...this.state }; }
  dispose() { this.life.abort(); this.state = { ...this.state, content: null, busy: false }; }
  private set(patch: Partial<DraftingSnapshot>) {
    if (this.life.signal.aborted) return;
    this.state = { ...this.state, ...patch }; this.options.changed?.(this.snapshot());
  }
  private async run<T>(operation: DraftingOperation, apply: (result: T) => Partial<DraftingSnapshot>) {
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
      this.set({ error: MESSAGES[safe.code as keyof typeof MESSAGES] ?? MESSAGES.unavailable, pending: uncertain ? operation : null,
        content: safe.code === 'conflict' ? null : this.state.content,
        notice: uncertain ? 'The request outcome is uncertain. Retry the same request; a second request is refused by the service.' : '' });
    } finally { this.running = false; this.set({ busy: false }); }
  }
  load() { return this.run<DraftingListing>({ operation: 'list', input: { recordingId: this.state.recordingId } }, listing => ({ listing })); }
  /** Requests a proposed note from the newest transcript version, or replays the pending request. */
  requestDraft(noteType: DraftingNoteType) {
    const transcript = this.state.listing?.latestTranscript;
    if (!this.state.pending && !transcript) { this.set({ error: 'No stored transcript version exists for this recording yet. Complete transcription first.' }); return Promise.resolve(); }
    const operation = this.state.pending ?? { operation: 'request' as const, input: { recordingId: this.state.recordingId, transcriptId: transcript!.transcriptId, commandId: this.uuid(), noteType } };
    return this.run<{ status: string; replayed: boolean; noteType: DraftingNoteType; transcriptId: string; jobId: string }>(operation, receipt => ({
      notice: receipt.replayed ? 'The earlier request was already accepted.' : 'Proposed note requested. Advance to run the single drafting step.',
      listing: this.state.listing ? { ...this.state.listing, job: { jobId: receipt.jobId, status: receipt.status as 'requested', noteType: receipt.noteType, transcriptId: receipt.transcriptId,
        failureCode: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } } : null }));
  }
  /** One bounded service step: read the transcript, call the provider once, store the proposed note. */
  advance() { return this.run<DraftingListing>({ operation: 'advance', input: { recordingId: this.state.recordingId } }, listing => ({ listing,
    notice: listing.job?.status === 'completed' ? 'Proposed note stored. Open it to review; nothing was added to any note.' : listing.job?.status === 'failed'
      ? 'Drafting failed and no proposed note was stored.' : '' })); }
  read(proposedNoteId: string) { return this.run<ProposedNoteContent>({ operation: 'read', input: { proposedNoteId } }, content => ({ content })); }
  closeText() { this.set({ content: null }); }
}
