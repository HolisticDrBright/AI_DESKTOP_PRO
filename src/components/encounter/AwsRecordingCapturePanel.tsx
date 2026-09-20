"use client";
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createAwsBrowserRecording, type AwsBrowserRecording } from '@/lib/aws-browser-recording';
import type { CaptureTransportSnapshot } from '@/lib/aws-recording-transport';
import { AdapterError } from '@/adapters/errors';
import { AwsRecordingRecoveryPanel } from './AwsRecordingRecoveryPanel';

const button = 'rounded border border-line px-3 py-2 text-sm disabled:opacity-50';
const initial: CaptureTransportSnapshot = { phase: 'idle', recordingId: null, sessionId: null, bufferedBytes: 0,
  bufferedSegments: 0, storedSegments: 0, incomplete: false, pendingOperation: null, busy: false };
const labels: Record<CaptureTransportSnapshot['phase'], string> = {
  idle: 'Not started', ready: 'Readiness checked — microphone off', starting: 'Waiting for authorization',
  recording: 'Recording', paused: 'Paused — microphone off', uncertain: 'Outcome uncertain — microphone off',
  recovery_required: 'Recovery required — microphone off', finished: 'Capture finished',
  discarded: 'Capture discarded — deletion not confirmed', disposed: 'Recording session closed',
};

/** The owner survives consent workspace refreshes, preserving in-memory tail and
 * exact retry commands. Encounter unmount destroys it; no implicit restart. */
