import { describe, expect, it, vi } from 'vitest';
import { AwsRecordingDrafting, type DraftingSnapshot } from './aws-recording-drafting';
import type { requestRecordingDrafting } from './recording-drafting-client';
import type { DraftingListing, DraftingOperation } from '@/contracts/encounterRecordingDrafting';
import { AdapterError } from '@/adapters/errors';

const recordingId = '11111111-1111-4111-8111-111111111111', jobId = '22222222-2222-4222-8222-222222222222', transcriptId = '33333333-3333-4333-8333-333333333333', noteId = '44444444-4444-4444-8444-444444444444';
const at = '2026-09-20T00:00:00.000Z', hash = 'a'.repeat(64);
const capabilities = { aiDrafting: true as const, writesClinicalNotes: false as const, reason: 'review_only' as const };
function listing(status: 'requested' | 'completed' | 'failed' | null, versions: DraftingListing['versions'] = [], transcript = true): DraftingListing {
  return { recordingId, status: 'closed', latestTranscript: transcript ? { transcriptId, version: 1 } : null, versions,
    job: status ? { jobId, status, noteType: 'soap', transcriptId, failureCode: status === 'failed' ? 'provider_unavailable' : null, createdAt: at, updatedAt: at } : null };
}
const version = { proposedNoteId: noteId, version: 1, noteType: 'soap' as const, transcriptId, contentSha256: hash, byteLength: 10, sectionCount: 4, model: 'fictional-model-1', createdBy: recordingId, createdAt: at };
const document = { contract: 'proposed-note/1' as const, noteType: 'soap' as const, transcriptId, transcriptSha256: hash, model: 'fictional-model-1', promptSha256: hash,
  sections: [{ key: 'S', label: 'Subjective', text: 'fictional' }, { key: 'O', label: 'Objective', text: '' }, { key: 'A', label: 'Assessment', text: '' }, { key: 'P', label: 'Plan', text: '' }], cautions: ['Fictional caution'] };
function fixture(behaviour: (operation: DraftingOperation) => unknown) {
  const calls: DraftingOperation[] = [], snapshots: DraftingSnapshot[] = [];
  const request = vi.fn(async (operation: DraftingOperation) => { calls.push(operation); const data = await behaviour(operation); return { data, capabilities }; }) as unknown as typeof requestRecordingDrafting;
  let n = 0;
  const owner = new AwsRecordingDrafting({ recordingId, request, changed: s => snapshots.push(s), uuid: () => `5555555${++n}-5555-4555-8555-555555555555` });
  return { owner, calls, snapshots };
}
describe('page-owned proposed-note review', () => {
  it('requests from the newest transcript, runs one step, opens the proposal and never mutates a note', async () => {
    let status: 'requested' | 'completed' | null = null;
    const f = fixture(op => {
      if (op.operation === 'list') return listing(status);
      if (op.operation === 'request') { status = 'requested'; return { jobId, recordingId, transcriptId: op.input.transcriptId, commandId: op.input.commandId, noteType: op.input.noteType, status, replayed: false }; }
      if (op.operation === 'advance') { status = 'completed'; return listing(status, [version]); }
      return { proposedNoteId: noteId, recordingId, version: 1, contentSha256: hash, document };
    });
    await f.owner.requestDraft('soap'); expect(f.calls).toHaveLength(0); expect(f.owner.snapshot().error).toContain('No stored transcript');
    await f.owner.load();
    await f.owner.requestDraft('adime');
    expect(f.calls[1]).toEqual({ operation: 'request', input: { recordingId, transcriptId, commandId: '55555551-5555-4555-8555-555555555555', noteType: 'adime' } });
    expect(f.owner.snapshot().listing?.job?.status).toBe('requested');
    await f.owner.advance(); expect(f.owner.snapshot().listing?.job?.status).toBe('completed'); expect(f.owner.snapshot().notice).toContain('nothing was added to any note');
    await f.owner.read(noteId); expect(f.owner.snapshot().content?.document.sections[0].text).toBe('fictional');
    f.owner.closeText(); expect(f.owner.snapshot().content).toBeNull();
    expect(f.calls.map(c => c.operation)).toEqual(['list', 'request', 'advance', 'read']);
    f.owner.dispose(); await f.owner.load(); expect(f.calls).toHaveLength(4);
  });
  it('retains only an uncertain request for exact replay and maps refusals to patient-safe messages', async () => {
    let fail = true;
    const f = fixture(op => {
      if (op.operation === 'list') return listing(null);
      if (op.operation === 'request') { if (fail) throw new AdapterError('unavailable'); return { jobId, recordingId, transcriptId, commandId: op.input.commandId, noteType: op.input.noteType, status: 'requested', replayed: true }; }
      return listing(null);
    });
    await f.owner.load(); await f.owner.requestDraft('soap');
    const pending = f.owner.snapshot().pending; expect(pending?.input.commandId).toBe('55555551-5555-4555-8555-555555555555');
    await f.owner.advance(); await f.owner.load(); expect(f.calls).toHaveLength(2);
    fail = false; await f.owner.requestDraft('narrative');
    expect(f.calls[2]).toEqual(pending); expect(f.owner.snapshot().pending).toBeNull(); expect(f.owner.snapshot().notice).toContain('already accepted');
    for (const [code, fragment] of [['forbidden', 'refused'], ['unauthenticated', 'Sign in again'], ['conflict', 'newest transcript'], ['unavailable', 'in any note']] as const) {
      const g = fixture(() => { throw new AdapterError(code); });
      await g.owner.load(); expect(g.owner.snapshot().error).toContain(fragment); expect(g.owner.snapshot().error).not.toMatch(/arn:|sql|stack/i);
    }
  });
});
