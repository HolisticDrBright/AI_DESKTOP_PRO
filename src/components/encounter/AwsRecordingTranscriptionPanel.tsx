"use client";
import { useEffect, useRef, useState } from 'react';
import { AwsRecordingTranscription, type TranscriptionSnapshot } from '@/lib/aws-recording-transcription';
import type { RecordingWorkspace } from '@/contracts/encounterRecordingAuthority';

const button = 'rounded border border-line px-3 py-2 text-sm disabled:opacity-50';
const inputStyle = 'block w-full rounded border border-line bg-surface px-2 py-1.5 text-ink';
export type FinishedCapture = RecordingWorkspace['finishedCaptures'][number];
const JOB_LABEL: Record<string, string> = { requested: 'Requested — not yet sent to the provider', processing: 'Provider working — advance to check',
  completed: 'Transcript stored', failed: 'Failed — no transcript stored', cancelled: 'Cancelled' };

/** Review of one finished recording's transcription. Every step is an explicit
 * click; the service performs one bounded provider or storage step per call and
 * never drafts a note. Text is held only in this page's memory while open. */
function RecordingTranscription({ capture, available }: { capture: FinishedCapture; available: boolean }) {
  const initial: TranscriptionSnapshot = { recordingId: capture.id, listing: null, content: null, pending: null, busy: false, error: null, notice: '' };
  const [snapshot, setSnapshot] = useState(initial);
  const owner = useRef<AwsRecordingTranscription | null>(null);
  useEffect(() => {
    const review = new AwsRecordingTranscription({ recordingId: capture.id, changed: setSnapshot });
    owner.current = review;
    return () => { review.dispose(); if (owner.current === review) owner.current = null; };
  }, [capture.id]);
  useEffect(() => { if (!available) owner.current?.closeText(); }, [available]);
  const job = snapshot.listing?.job ?? null, versions = snapshot.listing?.versions ?? [];
  const latest = versions.at(-1) ?? null;
  const disabled = snapshot.busy || !available;
  return <section aria-label={`Transcription for recording finished ${capture.finishedAt}`} className="space-y-2 rounded border border-line p-3">
    <p className="text-sm"><strong>Recording finished {new Date(capture.finishedAt).toLocaleString()}</strong> · {capture.segmentCount} stored segment{capture.segmentCount === 1 ? '' : 's'} · audio deletion deadline {new Date(capture.deletionDeadline).toLocaleString()}</p>
    <p role="status" aria-live="polite" className="text-sm">{snapshot.busy ? 'Contacting the transcription service…' : snapshot.notice || (job ? JOB_LABEL[job.status] ?? job.status : snapshot.listing ? 'No transcription requested' : capture.transcription ? JOB_LABEL[capture.transcription.status] : 'No transcription requested')}</p>
    {snapshot.error ? <p role="alert" className="text-sm text-red-700">{snapshot.error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={disabled || !!snapshot.pending} onClick={() => void owner.current?.load()}>Load transcription status</button>
      {snapshot.pending ? <button className={button} disabled={disabled} onClick={() => void owner.current?.requestTranscription()}>Retry the same transcription request</button>
        : snapshot.listing && !job ? <button className={button} disabled={disabled} onClick={() => void owner.current?.requestTranscription()}>Request transcription</button> : null}
      {job && ['requested', 'processing'].includes(job.status) ? <button className={button} disabled={disabled || !!snapshot.pending} onClick={() => void owner.current?.advance()}>Advance one step</button> : null}
    </div>
    {snapshot.listing && !job ? <p className="text-xs text-subtle">Requesting requires effective transcription consent from every participant and re-checks holds and deletion. Nothing is sent to the provider until you advance.</p> : null}
    {versions.length ? <ul className="space-y-1 text-sm">{versions.map(v => <li key={v.transcriptId} className="flex flex-wrap items-center gap-2">
      <span>Version {v.version} · {v.kind === 'provider' ? 'provider transcript' : 'correction'} · {v.wordCount} words · {new Date(v.createdAt).toLocaleString()}{v.reason ? ` · ${v.reason}` : ''}</span>
      <button className={button} disabled={disabled || snapshot.content?.transcriptId === v.transcriptId} onClick={() => void owner.current?.read(v.transcriptId)}>Open version {v.version}</button>
    </li>)}</ul> : null}
    {snapshot.content ? <div className="space-y-2">
      <p className="text-xs text-subtle">Version {snapshot.content.version} · digest verified by the service · SHA-256 {snapshot.content.contentSha256}</p>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-line p-2 font-sans text-sm" data-testid="aws-transcript-text">{snapshot.content.text}</pre>
      <button className={button} onClick={() => owner.current?.closeText()}>Close text</button>
      {latest && snapshot.content.transcriptId === latest.transcriptId ? <form className="space-y-2" onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void owner.current?.correct(String(data.get('text') ?? ''), String(data.get('reason') ?? ''));
      }}>
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="text-sm font-semibold">Correct the latest version</legend>
          <label className="block text-sm">Corrected transcript<textarea className={inputStyle} name="text" required maxLength={2_000_000} rows={8} defaultValue={snapshot.content.text} /></label>
          <label className="block text-sm">Reason for correction<input className={inputStyle} name="reason" required maxLength={400} /></label>
          <p className="text-xs text-subtle">A correction is stored as a new version; earlier versions stay unchanged. Identical text is refused. This is not a clinical note and no note is drafted.</p>
          <button className={button}>Store correction as a new version</button>
        </fieldset>
      </form> : null}
    </div> : null}
  </section>;
}
export function AwsRecordingTranscriptionPanel({ captures, available }: { captures: FinishedCapture[]; available: boolean }) {
  return <section aria-label="Encounter transcription" className="space-y-3 rounded border border-line p-3">
    <h3 className="text-sm font-semibold">Transcription — AWS</h3>
    <p className="text-sm">Transcription runs only for a finished recording with current transcription consent from every participant. Each step is explicit and bounded. AI drafting is not available; no clinical note is produced here.</p>
    {captures.length === 0 ? <p className="text-sm">No finished recording is available for transcription. Load the consent workspace after finishing a recording.</p>
      : captures.map(capture => <RecordingTranscription key={capture.id} capture={capture} available={available} />)}
  </section>;
}
