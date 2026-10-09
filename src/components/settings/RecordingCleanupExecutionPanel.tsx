'use client';
import {useEffect,useRef,useState} from 'react';
import {Btn} from '@/components/ui/Btn';
import {AdapterError,codeFromHttpStatus} from '@/adapters/errors';
import {parseCleanupExecutionResponse,type CleanupExecutionRequest,type CleanupExecutionReceipt} from '@/contracts/recordingCleanupExecution';
import {parseCleanupReviewResponse,type CleanupHistoryPage} from '@/contracts/recordingCleanupReview';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
type Selection={recordingId:string;version:number};
/** No automatic submission/retry and no browser persistence. Parent unmounts
 * this panel on identity, visibility, offline, navigation or snapshot expiry.
 * A pass already sent may continue; durable server history is recovery authority. */
export function RecordingCleanupExecutionPanel({selection}:{selection:Selection}){
  const [history,setHistory]=useState<CleanupHistoryPage|null>(null),[confirmation,setConfirmation]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<CleanupExecutionRequest|null>(null);
  const [receipt,setReceipt]=useState<CleanupExecutionReceipt|null>(null);
  const alive=useRef(false),working=useRef(false),abort=useRef<AbortController|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
  async function request<T>(path:string,body:unknown,parse:(value:unknown)=>T,limit:number):Promise<T>{
    const controller=new AbortController();abort.current=controller;let timer:ReturnType<typeof setTimeout>|undefined;
    const operation=async()=>{
      const response=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new AdapterError('unavailable');}
      if(!response.ok){void response.body?.cancel().catch(()=>{});throw new AdapterError(response.status===409?'conflict':codeFromHttpStatus(response.status));}
      if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new AdapterError('unavailable');
      const headers=new Headers(response.headers);if(headers.has('content-encoding'))headers.delete('content-length');
      const bytes=await readBoundedRequestBody({body:response.body,headers,signal:controller.signal},limit,5000);
      if(controller.signal.aborted)throw new AdapterError('unavailable');
      return parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    };
    try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AdapterError('unavailable'));},40000);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  async function loadHistory(){
    if(!alive.current||working.current)return;working.current=true;setBusy(true);setError('');setHistory(null);setConfirmation(false);
    const input={action:'history' as const,recordingId:selection.recordingId};
    try{
      const result=await request('/api/live/recording-cleanup-review',input,v=>parseCleanupReviewResponse(input,v),128000);
      if(alive.current&&'runs' in result.data)setHistory(result.data);
    }catch{if(alive.current)setError('History could not be verified. A new pass is not available. Any earlier submitted pass may still be running.');}
    finally{if(alive.current){working.current=false;setBusy(false);}}
  }
  async function run(){
    if(!alive.current||working.current||!history||!confirmation||receipt||!pending&&history.runs.some(r=>r.leaseActive))return;
    working.current=true;setBusy(true);setError('');
    let prepared=false;
    try{
      const input=pending??{...selection,requestId:crypto.randomUUID(),confirmation:'run_bounded_cleanup_pass' as const};
      setPending(input);prepared=true;
      const result=await request('/api/live/recording-cleanup-execution',input,v=>parseCleanupExecutionResponse(input,v),4096);
      if(alive.current)setReceipt(result.data);
    }catch(e){if(alive.current){
      const code=e instanceof AdapterError?e.code:'unavailable';
      setError(!prepared?'The browser could not prepare a request reference. No cleanup request was submitted.':
        code==='unauthenticated'?'Sign in again with your workforce account, then review run history. Do not assume the pass was cancelled.':
        code==='forbidden'?'The workforce service refused this operation. Review your cleanup-operator assignment and run history.':
        code==='conflict'?'The service reported a hold, active lease, changed revision or not-yet-due work. Refresh the queue and review history.':
        'The pass outcome could not be verified. Review run history or retry the same request below. A network error does not prove that no work occurred.');
    }}finally{if(alive.current){working.current=false;setBusy(false);}}
  }
  return <section data-testid="recording-cleanup-execution" className="border rounded p-4 space-y-3" aria-label="Bounded cleanup pass">
    <h3 className="font-semibold">Review one bounded cleanup pass</h3>
    <p>Recording {selection.recordingId}, revision {selection.version}. This may permanently delete eligible audio versions. It cannot remove holds or prove whole-recording erasure.</p>
    <p>Closing or refreshing this page does not cancel a submitted pass. After returning, load the queue and review history before requesting more work.</p>
    <Btn disabled={busy} onClick={()=>void loadHistory()}>Check run history before cleanup</Btn>
    {history?<div><p>History verified for this recording. {history.runs.length} runs returned{history.nextAfter?' on this page; this is not the full history':''}.</p>
      {history.runs.map(run=><p key={run.runId}>Run {run.runId}: {run.result?run.result.outcome:'no result — outcome unknown'}{run.leaseActive?' (lease active)':''}.</p>)}</div>:null}
    {history&&!pending&&history.runs.some(r=>r.leaseActive)?<p>A recorded lease is active. Refresh the queue and review history after it expires before preparing another pass.</p>:null}
    {pending?<p className="break-all">Request reference: {pending.requestId}. Retry uses this same reference.</p>:null}
    {!receipt?<><label className="flex gap-2"><input type="checkbox" checked={confirmation} disabled={busy||!history||!pending&&history.runs.some(r=>r.leaseActive)}
      onChange={e=>setConfirmation(e.target.checked)}/>I reviewed this recording and authorize one bounded cleanup pass, subject to server-enforced holds and retention rules.</label>
      <Btn disabled={busy||!history||!confirmation||!pending&&history.runs.some(r=>r.leaseActive)} onClick={()=>void run()}>{busy?'Checking cleanup…':pending?'Retry same cleanup request':'Run one bounded cleanup pass'}</Btn></>:null}
    {error?<p role="alert" className="text-danger">{error}</p>:null}
    {receipt?<p role="status">{'state' in receipt?'This request was already claimed. Inspect history; execution and its outcome are not confirmed by this acknowledgment.':
      `Pass result: ${receipt.outcome}. ${receipt.appliedToSchedule?'The recheck schedule was updated.':'The current schedule was not changed.'}`} Whole-recording erasure is not confirmed. Reload the queue before requesting another pass.</p>:null}
  </section>;
}
