"use client";
import { useEffect, useRef, useState } from 'react';
import { AdapterError } from '@/adapters/errors';
import { requestRecordingCapture } from '@/lib/recording-capture-client';
import { type RecordingCaptureRequest, type RecordingRecoveryState } from '@/contracts/encounterRecordingCapture';

const buttonStyle = 'rounded border border-line px-3 py-2 text-sm disabled:opacity-50';
type CommandRequest = Extract<RecordingCaptureRequest, { operation: 'command' }>;
/** No microphone/resume switch: recovery does not activate the unfinished capture
 * UI. The parent keys this component by encounter + recording + session. */
export function AwsRecordingRecoveryPanel({ recordingId, sessionId }: { recordingId: string; sessionId: string }) {
  const [state, setState] = useState<RecordingRecoveryState | null>(null);
  const [pending, setPending] = useState<CommandRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const running = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController(); controller.current = active;
    return () => { active.abort(); };
  }, []);
  async function perform(command?: CommandRequest) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    running.current = true; setBusy(true); setError(''); setMessage(''); setState(null);
    let acknowledged = false;
    try {
      if (command) {
        await requestRecordingCapture(command, signal);
        if (signal.aborted) return;
        acknowledged = true; setPending(null);
        setMessage('The command was acknowledged. Refreshing current status; no transcription or deletion was requested.');
      }
      const result = await requestRecordingCapture({ operation: 'state', input: { recordingId } }, signal);
      if (signal.aborted) return;
      if (!('storedSegments' in result.data) || result.data.sessionId !== sessionId) throw new AdapterError('unavailable');
      setState(result.data);
      setMessage(command ? 'Command confirmed and current status loaded. No transcription or deletion was requested.' : 'Current status loaded from the recording service.');
    } catch (e) {
      if (signal.aborted) return;
      const safe = e instanceof AdapterError ? e : new AdapterError('unavailable');
      setError(acknowledged ? 'The command was acknowledged, but current status could not load. Reload recording status.'
        : safe.code === 'unauthenticated' ? 'Sign in again to renew workforce authorization. Then return to this encounter.'
          : safe.code === 'forbidden' ? 'Recording access or consent was refused. Only the authorized recording owner can manage this capture.'
            : safe.code === 'conflict' ? 'The recording changed. Reload its status and review it before choosing another action.' : safe.safeMessage);
      if (command && !acknowledged && ['unavailable', 'unknown'].includes(safe.code)) {
        setPending(command); setMessage('The command outcome is uncertain. Retry the same command; do not issue a replacement.');
      } else if (command) setPending(null);
    } finally { running.current = false; if (!signal.aborted) setBusy(false); }
  }
  function command(action: 'pause' | 'finish' | 'discard') {
    if (!state || pending || busy) return;
    if (state.status === 'closed' || action === 'pause' && state.status !== 'capturing'
      || action === 'finish' && (state.status === 'revoked' || state.storedSegments === 0 || state.pendingSegments !== 0)) return;
    void perform({ operation: 'command', input: { recordingId, commandId: crypto.randomUUID(), action,
      expectedVersion: state.credentialVersion, inventorySha256: action === 'pause' ? null : state.inventorySha256 } });
  }
  return <section aria-label="Recording recovery" className="space-y-3 rounded border border-line p-3">
    <h3 className="m-0 text-sm font-semibold">Existing recording recovery</h3>
    <p className="text-sm">Load the server inventory before acting. This does not start a microphone, resume recording, submit transcription, or delete audio.</p>
    <div role="status" aria-live="polite">{busy ? 'Contacting the recording service…' : message}</div>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {pending ? <div className="space-y-2">
      <p className="text-sm">The original command is retained only while this page remains open. If you leave, reload server status before acting.</p>
      <button type="button" className={buttonStyle} disabled={busy} onClick={() => void perform(pending)}>Retry the same recording command</button>
    </div> : <button type="button" className={buttonStyle} disabled={busy} onClick={() => void perform()}>Load recording status</button>}
    {state ? <div className="space-y-3">
      <p className="text-sm">Recording status: {state.status}. Stored segments: {state.storedSegments}. Pending segments: {state.pendingSegments}.</p>
      <p className="text-sm">Retention deadline: {state.deletionDeadline}. Audio deletion is not confirmed.</p>
      {state.pendingSegments > 0 ? <p className="text-sm">An upload remains unconfirmed. Finishing is unavailable until it is reconciled. Discard records a disposition; it does not erase that upload.</p> : null}
      {state.status === 'capturing' ? <button type="button" className={buttonStyle} disabled={busy} onClick={() => command('pause')}>Pause this recording</button> : null}
      {state.status !== 'closed' ? <form key={state.credentialVersion + ':' + state.inventorySha256} onSubmit={event => {
        event.preventDefault();
        const choice = new FormData(event.currentTarget).get('disposition');
        if (choice === 'finish' || choice === 'discard') command(choice);
      }}>
        <fieldset disabled={busy || !!pending} className="space-y-2">
          <label className="block text-sm">Recording disposition
            <select name="disposition" required defaultValue="" className="ml-2 rounded border border-line bg-surface p-2">
              <option value="" disabled>Choose after reviewing the inventory</option>
              <option value="finish" disabled={state.status === 'revoked' || state.storedSegments === 0 || state.pendingSegments !== 0}>Finish capture without processing</option>
              <option value="discard">Discard capture without claiming deletion</option>
            </select>
          </label>
          <label className="block text-sm"><input type="checkbox" required /> I reviewed this inventory and understand this closes the capture without transcribing or deleting audio.</label>
          <button className={buttonStyle}>Confirm recording disposition</button>
        </fieldset>
      </form> : <p className="text-sm">Capture closed: {state.disposition}. Retention and deletion still require the storage workflow.</p>}
    </div> : null}
  </section>;
}
