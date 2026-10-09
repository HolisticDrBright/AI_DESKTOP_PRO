'use client';
import {useEffect,useRef,useState} from 'react';
import {privacyOperationSchema,parsePrivacyOperationResult,type PrivacyOperation,type PrivacyQueue,type PrivacyDetail,type PersonalPurgePreview,type PersonalPurgeReceipt,type ExternalInventorySummary,type ExportCleanupSummary,type ExportReconcileSummary,type ExportBacklog} from '@/contracts/privacyOperations';
import {Card} from '@/components/ui/bits';
import {correctionEntryListDiff,isCorrectionEntryList,type CorrectionEntry} from '@/contracts/personalCorrection';
import {Btn} from '@/components/ui/Btn';
const messages:Record<string,string>={
  reauth_required:'Sign out and sign in again with your workforce account. Privacy operations require a login within the last 15 minutes.',
  privacy_access_refused:'This request requires an active privacy assignment. Ordinary clinic membership does not grant access.',
  conflict:'The saved record, inventory or policy changed, or the requested correction has not been saved exactly. Refresh and review before retrying.',
  legal_hold:'A legal hold prevents this action. No hold was removed.',
  request_invalid:'Check the requested outcome, revision and explanation.',
  service_unavailable:'Privacy operations are unavailable on this deployment. No completion is confirmed.',
  personal_purge_not_activated:'Personal-history deletion has not been activated on this deployment. No deletion was performed.',
  external_inventory_not_activated:'Retained-job inventory has not been activated on this deployment. No external records were scanned or deleted.',
};
/** A non-empty list of flat entries on both sides is reviewed entry by entry (by unique id when every entry carries one, else by position). */
const entryList=(v:unknown):v is CorrectionEntry[]=>Array.isArray(v)&&(v.length===0||isCorrectionEntryList(v));
function EntryListReview({before,after}:{before:CorrectionEntry[];after:CorrectionEntry[]}){
  const diff=correctionEntryListDiff(before,after);
  const text=(entry:CorrectionEntry)=>Object.keys(entry).map(k=>`${k}: ${JSON.stringify(entry[k])}`).join(' · ');
  return <div className="space-y-1 text-sm">
    <p>Matched by {diff.identity==='id'?'entry id':'position'} · {diff.unchanged} unchanged · {diff.changed.length} changed · {diff.added.length} added · {diff.removed.length} removed. Verify every changed, added and removed entry against the consumer&apos;s reason before recording an outcome.</p>
    <ul className="list-disc pl-5">
      {diff.removed.map(r=><li key={`r:${r.key}`}>Removed [{r.key}]: {text(r.entry)}</li>)}
      {diff.added.map(a=><li key={`a:${a.key}`}>Added [{a.key}]: {text(a.entry)}</li>)}
      {diff.changed.map(c=><li key={`c:${c.key}`}>Changed [{c.key}] {c.fields.join(', ')}: {c.fields.map(f=>`${f} ${JSON.stringify(c.before[f])} → ${JSON.stringify(c.after[f])}`).join('; ')}</li>)}
    </ul>
  </div>;
}
export function PrivacyOperationsWorkspace(){
  const [queue,setQueue]=useState<PrivacyQueue|null>(null),[detail,setDetail]=useState<PrivacyDetail|null>(null);
  const [closed,setClosed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [outcome,setOutcome]=useState<'applied'|'declined'>('applied'),[revision,setRevision]=useState(''),[explanation,setExplanation]=useState('');
  const [disputeOutcome,setDisputeOutcome]=useState<'amended'|'annotated'|'removed'|'declined'>('amended'),[amendment,setAmendment]=useState('');
  const [confirm,setConfirm]=useState(false),[notice,setNotice]=useState('');
  const [policy,setPolicy]=useState(''),[purgeConfirmation,setPurgeConfirmation]=useState('');
  const [preview,setPreview]=useState<PersonalPurgePreview|null>(null),[receipt,setReceipt]=useState<PersonalPurgeReceipt|null>(null);
  const [purgeCommand,setPurgeCommand]=useState<string|null>(null);
  const [inventory,setInventory]=useState<ExternalInventorySummary|null>(null);
  const [inventoryCommand,setInventoryCommand]=useState<Extract<PrivacyOperation,{action:'externalInventory'}>|null>(null);
  const [retention,setRetention]=useState<ExportCleanupSummary|null>(null),[reconcile,setReconcile]=useState<ExportReconcileSummary|null>(null),[backlog,setBacklog]=useState<ExportBacklog|null>(null);
  const alive=useRef(true),working=useRef(false),generation=useRef(0);
  const abort=useRef<AbortController|null>(null);
  useEffect(()=>{
    alive.current=true;
    const invalidate=()=>{generation.current++;abort.current?.abort();};
    const clear=()=>{
      invalidate();working.current=false;
      setBusy(false);setQueue(null);setDetail(null);setExplanation('');setRevision('');setConfirm(false);setError('');setNotice('');
      setPolicy('');setPurgeConfirmation('');setPreview(null);setReceipt(null);setPurgeCommand(null);
      setInventory(null);setInventoryCommand(null);setRetention(null);setReconcile(null);setBacklog(null);
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
    if(parsed.data.action==='externalInventory')setInventoryCommand(parsed.data);
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
        if([400,401,403,409].includes(response.status)){setPreview(null);setPurgeCommand(null);setPurgeConfirmation('');setInventory(null);setInventoryCommand(null);}
        if(response.status===401||response.status===403){setDetail(null);setQueue(null);setExplanation('');setRevision('');setConfirm(false);setReceipt(null);setPolicy('');}
        setError(messages[typeof body?.error==='string'?body.error:'']??messages.service_unavailable);return;
      }
      const result=parsePrivacyOperationResult(parsed.data,body.data);
      if(input.action==='externalInventory'){
        const saved=result as ExternalInventorySummary;setInventory(saved);setInventoryCommand(null);
        setDetail(previous=>previous?.privacyRequestId===saved.privacyRequestId?{...previous,
          externalInventories:[saved,...previous.externalInventories.filter(i=>i.inventoryId!==saved.inventoryId)].slice(0,20)}:previous);return;
      }
      if(input.action==='previewPersonalPurge'){
        setPreview(result as PersonalPurgePreview);setReceipt(null);setPurgeConfirmation('');setPurgeCommand(crypto.randomUUID());return;
      }
      if(input.action==='purgePersonal'){
        setReceipt(result as PersonalPurgeReceipt);setPreview(null);setPurgeConfirmation('');
        setNotice('Personal-storage purge receipt verified. Other stores remain unresolved; this is not complete account deletion.');return;
      }
      setPreview(null);setReceipt(null);setPurgeCommand(null);setPolicy('');setPurgeConfirmation('');
      setInventory(null);setInventoryCommand(null);
      if(input.action==='cleanupExports'){setRetention(result as ExportCleanupSummary);return;}
      if(input.action==='reconcileExports'){setReconcile(result as ExportReconcileSummary);return;}
      if(input.action==='exportBacklog'){setBacklog(result as ExportBacklog);return;}
      if(input.action==='list'){setQueue(result as PrivacyQueue);setDetail(null);setConfirm(false);setExplanation('');}
      else{setDetail(result as PrivacyDetail);setConfirm(false);
        if(input.action==='resolve'||input.action==='resolveDispute'){setQueue(null);setNotice('Decision verified and recorded. Refresh the queue to see remaining requests.');}
        else{setExplanation('');setRevision('');setOutcome('applied');setDisputeOutcome('amended');setAmendment('');}}
    }catch{if(alive.current&&epoch===generation.current)setError(messages.service_unavailable);}
    finally{clearTimeout(timeout);if(alive.current&&epoch===generation.current){working.current=false;setBusy(false);}}
  }
  const terminal=detail&&['completed','refused'].includes(detail.status);
  const canResolve=detail?.kind==='correction'&&detail.correction&&!terminal&&!detail.legalHold;
  const canResolveDispute=detail?.kind==='dispute'&&detail.dispute&&!terminal&&!detail.legalHold;
  return <div className="space-y-4">
    <Card className="p-5 space-y-3">
      <p>Only requests covered by your explicit privacy assignment appear here. This does not connect an independent consumer to your clinic.</p>
      <p className="text-sm text-subtle">Review is separate from editing a record. An applied decision verifies an already-saved, exact correction; it cannot change clinical data, consent, protocols or legal holds.</p>
      <label className="flex gap-2"><input type="checkbox" checked={closed} disabled={busy} onChange={e=>{setClosed(e.target.checked);setQueue(null);setDetail(null);setConfirm(false);setPreview(null);setReceipt(null);setPurgeCommand(null);setPolicy('');setPurgeConfirmation('');setInventory(null);setInventoryCommand(null);}}/>Include completed and declined requests</label>
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
      <div className="border-t pt-3 space-y-2">
        <p className="text-sm text-subtle">Export retention: removes the prepared personal-storage copies, staging versions and unfinished uploads of finished or expired export jobs for owners covered by your assignment, including closed accounts. Nothing is opened or read; a job is certified removed only after the store lists nothing under its key.</p>
        <div className="flex flex-wrap gap-2">
          <Btn disabled={busy} onClick={()=>void perform({action:'exportBacklog'})}>Show export retention backlog</Btn>
          <Btn disabled={busy} onClick={()=>void perform({action:'cleanupExports',maxItems:10})}>Run export retention pass (up to 10 jobs)</Btn>
          <Btn disabled={busy} onClick={()=>void perform({action:'reconcileExports',maxItems:10})}>Re-check recorded removals (up to 10 jobs)</Btn>
        </div>
        {backlog?<p role="status">Backlog for your assignments at {backlog.measuredAt.slice(0,19)}Z: {backlog.cleanupPending} due for removal, {backlog.settling} settling, {backlog.deferred} deferred after failures, {backlog.downloadExpired} expired downloads not yet removed, {backlog.removalRecorded} removals recorded awaiting re-check, {backlog.removalVerified} verified, {backlog.reopened} reopened after something reappeared, {backlog.retainedUnderHold} retained under hold. Oldest pending {Math.floor(backlog.oldestOverdueSeconds/3600)} h.</p>:null}
        {retention?<p role="status">Removed {retention.cleaned}; deferred after failure {retention.deferred}; still pending {retention.remaining-retention.deferred}{retention.items.length===0?' (nothing due for your assignments)':''}.</p>:null}
        {reconcile?<p role="status">Re-checked {reconcile.items.length}: confirmed {reconcile.confirmed}, reopened {reconcile.reopened}, not reachable {reconcile.pending}.</p>:null}
      </div>
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
          {detail.correction.originalAvailable&&entryList(detail.correction.originalValue)&&entryList(detail.correction.requestedValue)
            ?<><dt>Entry-by-entry review</dt><dd><EntryListReview before={detail.correction.originalValue} after={detail.correction.requestedValue}/></dd></>:null}
          <dt>Consumer reason</dt><dd className="whitespace-pre-wrap">{detail.correction.reason}</dd>
          <dt>Current stored value</dt><dd>{detail.correction.currentDeleted?'Deleted or unavailable':JSON.stringify(detail.correction.currentValue)} · revision {detail.correction.currentRevision??'unavailable'}</dd>
        </dl>
        {detail.correction.resolution?<p>Recorded outcome: {detail.correction.resolution.outcome}. {detail.correction.resolution.explanation}</p>:null}
      </>:detail.kind==='correction'?<p>This older request has no revision-bound target and cannot be completed here. Obtain a new consumer correction request.</p>:null}
      {detail.dispute?<section aria-label="Dispute" className="space-y-2 break-words">
        <p><strong>Dispute</strong> · {detail.dispute.target.store.replaceAll('_',' ')} · requested: {detail.dispute.target.requestedAction}</p>
        <dl className="space-y-2">
          <dt>Reference</dt><dd className="break-all">{detail.dispute.target.referenceId}{detail.dispute.target.contentSha256?` · content digest ${detail.dispute.target.contentSha256}`:' · no content digest supplied'}</dd>
          <dt>Consumer statement</dt><dd className="whitespace-pre-wrap">{detail.dispute.statement}</dd>
          <dt>Request digest</dt><dd className="break-all">{detail.dispute.target.requestSha256}</dd>
        </dl>
        <p className="text-sm text-subtle">Verify the reference in its store (lab inventory for results and documents, voice inventory for transcripts, the record itself for personal records) before recording an outcome. An amendment, annotation or removal must already exist and is named by its evidence digest; this screen changes no clinical content.</p>
        {detail.dispute.resolution?<p>Recorded outcome: {detail.dispute.resolution.outcome}{detail.dispute.resolution.amendmentSha256?` · evidence ${detail.dispute.resolution.amendmentSha256}`:''}. {detail.dispute.resolution.explanation}</p>:null}
      </section>:detail.kind==='dispute'?<p>This dispute has no stored target and cannot be resolved here.</p>:null}
      {detail.kind==='deletion'?<><p>Deletion requires reconciliation of all nine stores. The personal-storage action below cannot complete account deletion.</p>
        <ul>{detail.fulfillment.map((f,i)=><li key={i}>{f.store}: {f.outcome} ({f.recordedAt.slice(0,10)})</li>)}</ul>
        {!detail.fulfillment.length?<p>No fulfillment evidence recorded.</p>:null}
        {!terminal?<section aria-label="Retained lab and voice inventory" className="border-t pt-3 space-y-3">
          <h3 className="font-semibold">Read-only retained-job inventory</h3>
          <p>Find retained lab jobs, lab cleanup watches and voice jobs. This includes old processing records, not just recent visible history. No files are opened or deleted, and legal holds remain in place.</p>
          <p>Each click scans up to 25 table records. Counts may include unresolved metadata. An exhausted scan is not a point-in-time snapshot or proof of complete account inventory: source objects, orphaned/legacy rows, other stores and backups still need reconciliation.</p>
          <div className="flex flex-wrap gap-2">{(['labs','voice'] as const).map(store=><Btn key={store} disabled={busy||!!inventoryCommand} onClick={()=>{setInventory(null);void perform({action:'externalInventory',privacyRequestId:detail.privacyRequestId,inventoryId:crypto.randomUUID(),store,expectedRevision:0});}}>Start {store} inventory</Btn>)}</div>
          {inventoryCommand?<Btn disabled={busy} onClick={()=>void perform(inventoryCommand)}>Retry same inventory page</Btn>:null}
          {inventory?<div role="status" className="space-y-2">
            <p>{inventory.store}: {inventory.state} · {inventory.items} retained records · {inventory.issues} metadata issues · {inventory.scanned} table records scanned.</p>
            <p className="break-all">Inventory {inventory.inventoryId}, page {inventory.revision}. Evidence {inventory.evidenceSha256}</p>
            <p>No deletion performed. Independent reconciliation required.</p>
            {inventory.state==='scanning'?<Btn disabled={busy||!!inventoryCommand} onClick={()=>void perform({action:'externalInventory',privacyRequestId:detail.privacyRequestId,inventoryId:inventory.inventoryId,store:inventory.store,expectedRevision:inventory.revision})}>Scan next inventory page</Btn>:null}
            {inventory.state==='bounded'?<p role="alert">This scan reached its safety bound. An operator must reconcile the remaining inventory; it is not complete.</p>:null}
          </div>:null}
          {detail.externalInventories.map(saved=><div key={saved.inventoryId} className="text-sm border-t pt-2">
            <p>Saved {saved.store} inventory · {saved.state} · {saved.items} retained records · {saved.issues} metadata issues · {saved.updatedAt.slice(0,10)}</p>
            <Btn disabled={busy||!!inventoryCommand} onClick={()=>void perform({action:'externalInventory',privacyRequestId:detail.privacyRequestId,inventoryId:saved.inventoryId,store:saved.store,expectedRevision:saved.revision})}>Resume / review saved {saved.store} inventory</Btn>
          </div>)}
          <Btn disabled={busy} onClick={()=>void perform({action:'detail',privacyRequestId:detail.privacyRequestId})}>Refresh saved inventories</Btn>
        </section>:null}
        {!terminal&&!detail.legalHold?<section aria-label="Personal-history deletion" className="border-t pt-3 space-y-3">
          <h3 className="font-semibold">Preview personal-history deletion</h3>
          <p>Separate deployment approval and a policy explicitly authorizing this purge are required. No policy or approval is created here.</p>
          <p>This removes personal record versions, storage consents, the active plan and its adoption history. Labs/documents, voice/transcripts, identity, clinic records, device copies, backups and audit records are not erased by this action.</p>
          <label className="block">Approved purge policy version <input aria-label="Approved purge policy version" className="border rounded p-2" maxLength={200} value={policy} disabled={busy||!!preview||!!receipt} onChange={e=>setPolicy(e.target.value)}/></label>
          {!receipt?<Btn disabled={busy||!policy.trim()} onClick={()=>void perform({action:'previewPersonalPurge',privacyRequestId:detail.privacyRequestId,policyVersion:policy.trim()})}>Preview exact deletion</Btn>:null}
          {preview?<div className="space-y-3">
            <p>Records: {preview.records} · Consents: {preview.consents} · Active plans: {preview.activePlans} · Plan history: {preview.planHistory}</p>
            <p className="whitespace-pre-wrap break-words">{preview.policyContent}</p>
            <p className="text-sm break-all">Inventory SHA-256: {preview.inventorySha256}<br/>Policy SHA-256: {preview.policySha256}</p>
            <p>Review the exact counts and policy. This is irreversible through this screen. If a response is lost, retrying the same command returns its original receipt; it does not erase newer data. A new preview requires a new confirmation.</p>
            <label className="block">Type PURGE PERSONAL HISTORY <input aria-label="Type PURGE PERSONAL HISTORY" className="border rounded p-2" autoComplete="off" value={purgeConfirmation} disabled={busy} onChange={e=>setPurgeConfirmation(e.target.value)}/></label>
            <Btn disabled={busy||purgeConfirmation!=='PURGE PERSONAL HISTORY'||!purgeCommand} onClick={()=>void perform({action:'purgePersonal',privacyRequestId:detail.privacyRequestId,
              commandId:purgeCommand!,policyVersion:preview.policyVersion,policySha256:preview.policySha256,inventorySha256:preview.inventorySha256,confirmation:'PURGE PERSONAL HISTORY'})}>Confirm personal-history deletion / retry same command</Btn>
          </div>:null}
          {receipt?<div role="status" className="space-y-2 break-words"><p>Verified personal purge: {receipt.records} record versions, {receipt.consents} consents, {receipt.activePlans} active plans and {receipt.planHistory} history rows.</p>
            <p>Receipt time: {receipt.verifiedAt}. This receipt does not claim data added afterward was deleted.</p><p className="break-all">Evidence: {receipt.evidenceSha256}</p><p>Complete account deletion: no.</p></div>:null}
          <Btn disabled={busy} onClick={()=>void perform({action:'detail',privacyRequestId:detail.privacyRequestId})}>Refresh deletion request</Btn>
        </section>:null}</>:null}
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
      {canResolveDispute?<div className="space-y-2 border-t pt-3">
        <label className="block">Dispute decision <select value={disputeOutcome} disabled={busy} className="border rounded p-2" onChange={e=>{setDisputeOutcome(e.target.value as typeof disputeOutcome);setConfirm(false);}}>
          <option value="amended">Amended (evidence digest of the amended content)</option><option value="annotated">Annotated (evidence digest of the annotation)</option>
          <option value="removed">Removed (evidence digest of the removal receipt)</option><option value="declined">Decline with explanation</option></select></label>
        {disputeOutcome!=='declined'?<label className="block">Evidence digest (SHA-256, 64 hex) <input aria-label="Evidence digest" className="border rounded p-2 w-full" value={amendment} disabled={busy} onChange={e=>{setAmendment(e.target.value.trim().toLowerCase());setConfirm(false);}}/></label>:null}
        <label className="block">Explanation visible to the consumer<textarea aria-label="Dispute explanation visible to the consumer" className="block border rounded p-2 w-full" maxLength={2000} value={explanation} disabled={busy} onChange={e=>{setExplanation(e.target.value);setConfirm(false);}}/></label>
        <label className="flex gap-2"><input type="checkbox" checked={confirm} disabled={busy} onChange={e=>setConfirm(e.target.checked)}/>I verified the disputed content in its store and the evidence named here. This records a final decision, not a clinical edit.</label>
        <Btn disabled={busy||!confirm||!explanation.trim()||(disputeOutcome!=='declined'&&!/^[a-f0-9]{64}$/.test(amendment))} onClick={()=>void perform({
          action:'resolveDispute',privacyRequestId:detail.privacyRequestId,outcome:disputeOutcome,amendmentSha256:disputeOutcome==='declined'?null:amendment,explanation:explanation.trim()})}>Record dispute decision</Btn>
      </div>:null}
    </Card>:null}
  </div>;
}