export function AwsRecordingCapturePanel({ encounterId, available, ownerRef, existingCapture, onFinished }: {
  encounterId: string; available: boolean; ownerRef: RefObject<AwsBrowserRecording | null>;
  existingCapture: { id: string; sessionId: string } | null;
  /** Called once when this page's capture reaches a finished disposition. */
  onFinished?: (recordingId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [ack, setAck] = useState(false), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const alive = useRef(false), running = useRef(false);
  useEffect(() => {
    alive.current = true;
    const owner = createAwsBrowserRecording({ encounterId, changed: state => { if (alive.current) setSnapshot(state); } });
    ownerRef.current = owner;
    const leave = (event: BeforeUnloadEvent) => {
      const state = owner.snapshot();
      if (state.recordingId && !['finished', 'discarded', 'disposed'].includes(state.phase) || state.pendingOperation) {
        owner.interrupt(); event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leave);
    return () => {
      alive.current = false; window.removeEventListener('beforeunload', leave);
      owner.dispose(); if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [encounterId, generation, ownerRef]);
  useEffect(() => {
    if (!available) { ownerRef.current?.interrupt(); setChecked(false); setAck(false); }
  }, [available, ownerRef]);
  const finishedRef = useRef<string | null>(null);
  useEffect(() => {
    if (snapshot.phase === 'finished' && snapshot.recordingId && finishedRef.current !== snapshot.recordingId) {
      finishedRef.current = snapshot.recordingId; onFinished?.(snapshot.recordingId);
    }
  }, [snapshot.phase, snapshot.recordingId, onFinished]);

  async function act(action: 'check' | 'start' | 'pause' | 'resume' | 'retry' | 'finish' | 'discard') {
    const owner = ownerRef.current;
    if (!owner || running.current) return;
    if (['check', 'start', 'resume'].includes(action) && !available) return;
    if (action === 'start' && (!ack || !checked)) return;
    running.current = true; setBusy(true); setError('');
    if (action === 'check') setChecked(false);
    try {
      await owner[action]();
      if (alive.current && ownerRef.current === owner && action === 'check') setChecked(true);
    } catch (failure) {
      if (!alive.current || ownerRef.current !== owner) return;
      const message = failure instanceof AdapterError && failure.code === 'unauthenticated'
        ? 'Sign in again to renew workforce authorization. Do not close an unresolved capture without reviewing recovery.'
        : failure instanceof AdapterError && failure.code === 'forbidden'
          ? 'Recording access or consent was refused. Review the participant consents and approved service configuration.'
          : 'This action could not be confirmed. The microphone is off. Review the status below; retry only the original uncertain request.';
      // A failed action must never leave the microphone running, including a
      // failed finish or an unsupported/expired readiness result.
      owner.interrupt(); setError(message);
      if (action === 'check' || action === 'start') setChecked(false);
    } finally {
      running.current = false;
      if (alive.current && ownerRef.current === owner) setBusy(false);
    }
  }
  const terminal = ['finished', 'discarded'].includes(snapshot.phase);
  const resumable = ['paused', 'recovery_required'].includes(snapshot.phase) && !snapshot.incomplete && !snapshot.pendingOperation;
  const controlsBusy = busy; // Background segment uploads must not disable the immediate stop.
  const recovery = existingCapture && !snapshot.recordingId && !snapshot.pendingOperation;
  return <section aria-label="AWS audio capture" className="space-y-3 rounded border border-line p-3">
    <h3 className="text-sm font-semibold">Audio capture — AWS</h3>
    <p className="text-sm">Recording requires a separate successful service check and current consent from every participant. Consent alone does not activate it. Transcription and AI drafting are not started by these controls.</p>
    <p className="text-sm">Unsent audio is held only in this page’s memory. Closing, refreshing, signing out or leaving the encounter loses unsent audio. Uploaded segments may remain on the server; leaving or discarding does not prove deletion.</p>
    <p role="status" aria-live="polite" data-testid="aws-capture-status">{labels[snapshot.phase]}</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {busy && !snapshot.recordingId ? <button className={button} onClick={() => ownerRef.current?.interrupt()}>Cancel pending recording action</button> : null}
    {snapshot.recordingId ? <p className="text-sm" data-testid="aws-capture-receipts">Stored segments: {snapshot.storedSegments}. Buffered bytes: {snapshot.bufferedBytes}.</p> : null}
    {snapshot.incomplete ? <p role="alert">This recording is incomplete. It cannot be presented as a finished recording. Review recovery or discard its capture.</p> : null}
    {snapshot.pendingOperation ? <div className="space-y-2"><p>The last request has an uncertain outcome. Its exact request is retained only on this page. No automatic retry or microphone restart will occur.</p>
      <button className={button} disabled={controlsBusy || snapshot.busy} onClick={() => void act('retry')}>Retry original recording request</button></div> : null}
    {!snapshot.recordingId && !snapshot.pendingOperation && !recovery ? <div className="space-y-2">
      <button className={button} disabled={!available || controlsBusy} onClick={() => void act('check')}>Check recording readiness</button>
      {checked ? <><label className="block text-sm"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} /> I understand the unsent-audio loss risk and have reviewed recording consent for everyone present.</label>
        <button className={button} disabled={!available || !ack || controlsBusy} onClick={() => void act('start')}>Start recording</button></> : null}
    </div> : null}
    {snapshot.recordingId && !terminal && snapshot.phase !== 'disposed' ? <div className="flex flex-wrap gap-2">
      <button className={button} onClick={() => { ownerRef.current?.interrupt(); setError('Microphone stopped locally. Server status is not assumed changed.'); }}>Stop microphone now</button>
      <button className={button} disabled={controlsBusy || !!snapshot.pendingOperation || !['recording', 'paused'].includes(snapshot.phase)} onClick={() => void act('pause')}>Pause recording</button>
      <button className={button} disabled={!available || controlsBusy || !resumable} onClick={() => void act('resume')}>Resume recording</button>
      <button className={button} disabled={controlsBusy || !!snapshot.pendingOperation || snapshot.incomplete || !['recording', 'paused'].includes(snapshot.phase)} onClick={() => void act('finish')}>Finish recording</button>
      <button className={button} disabled={controlsBusy || !!snapshot.pendingOperation} onClick={() => void act('discard')}>Discard capture</button>
    </div> : null}
    {terminal ? <><p>{snapshot.phase === 'finished' ? 'No transcript, clinical note or confirmed erasure has been produced by this action. Reload the consent workspace to review transcription for this finished recording.' : 'No transcription, clinical note or confirmed erasure has been produced by this action.'}</p>
      <button className={button} disabled={controlsBusy} onClick={() => { setSnapshot(initial); setChecked(false); setAck(false); setError(''); setGeneration(value => value + 1); }}>Prepare another recording</button></> : null}
    {recovery ? <AwsRecordingRecoveryPanel key={existingCapture.id + ':' + existingCapture.sessionId} recordingId={existingCapture.id} sessionId={existingCapture.sessionId} /> : null}
  </section>;
}
