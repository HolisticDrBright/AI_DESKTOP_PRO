'use client';
import {useEffect,useRef,useState} from 'react';
import {cleanupReviewRequestSchema,parseCleanupReviewResponse,type CleanupReviewRequest,type CleanupWorkPage,type CleanupHistoryPage,type ProcessingDeletionStatus} from '@/contracts/recordingCleanupReview';
import {AdapterError,codeFromHttpStatus} from '@/adapters/errors';
import {onWorkforceSessionChange} from '@/lib/workforce-session-change';
import {Card} from '@/components/ui/bits';
import {Btn} from '@/components/ui/Btn';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {RecordingCleanupExecutionPanel} from './RecordingCleanupExecutionPanel';
const outcomeNames={empty_observed:'Empty scan observed — recheck required',needs_recheck:'Further reconciliation required',held:'Held at last check',unavailable:'Service unavailable at last check',refused:'Worker refused at last check'};
const reasons={retention_deadline:'Retention deadline',discard:'Recording discarded',consent_revoked:'Consent revoked',processing_consent_revoked:'Transcription or drafting consent withdrawn (processing objects only; audio keeps its deadline)'};
export function RecordingCleanupReviewWorkspace({executionConfigured=false}:{executionConfigured?:boolean}){
  const [selection,setSelection]=useState<{recordingId:string;version:number}|null>(null);
  const [queue,setQueue]=useState<CleanupWorkPage|null>(null),[history,setHistory]=useState<CleanupHistoryPage|null>(null),[processing,setProcessing]=useState<ProcessingDeletionStatus|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checkedAt,setCheckedAt]=useState('');
  const alive=useRef(false),working=useRef(false),epoch=useRef(0),abort=useRef<AbortController|null>(null),expires=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{
    const lifecycle=epoch;
    alive.current=true;
    const clear=()=>{epoch.current++;abort.current?.abort();working.current=false;if(expires.current)clearTimeout(expires.current);
      setSelection(null);setQueue(null);setHistory(null);setProcessing(null);setBusy(false);setError('');setCheckedAt('');setNotice('Review cleared. Any submitted pass may continue. Reload after checking your current workforce session and review run history.');};
    const hide=()=>{if(document.visibilityState==='hidden')clear();};
    const unsubscribe=onWorkforceSessionChange(clear);
    document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',clear);window.addEventListener('offline',clear);
    return()=>{alive.current=false;lifecycle.current++;abort.current?.abort();if(expires.current)clearTimeout(expires.current);
      unsubscribe();document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',clear);window.removeEventListener('offline',clear);};
  },[]);
  async function load(input:CleanupReviewRequest){
    if(!alive.current||working.current)return;
    const request=cleanupReviewRequestSchema.parse(input),generation=++epoch.current,controller=new AbortController();abort.current=controller;
    working.current=true;setSelection(null);setBusy(true);setError('');setNotice('');setHistory(null);setQueue(null);setProcessing(null);setCheckedAt('');
    if(expires.current)clearTimeout(expires.current);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const operation=async()=>{
        const response=await fetch('/api/live/recording-cleanup-review',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
          headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal});
        if(!response.ok){void response.body?.cancel().catch(()=>{});throw new AdapterError(codeFromHttpStatus(response.status));}
        if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new AdapterError('unavailable');
        const headers=new Headers(response.headers);if(headers.has('content-encoding'))headers.delete('content-length');
        const bytes=await readBoundedRequestBody({body:response.body,headers,signal:controller.signal},128000,10000);
        return parseCleanupReviewResponse(request,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
      };
      const result=await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AdapterError('unavailable'));},20000);})]);
      if(!alive.current||generation!==epoch.current||controller.signal.aborted)return;
      if('items' in result.data)setQueue(result.data);else if('runs' in result.data)setHistory(result.data);else setProcessing(result.data);
      setCheckedAt(new Date().toISOString());
      expires.current=setTimeout(()=>{epoch.current++;abort.current?.abort();working.current=false;setSelection(null);setBusy(false);setQueue(null);setHistory(null);setProcessing(null);setCheckedAt('');setNotice('Review snapshot expired. A submitted pass may continue. Reload to check current status and run history.');},60000);
    }catch(e){
      if(!alive.current||generation!==epoch.current)return;
      setQueue(null);setHistory(null);setProcessing(null);setCheckedAt('');
      const code=e instanceof AdapterError?e.code:'unavailable';
      setError(code==='unauthenticated'?'Sign in again with your workforce account. Review requires a login within the last 15 minutes.':
        code==='forbidden'?'A reviewed cleanup-operator assignment is required. Ordinary clinic membership does not grant access.':
        'Cleanup review is unavailable or its response could not be verified. No cleanup completion is confirmed.');
    }finally{if(timer)clearTimeout(timer);if(alive.current&&generation===epoch.current){working.current=false;setBusy(false);}}
  }
  return <div data-testid="recording-cleanup-review" className="space-y-4">
    <Card className="p-5 space-y-3">
      <p>{executionConfigured?'Review for assigned cleanup operators. Separately configured bounded execution requires history review and explicit confirmation. Configuration is not proof of authorization. This screen cannot remove holds or approve releases.':'Read-only review for assigned cleanup operators. This screen cannot delete recordings, remove holds, start workers or approve releases.'}</p>
      <p className="text-sm text-subtle">An empty scan or an exact-version acknowledgment is not proof of complete erasure. Each page is a snapshot, not a live status feed or complete inventory.</p>
      <Btn disabled={busy} onClick={()=>void load({action:'queue'})}>{busy?'Loading review…':'Load / refresh cleanup queue'}</Btn>
      {error?<p role="alert" className="text-danger">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {checkedAt?<p className="text-sm">Snapshot loaded {checkedAt}. Display expires after one minute.</p>:null}
      {!queue&&!history&&!busy&&!error&&!notice?<p>Cleanup history has not been loaded.</p>:null}
      {queue?.items.length===0?<p>No queued recordings were returned for this view. This is not confirmation that all recordings were deleted.</p>:null}
      {queue?.items.map(item=><section key={item.recordingId} aria-label={`Recording ${item.recordingId}`} className="border-t pt-3 space-y-2 break-words">
        <h2 className="font-semibold">Recording {item.recordingId}</h2><p>Patient reference: {item.patientRecordId}</p>
        <p>{reasons[item.reason]} · revision {item.version}{item.scope==='processing'?' · scope: transcription and drafting objects only':''}</p><p>Due: {item.dueAt} · next scheduled check: {item.nextCheckAt}</p>
        <p>{item.lastOutcome?outcomeNames[item.lastOutcome]:'No run outcome recorded'} · unresolved version attempts: {item.unresolvedAttempts}</p>
        <p>{item.leaseUntil?`Claim lease deadline: ${item.leaseUntil}. A lease does not prove that a worker is running.`:'No active claim recorded in this snapshot.'}</p>
        <Btn disabled={busy} aria-label={`Review runs for ${item.recordingId}`} onClick={()=>void load({action:'history',recordingId:item.recordingId})}>Review run history</Btn>
        <Btn disabled={busy} aria-label={`Processing deletion status for ${item.recordingId}`} onClick={()=>void load({action:'processing',recordingId:item.recordingId})}>Processing deletion status</Btn>
        {executionConfigured?<Btn disabled={busy||selection!==null} aria-label={`Prepare cleanup for ${item.recordingId}`} onClick={()=>setSelection({recordingId:item.recordingId,version:item.version})}>Prepare bounded cleanup pass</Btn>:null}
      </section>)}
      {queue?.nextAfter?<Btn disabled={busy} onClick={()=>void load({action:'queue',after:queue.nextAfter!})}>Next queue page</Btn>:null}
    </Card>
    {selection&&executionConfigured?<RecordingCleanupExecutionPanel key={selection.recordingId+':'+selection.version} selection={selection}/>:null}
    {processing?<Card className="p-5 space-y-2 break-words" data-testid="processing-deletion-status"><h2 className="text-lg font-semibold">Processing deletion status</h2>
      <p>Recording {processing.recordingId} · {reasons[processing.reason]} · revision {processing.version}{processing.scope==='processing'?' · audio keeps its own deadline':''}</p>
      <p>{processing.processed?`Transcription or drafting ran for this recording. Open jobs: ${processing.openJobs}.`:'No transcription or drafting job ever ran for this recording.'}</p>
      <p>Registered processing objects: {processing.artifacts.registered} · deletion acknowledged for the exact version: {processing.artifacts.deleteAcknowledged} · retained by a hold: {processing.artifacts.retained} · outcome unknown: {processing.artifacts.unknown} · not yet attempted: {processing.artifacts.unattempted}</p>
      <p>Declared objects with no registration yet: {processing.declaredWithoutArtifact}. These may still exist in storage until reconciliation registers them.</p>
      <p role="status">{processing.processingObjectsDeleted?'Every registered processing object has an acknowledged exact-version deletion and nothing declared is unregistered. This is not a receipt for provider-side copies or backups.':'Processing objects are not all deleted. No deletion receipt exists for this recording.'}</p>
      <p className="text-sm text-subtle">Provider-side copy: not verifiable (this service holds no provider delete permission). Backups: not covered. Audio deleted: no{processing.audioActionable?'; audio is actionable in the next pass.':`; audio keeps its deadline ${processing.audioDeadline}.`}</p>
    </Card>:null}
    {history?<Card className="p-5 space-y-3 break-words"><h2 className="text-lg font-semibold">Run history</h2>
      <p>Recording {history.recordingId}. Pages use run-ID order, not chronological order.</p>
      {!history.runs.length?<p>No runs returned for this page. No deletion is confirmed.</p>:null}
      {history.runs.map(run=><section key={run.runId} className="border-t pt-3 space-y-2">
        <h3 className="font-semibold">Run {run.runId}</h3><p>Revision {run.version} · claimed {run.claimedAt} · lease deadline {run.leaseUntil}</p>
        <p>{run.leaseActive?'Lease was active when the server checked. Execution is not independently confirmed.':'Lease is not current. This does not establish whether remote work finished.'}</p>
        {run.result?<><p>{outcomeNames[run.result.outcome]}</p><p>Exact-version delete acknowledgments: {run.result.deleteAcknowledged===null?'Unknown':run.result.deleteAcknowledged}. Whole-recording erasure: not confirmed.</p>
          <p>{run.result.appliedToSchedule?'Result updated the recheck schedule.':'Historical result did not change the current schedule.'} Recorded {run.result.recordedAt}.</p></>:<p>No result recorded — outcome remains unknown.</p>}
      </section>)}
      {history.nextAfter?<Btn disabled={busy} onClick={()=>void load({action:'history',recordingId:history.recordingId,after:history.nextAfter!})}>Next history page</Btn>:null}
    </Card>:null}
  </div>;
}
