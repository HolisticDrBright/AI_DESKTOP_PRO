'use client';
import {useEffect,useRef,useState} from 'react';
import {privacyOperationSchema,parsePrivacyOperationResult,type PrivacyOperation,type PrivacyQueue,type PrivacyDetail} from '@/contracts/privacyOperations';
import {Card} from '@/components/ui/bits';
import {Btn} from '@/components/ui/Btn';
const messages:Record<string,string>={
  reauth_required:'Sign out and sign in again with your workforce account. Privacy operations require a login within the last 15 minutes.',
  privacy_access_refused:'This request requires an active privacy assignment. Ordinary clinic membership does not grant access.',
  conflict:'The saved record or decision changed, or the requested correction has not been saved exactly. Refresh and review before retrying.',
  legal_hold:'A legal hold prevents this action. No hold was removed.',
  request_invalid:'Check the requested outcome, revision and explanation.',
  service_unavailable:'Privacy operations are unavailable on this deployment. No completion is confirmed.',
};
export function PrivacyOperationsWorkspace(){
  const [queue,setQueue]=useState<PrivacyQueue|null>(null),[detail,setDetail]=useState<PrivacyDetail|null>(null);
  const [closed,setClosed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [outcome,setOutcome]=useState<'applied'|'declined'>('applied'),[revision,setRevision]=useState(''),[explanation,setExplanation]=useState('');
  const [confirm,setConfirm]=useState(false),[notice,setNotice]=useState('');
  const alive=useRef(true),working=useRef(false),generation=useRef(0);
  const abort=useRef<AbortController|null>(null);
  useEffect(()=>{
    alive.current=true;
    const invalidate=()=>{generation.current++;abort.current?.abort();};
    const clear=()=>{
      invalidate();working.current=false;
      setBusy(false);setQueue(null);setDetail(null);setExplanation('');setRevision('');setConfirm(false);setError('');setNotice('');
    };
    const hide=()=>{if(document.visibilityState==='hidden')clear();};
    document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',clear);
    return()=>{alive.current=false;invalidate();
      document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',clear);};
  },[]);
  async function perform(input:PrivacyOperation){
    if(working.current||!alive.current)return;
    const parsed=privacyOperationSchema.safeParse(input);
    if(!parsed.success){setError(messages.request_invalid);return;}
    working.current=true;setBusy(true);setError('');setNotice('');
    const epoch=++generation.current;
    const controller=new AbortController();abort.current=controller;
    const timeout=setTimeout(()=>controller.abort(),22000);
    try{
      const response=await fetch('/api/live/privacy-operations',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify(parsed.data),cache:'no-store',credentials:'same-origin',redirect:'error',signal:controller.signal});
      const text=await response.text();if(new TextEncoder().encode(text).byteLength>250000)throw new Error('oversize');
      const body=JSON.parse(text);
      if(!alive.current||epoch!==generation.current)return;
      if(!response.ok){
        if(response.status===401||response.status===403){setDetail(null);setQueue(null);setExplanation('');setRevision('');setConfirm(false);}
        setError(messages[typeof body?.error==='string'?body.error:'']??messages.service_unavailable);return;
      }
      const result=parsePrivacyOperationResult(parsed.data,body.data);
      if(input.action==='list'){setQueue(result as PrivacyQueue);setDetail(null);setConfirm(false);setExplanation('');}
      else{setDetail(result as PrivacyDetail);setConfirm(false);
        if(input.action==='resolve'){setQueue(null);setNotice('Decision verified and recorded. Refresh the queue to see remaining requests.');}
        else{setExplanation('');setRevision('');setOutcome('applied');}}
    }catch{if(alive.current&&epoch===generation.current)setError(messages.service_unavailable);}
    finally{clearTimeout(timeout);if(alive.current&&epoch===generation.current){working.current=false;setBusy(false);}}
  }
  const terminal=detail&&['completed','refused'].includes(detail.status);
  const canResolve=detail?.kind==='correction'&&detail.correction&&!terminal&&!detail.legalHold;
  return <div className="space-y-4">
    <Card className="p-5 space-y-3">
      <p>Only requests covered by your explicit privacy assignment appear here. This does not connect an independent consumer to your clinic.</p>
      <p className="text-sm text-subtle">Review is separate from editing a record. An applied decision verifies an already-saved, exact correction; it cannot change clinical data, consent, protocols or legal holds.</p>
      <label className="flex gap-2"><input type="checkbox" checked={closed} disabled={busy} onChange={e=>{setClosed(e.target.checked);setQueue(null);setDetail(null);setConfirm(false);}}/>Include completed and declined requests</label>
      <Btn disabled={busy} onClick={()=>void perform({action:'list',includeClosed:closed})}>{busy?'Working…':'Load / refresh assigned requests'}</Btn>
      {error?<p role="alert" className="text-danger">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {!queue&&!error?<p>Request history has not been loaded.</p>:null}
      {queue?.items.length===0?<p>No assigned requests match this view.</p>:null}
      {queue?.items.map(item=><div key={item.privacyRequestId} className="border-t py-3 flex flex-wrap items-center justify-between gap-2">
        <div><strong>{item.kind} — {item.status}</strong><p className="text-sm">Request {item.privacyRequestId} · submitted {item.submittedAt.slice(0,10)}</p></div>
        <Btn disabled={busy} onClick={()=>void perform({action:'detail',privacyRequestId:item.privacyRequestId})}>Review request</Btn>
      </div>)}
      {queue?.nextAfter?<Btn disabled={busy} onClick={()=>void perform({action:'list',includeClosed:closed,after:queue.nextAfter!})}>Next 25 requests</Btn>:null}
    </Card>
    {detail?<Card className="p-5 space-y-3">
      <h2 className="text-lg font-semibold">Request review</h2>
      <p>Request {detail.privacyRequestId} · {detail.status}</p>
      <p className="text-sm">Consumer reference: {detail.ownerId}</p>
      {detail.legalHold?<p role="alert">Legal hold active. This screen cannot remove it or complete this request.</p>:null}
      {detail.correction?<><p>{detail.correction.target.collection} · {detail.correction.target.field} · original revision {detail.correction.target.expectedRevision}</p>
        <dl className="space-y-2 break-words">
          <dt>Original value</dt><dd>{detail.correction.originalAvailable?JSON.stringify(detail.correction.originalValue):'Original record unavailable'}</dd>
          <dt>Requested value</dt><dd>{JSON.stringify(detail.correction.requestedValue)}</dd>
          <dt>Consumer reason</dt><dd className="whitespace-pre-wrap">{detail.correction.reason}</dd>
          <dt>Current stored value</dt><dd>{detail.correction.currentDeleted?'Deleted or unavailable':JSON.stringify(detail.correction.currentValue)} · revision {detail.correction.currentRevision??'unavailable'}</dd>
        </dl>
        {detail.correction.resolution?<p>Recorded outcome: {detail.correction.resolution.outcome}. {detail.correction.resolution.explanation}</p>:null}
      </>:detail.kind==='correction'?<p>This older request has no revision-bound target and cannot be completed here. Obtain a new consumer correction request.</p>:null}
      {detail.kind==='deletion'?<><p>Deletion requires reconciliation of all nine stores. This screen does not erase data or attest completion.</p>
        <ul>{detail.fulfillment.map((f,i)=><li key={i}>{f.store}: {f.outcome} ({f.recordedAt.slice(0,10)})</li>)}</ul>
        {!detail.fulfillment.length?<p>No fulfillment evidence recorded.</p>:null}</>:null}
      {canResolve?<div className="space-y-3 border-t pt-3">
        <label className="block">Decision <select value={outcome} disabled={busy} className="border rounded p-2" onChange={e=>{setOutcome(e.target.value as 'applied'|'declined');setConfirm(false);}}>
          <option value="applied">Verify a saved correction</option><option value="declined">Decline with explanation</option></select></label>
        {outcome==='applied'?<label className="block">Saved successor revision <input aria-label="Saved successor revision" className="border rounded p-2" inputMode="numeric" value={revision} disabled={busy} onChange={e=>{setRevision(e.target.value);setConfirm(false);}}/></label>:null}
        <label className="block">Explanation visible to the consumer<textarea aria-label="Explanation visible to the consumer" className="block border rounded p-2 w-full" maxLength={2000} value={explanation} disabled={busy} onChange={e=>{setExplanation(e.target.value);setConfirm(false);}}/></label>
        <label className="flex gap-2"><input type="checkbox" checked={confirm} disabled={busy} onChange={e=>setConfirm(e.target.checked)}/>I reviewed this exact request and the explanation. This records a final decision, not a clinical edit.</label>
        <Btn disabled={busy||!confirm||!explanation.trim()||outcome==='applied'&&!/^[1-9][0-9]{0,8}$/.test(revision)} onClick={()=>void perform({
          action:'resolve',privacyRequestId:detail.privacyRequestId,outcome,appliedRevision:outcome==='applied'?Number(revision):null,explanation:explanation.trim()})}>Record verified decision</Btn>
        <Btn disabled={busy} onClick={()=>void perform({action:'detail',privacyRequestId:detail.privacyRequestId})}>Refresh this request</Btn>
      </div>:null}
    </Card>:null}
  </div>;
}
