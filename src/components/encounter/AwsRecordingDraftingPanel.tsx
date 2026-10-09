"use client";
import { useEffect, useRef, useState } from 'react';
import { AwsRecordingDrafting, type DraftingSnapshot } from '@/lib/aws-recording-drafting';
import type { DraftingNoteType } from '@/contracts/encounterRecordingDrafting';
import type { FinishedCapture } from './AwsRecordingTranscriptionPanel';

const button = 'rounded border border-line px-3 py-2 text-sm disabled:opacity-50';
const inputStyle = 'block w-full rounded border border-line bg-surface px-2 py-1.5 text-ink';
const NOTE_TYPE_LABEL: Record<DraftingNoteType, string> = { soap: 'SOAP', narrative: 'Narrative', follow_up: 'Follow-up', adime: 'ADIME (nutrition)', patient_instructions: 'Patient instructions' };
const JOB_LABEL: Record<string, string> = { requested: 'Requested — provider not yet called', completed: 'Proposed note stored', failed: 'Failed — no proposed note stored', cancelled: 'Cancelled' };
export type ProposedInsert = { text: string; provenance: { refType: 'proposed_note'; refId: string; label: string } };

/** Review of AI-proposed documentation for one finished, transcribed recording.
 * The service never writes a note. A section reaches an editable note only when
 * the clinician chooses "Insert" here, through the composer's explicit insert path. */
