import { describe, expect, it, vi } from 'vitest';
import { AwsRecordingTranscription, type TranscriptionSnapshot } from './aws-recording-transcription';
import type { requestRecordingTranscription } from './recording-transcription-client';
import type { TranscriptionListing, TranscriptionOperation } from '@/contracts/encounterRecordingTranscription';
import { AdapterError } from '@/adapters/errors';

const recordingId = '11111111-1111-4111-8111-111111111111', jobId = '22222222-2222-4222-8222-222222222222', transcriptId = '33333333-3333-4333-8333-333333333333';
const at = '2026-09-20T00:00:00.000Z', hash = 'a'.repeat(64);
const capabilities = { transcription: true as const, aiDrafting: false as const, reason: 'ai_drafting_not_configured' as const };
function listing(status: 'requested' | 'processing' | 'completed' | 'failed' | null, versions: TranscriptionListing['versions'] = []): TranscriptionListing {
  return { recordingId, status: 'closed', versions, job: status ? { jobId, status, providerJobName: null, failureCode: status === 'failed' ? 'provider_failed:x' : null,
    segmentCount: 1, inventorySha256: hash, createdAt: at, updatedAt: at } : null };
}
const version = { transcriptId, version: 1, kind: 'provider' as const, contentSha256: hash, byteLength: 5, wordCount: 1, supersedesId: null, authorId: recordingId, reason: null, createdAt: at };
function fixture(behaviour: (operation: TranscriptionOperation) => unknown) {
  const calls: TranscriptionOperation[] = [], snapshots: TranscriptionSnapshot[] = [];
  const request = vi.fn(async (operation: TranscriptionOperation) => { calls.push(operation); const data = await behaviour(operation); return { data, capabilities }; }) as unknown as typeof requestRecordingTranscription;
  let n = 0;
  const owner = new AwsRecordingTranscription({ recordingId, request, changed: s => snapshots.push(s), uuid: () => `4444444${++n}-4444-4444-8444-444444444444` });
  return { owner, calls, snapshots, request };
}
describe('Codex audit authorization regression', () => {
  it('clears previously opened transcript text when refreshed authorization is refused', async () => {
    const f = fixture(op => {
      if (op.operation === 'read') return {transcriptId,recordingId,version:1,contentSha256:hash,text:'FICTIONAL prior transcript'};
      throw new AdapterError('forbidden');
    });
    await f.owner.read(transcriptId);
    await f.owner.load();
    expect(f.owner.snapshot().error).toBeTruthy();
    expect(f.owner.snapshot().content).toBeNull();
  });
});

