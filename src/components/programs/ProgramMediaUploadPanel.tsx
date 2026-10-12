"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Btn } from '@/components/ui/Btn';
import { onWorkforceSessionChange } from '@/lib/workforce-session-change';
import { createProgramMediaUploadController, type ProgramMediaUploadScope } from '@/lib/programs/programMediaUpload';

/** Authoring media only. A published reference is kept separate from legacy URL
 * slots until the reviewed program/V2 reference admission is installed. */
export function ProgramMediaUploadPanel({ scope, disabled }: { scope: ProgramMediaUploadScope; disabled: boolean }) {
  const scopeRef = useRef<ProgramMediaUploadScope | null>(scope), disabledRef = useRef(disabled);
  scopeRef.current = scope; disabledRef.current = disabled;
  const [controller] = useState(() => createProgramMediaUploadController({ scope: () => disabledRef.current ? null : scopeRef.current,
    fetch: (input, init) => fetch(input, init) }));
  const [view, setView] = useState(controller.snapshot), [caption, setCaption] = useState(''), [resumeId, setResumeId] = useState('');
  const [inputEpoch, setInputEpoch] = useState(0), [notice, setNotice] = useState('');
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((node: HTMLVideoElement | null) => { previewRef.current?.pause(); previewRef.current = node; }, []);
  const scopeKey = JSON.stringify([scope.programId, scope.draftId, scope.stepId, scope.session]);
  useLayoutEffect(() => {
    previewRef.current?.pause(); controller.invalidate(); setCaption(''); setResumeId(''); setInputEpoch(n => n + 1);
  }, [controller, scopeKey, disabled]);
  useLayoutEffect(() => {
    if (!view.authorityLost) return;
    previewRef.current?.pause(); setCaption(''); setResumeId(''); setInputEpoch(n => n + 1);
  }, [view.authorityLost]);
  useEffect(() => {
    const unsubscribe = controller.subscribe(setView);
    // External withdrawal events must clear the visible private form before
    // returning, not merely abort work and queue a later concurrent render.
    const clear = () => { flushSync(() => { previewRef.current?.pause(); controller.invalidate(); setCaption(''); setResumeId(''); setInputEpoch(n => n + 1);
      setNotice('Local media information was cleared. This does not confirm remote cancellation or deletion.'); }); };
    const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
    const off = onWorkforceSessionChange(clear);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', clear);
    return () => { unsubscribe(); off(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', clear);
      controller.invalidate(); };
  }, [controller, scopeKey]);
  useEffect(() => {
    if (!view.preview) return;
    const timer = setTimeout(() => { previewRef.current?.pause();
      controller.clearPreview('The private preview expired. Request a new authorized preview before viewing it again.');
    }, Math.max(1, new Date(view.preview.previewUntil).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [controller, view.preview]);
  const ready = view.artifact?.state === 'ready', locked = disabled || view.busy;
  const savedCaption = view.artifact && 'caption' in view.artifact ? view.artifact.caption : null;
  const input = 'h-8 w-full rounded-lg border border-line bg-card px-3 text-[12px] text-body';
  return <section className="rounded-lg border border-line bg-card p-3 flex flex-col gap-2" aria-label="Educational media upload" data-testid="program-media-upload-panel">
    <h5 className="m-0 text-[13px] font-semibold text-body">Upload your lesson image or video</h5>
    <p className="m-0 text-[12px] text-subtle">Educational content only—never patient information or recordings. Images can be up to 16 MiB; videos up to 256 MiB. A reviewed secure host is required; uploads are off until it is installed.</p>
    <label className="text-[12px] text-body">{view.artifact ? 'Reselect the exact file to resume' : 'Choose an educational file'}
      <input key={inputEpoch} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" disabled={locked}
        aria-label="Choose educational media file" className="mt-1 block w-full text-[12px]"
        onChange={e => { const selected = e.currentTarget.files?.[0]; if (selected) { setNotice(''); void controller.selectFile(selected); } }} />
    </label>
    <p className="m-0 text-[11px] text-subtle">Use a file name with letters, numbers, dashes or underscores and its matching extension. File bytes stay in memory, not browser storage.</p>
    {view.totalBytes > 0 ? <div>
      <progress className="w-full" aria-label={view.state === 'hashing' ? 'Checking file bytes' : 'Verified upload parts'}
        value={view.state === 'hashing' ? view.hashedBytes : view.receivedParts} max={view.state === 'hashing' ? view.totalBytes : Math.max(1, view.totalParts)} />
      <p className="m-0 text-[12px] text-subtle">{view.state === 'hashing' ? 'Checking the file locally…' : `${view.receivedParts} of ${view.totalParts} parts confirmed by the service.`}</p>
    </div> : null}
    <div className="flex flex-wrap gap-2">
      <Btn size="sm" disabled={locked || !view.fileSelected || (view.state !== 'prepared' && view.state !== 'waiting')} onClick={() => void controller.upload()}>Upload or resume</Btn>
      <Btn size="sm" disabled={locked || !view.artifact} onClick={() => void controller.checkStatus()}>Check saved status</Btn>
      <Btn size="sm" disabled={locked || view.artifact?.kind !== 'video' || ready} onClick={() => void controller.cancel()}>Request cancellation</Btn>
      <Btn size="sm" disabled={locked} onClick={() => { controller.invalidate(); setCaption(''); setResumeId(''); setInputEpoch(n => n + 1);
        setNotice('Started a new local selection. Existing remote uploads were not cancelled or deleted.'); }}>Start another upload</Btn>
    </div>
    <div className="flex gap-2 items-end">
      <label className="flex-1 text-[12px] text-body">Saved upload ID
        <input className={input} aria-label="Saved media upload ID" value={resumeId} disabled={locked} onChange={e => setResumeId(e.target.value.trim())} />
      </label>
      <Btn size="sm" disabled={locked || !resumeId} onClick={() => void controller.restore(resumeId)}>Open saved upload</Btn>
    </div>
    {view.artifact ? <p className="m-0 text-[11px] text-subtle">Save this upload ID to resume after reopening: <code>{view.artifact.artifactId}</code>. An ID grants no access; the service checks the current author and program.</p> : null}
    <label className="text-[12px] text-body">Your supplied caption or explanation
      <textarea className="mt-1 w-full rounded-lg border border-line p-2 text-[12px]" aria-label="Supplied educational media caption" value={caption}
        maxLength={200000} disabled={locked || !ready} onChange={e => setCaption(e.target.value)} />
    </label>
    <div className="flex gap-2">
      <Btn size="sm" disabled={locked || !ready || !caption.trim()} onClick={() => void controller.attachText(caption)}>Save supplied caption</Btn>
      <Btn size="sm" disabled={locked || !ready} onClick={() => void controller.preview()}>Private author preview</Btn>
      <Btn size="sm" disabled={locked || !ready || !savedCaption}
        onClick={() => void controller.publish()}>Publish exact media reference</Btn>
    </div>
    {view.preview ? (view.preview.kind === 'video'
      ? <video ref={attachVideo} key={view.preview.previewToken} src={view.preview.previewToken} controls preload="none" className="max-h-64 w-full" aria-label="Private author video preview" />
      // This is an already authorized short-lived URL, not an image optimizer/proxy or public asset.
      // eslint-disable-next-line @next/next/no-img-element
      : <img src={view.preview.previewToken} alt="Private educational image preview" className="max-h-64 object-contain" referrerPolicy="no-referrer" />) : null}
    {view.message || notice ? <p className="m-0 text-[12px] text-body" role="status">{view.message || notice}</p> : null}
    {view.reference ? <p className="m-0 text-[12px] text-body">Published artifact {view.reference.artifactId}, version {view.reference.version}. Patient delivery stays held until the program reference admission and learner authority are reviewed and installed.</p> : null}
    <p className="m-0 text-[11px] text-subtle">Publishing media does not add it to a patient course, share clinical data, approve a protocol or change a dose. The existing URL slots below are unchanged.</p>
  </section>;
}