function RecordingDrafting({ capture, available, canInsert, onInsert }: { capture: FinishedCapture; available: boolean; canInsert: boolean; onInsert?: (insert: ProposedInsert) => void }) {
  const initial: DraftingSnapshot = { recordingId: capture.id, listing: null, content: null, pending: null, busy: false, error: null, notice: '' };
  const [snapshot, setSnapshot] = useState(initial);
  const [noteType, setNoteType] = useState<DraftingNoteType>('soap');
  const owner = useRef<AwsRecordingDrafting | null>(null);
  useEffect(() => {
    const review = new AwsRecordingDrafting({ recordingId: capture.id, changed: setSnapshot });
    owner.current = review;
    return () => { review.dispose(); if (owner.current === review) owner.current = null; };
  }, [capture.id]);
  useEffect(() => { if (!available) owner.current?.closeText(); }, [available]);
  const job = snapshot.listing?.job ?? null, versions = snapshot.listing?.versions ?? [], transcript = snapshot.listing?.latestTranscript ?? null;
  const disabled = snapshot.busy || !available;
  return <section aria-label={`Proposed documentation for recording finished ${capture.finishedAt}`} className="space-y-2 rounded border border-line p-3">
    <p className="text-sm"><strong>Recording finished {new Date(capture.finishedAt).toLocaleString()}</strong>{transcript ? ` · transcript version ${transcript.version}` : snapshot.listing ? ' · no transcript stored yet' : ''}</p>
    <p role="status" aria-live="polite" className="text-sm">{snapshot.busy ? 'Contacting the drafting service…' : snapshot.notice || (job ? `${JOB_LABEL[job.status] ?? job.status} (${NOTE_TYPE_LABEL[job.noteType]})` : snapshot.listing ? 'No proposed note requested' : 'Status not loaded')}</p>
    {snapshot.error ? <p role="alert" className="text-sm text-red-700">{snapshot.error}</p> : null}
    <div className="flex flex-wrap items-end gap-2">
      <button className={button} disabled={disabled || !!snapshot.pending} onClick={() => void owner.current?.load()}>Load drafting status</button>
      {snapshot.pending ? <button className={button} disabled={disabled} onClick={() => void owner.current?.requestDraft(noteType)}>Retry the same drafting request</button>
        : snapshot.listing && transcript && (!job || job.status !== 'requested') ? <>
          <label className="text-sm">Note structure<select className={inputStyle} value={noteType} onChange={event => setNoteType(event.target.value as DraftingNoteType)}>
            {(Object.keys(NOTE_TYPE_LABEL) as DraftingNoteType[]).map(t => <option key={t} value={t}>{NOTE_TYPE_LABEL[t]}</option>)}</select></label>
          <button className={button} disabled={disabled} onClick={() => void owner.current?.requestDraft(noteType)}>Request proposed note from transcript version {transcript.version}</button>
        </> : null}
      {job?.status === 'requested' ? <button className={button} disabled={disabled || !!snapshot.pending} onClick={() => void owner.current?.advance()}>Run the drafting step</button> : null}
    </div>
    {snapshot.listing && transcript && !job ? <p className="text-xs text-subtle">Requesting requires effective AI-drafting consent from every participant and re-checks holds and deletion. The provider receives only the transcript text and the note structure.</p> : null}
    {versions.length ? <ul className="space-y-1 text-sm">{versions.map(v => <li key={v.proposedNoteId} className="flex flex-wrap items-center gap-2">
      <span>Proposed note {v.version} · {NOTE_TYPE_LABEL[v.noteType]} · from transcript {v.transcriptId === transcript?.transcriptId ? `version ${transcript.version} (current)` : 'a superseded version'} · {new Date(v.createdAt).toLocaleString()}</span>
      <button className={button} disabled={disabled || snapshot.content?.proposedNoteId === v.proposedNoteId} onClick={() => void owner.current?.read(v.proposedNoteId)}>Open proposed note {v.version}</button>
    </li>)}</ul> : null}
    {snapshot.content ? <div className="space-y-2" data-testid="aws-proposed-note">
      <p className="text-xs text-subtle">Proposed note {snapshot.content.version} · {NOTE_TYPE_LABEL[snapshot.content.document.noteType]} · model {snapshot.content.document.model} · digest verified by the service. This is a proposal for your review, not documentation.</p>
      {snapshot.content.document.cautions.length ? <ul role="alert" className="list-disc pl-5 text-sm">{snapshot.content.document.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
      {snapshot.content.document.sections.map(section => <div key={section.key} className="space-y-1 rounded border border-line p-2">
        <p className="text-sm font-semibold">{section.label}</p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-sans text-sm">{section.text || '(nothing stated in the transcript)'}</pre>
        {onInsert ? <button className={button} disabled={!canInsert || !section.text}
          title={canInsert ? undefined : 'Open or start an unsigned note to insert into.'}
          onClick={() => onInsert({ text: `${section.label}: ${section.text}`, provenance: { refType: 'proposed_note', refId: snapshot.content!.proposedNoteId,
            label: `AI-proposed ${section.label} (proposed note ${snapshot.content!.version}, review required)` } })}>Insert into the open unsigned note</button> : null}
      </div>)}
      <p className="text-xs text-subtle">Inserted text is appended to the editable note with its provenance and remains yours to edit before signing. Signed content is never changed.</p>
      <button className={button} onClick={() => owner.current?.closeText()}>Close proposed note</button>
    </div> : null}
  </section>;
}
export function AwsRecordingDraftingPanel({ captures, available, canInsert, onInsert }: { captures: FinishedCapture[]; available: boolean; canInsert: boolean; onInsert?: (insert: ProposedInsert) => void }) {
  return <section aria-label="AI-proposed documentation" className="space-y-3 rounded border border-line p-3">
    <h3 className="text-sm font-semibold">Proposed documentation — AWS</h3>
    <p className="text-sm">A proposed note is drafted from a stored transcript version only with every participant’s AI-drafting consent, through a separately reviewed provider release. It is review-only: the service never writes, signs or files a note, and text enters a note only when you insert it.</p>
    {captures.length === 0 ? <p className="text-sm">No finished recording is available. Finish a recording and load the consent workspace.</p>
      : captures.map(capture => <RecordingDrafting key={capture.id} capture={capture} available={available} canInsert={canInsert} onInsert={onInsert} />)}
  </section>;
}