describe('page-owned transcription review', () => {
  it('walks request, advance, read and correct as explicit steps and never keeps text after a correction', async () => {
    let status: 'requested' | 'processing' | 'completed' | null = null;
    const f = fixture(op => {
      if (op.operation === 'list') return listing(status);
      if (op.operation === 'request') { status = 'requested'; return { jobId, recordingId, commandId: op.input.commandId, status, segmentCount: 1, inventorySha256: hash, replayed: false }; }
      if (op.operation === 'advance') { status = status === 'requested' ? 'processing' : 'completed'; return listing(status, status === 'completed' ? [version] : []); }
      if (op.operation === 'read') return { transcriptId, recordingId, version: 1, contentSha256: hash, text: 'hello' };
      if (op.operation === 'correct') return listing('completed', [version, { ...version, transcriptId: recordingId, version: 2, kind: 'correction', supersedesId: transcriptId, reason: op.input.reason }]);
      return listing(status);
    });
    await f.owner.load(); expect(f.owner.snapshot().listing?.job).toBeNull();
    await f.owner.requestTranscription();
    expect(f.calls[1]).toEqual({ operation: 'request', input: { recordingId, commandId: '44444441-4444-4444-8444-444444444444' } });
    await f.owner.advance(); expect(f.owner.snapshot().listing?.job?.status).toBe('processing');
    await f.owner.advance(); expect(f.owner.snapshot().listing?.job?.status).toBe('completed'); expect(f.owner.snapshot().listing?.versions).toHaveLength(1);
    await f.owner.read(transcriptId); expect(f.owner.snapshot().content?.text).toBe('hello');
    await f.owner.correct('', 'reason'); expect(f.owner.snapshot().error).toContain('could not be accepted'); expect(f.calls).toHaveLength(5);
    await f.owner.correct('hello world', '  speaker fixed ');
    expect(f.calls[5]).toEqual({ operation: 'correct', input: { recordingId, text: 'hello world', reason: 'speaker fixed' } });
    expect(f.owner.snapshot().content).toBeNull(); expect(f.owner.snapshot().listing?.versions).toHaveLength(2);
    expect(f.snapshots.every(s => s.recordingId === recordingId)).toBe(true);
    f.owner.dispose(); expect(f.owner.snapshot().content).toBeNull();
    await f.owner.load(); expect(f.calls).toHaveLength(6);
  });
  it('offers a fresh request after a terminal failure and describes the new job from the receipt, never the failed one', async () => {
    const failed = { ...listing('completed').job!, jobId: recordingId, status: 'failed' as const, failureCode: 'provider_unavailable' };
    const f = fixture(op => {
      if (op.operation === 'list') return { ...listing(null), job: failed };
      if (op.operation === 'request') return { jobId, recordingId, commandId: op.input.commandId, status: 'requested', segmentCount: 3, inventorySha256: hash, replayed: false };
      throw new AdapterError('invalid');
    });
    await f.owner.load(); expect(f.owner.snapshot().listing?.job).toMatchObject({ status: 'failed', failureCode: 'provider_unavailable' });
    await f.owner.requestTranscription();
    expect(f.calls[1]).toMatchObject({ operation: 'request', input: { recordingId, commandId: '44444441-4444-4444-8444-444444444444' } });
    expect(f.owner.snapshot().listing?.job).toMatchObject({ jobId, status: 'requested', failureCode: null, segmentCount: 3 });
    expect(f.owner.snapshot().pending).toBeNull();
  });
  it('retains only an uncertain request for exact replay and blocks other operations until it is resolved', async () => {
    let fail = true;
    const f = fixture(op => {
      if (op.operation === 'request') { if (fail) throw new AdapterError('unavailable'); return { jobId, recordingId, commandId: op.input.commandId, status: 'requested', segmentCount: 1, inventorySha256: hash, replayed: true }; }
      return listing(null);
    });
    await f.owner.requestTranscription();
    const pending = f.owner.snapshot().pending;
    expect(pending?.input.commandId).toBe('44444441-4444-4444-8444-444444444444'); expect(f.owner.snapshot().notice).toContain('uncertain');
    await f.owner.advance(); await f.owner.load(); expect(f.calls).toHaveLength(1);
    fail = false;
    await f.owner.requestTranscription();
    expect(f.calls[1]).toEqual(pending); expect(f.owner.snapshot().pending).toBeNull(); expect(f.owner.snapshot().notice).toContain('already accepted');
    const advanceFailure = fixture(op => { if (op.operation === 'advance') throw new AdapterError('unavailable'); return listing('requested'); });
    await advanceFailure.owner.advance();
    expect(advanceFailure.owner.snapshot().pending).toBeNull(); expect(advanceFailure.owner.snapshot().error).toContain('unavailable');
  });
  it('maps refusals to patient-safe messages, drops opened text once authorization or currency is lost, and serializes concurrent calls', async () => {
    for (const [code, fragment] of [['forbidden', 'refused'], ['unauthenticated', 'Sign in again'], ['conflict', 'latest version'], ['invalid', 'could not be accepted']] as const) {
      const f = fixture(op => { if (op.operation === 'read') return { transcriptId, recordingId, version: 1, contentSha256: hash, text: 'hello' }; throw new AdapterError(code); });
      await f.owner.read(transcriptId); await f.owner.load();
      expect(f.owner.snapshot().error).toContain(fragment); expect(f.owner.snapshot().error).not.toMatch(/arn:|sql|stack/i);
      expect(f.owner.snapshot().content?.text).toBe(code === 'invalid' ? 'hello' : undefined);
    }
    let release!: () => void;
    const f = fixture(() => new Promise(resolve => { release = () => resolve(listing(null)); }));
    const first = f.owner.load(); await f.owner.advance(); expect(f.calls).toHaveLength(1); expect(f.owner.snapshot().busy).toBe(true);
    release(); await first; expect(f.owner.snapshot().busy).toBe(false);
  });
});
