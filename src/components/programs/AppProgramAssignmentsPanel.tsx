'use client';
import {useEffect,useRef,useState} from 'react';
import {parseProgramAssignmentResponse,type ProgramAssignmentRequest,type ProgramAssignmentResponse} from '@/contracts/programAssignments';
import {onWorkforceSessionChange} from '@/lib/workforce-session-change';
import {RevisionAnnouncePanel} from '@/components/governance/RevisionAnnouncePanel';
import {ProtocolCartPanel} from './ProtocolCartPanel';

type Status=Extract<ProgramAssignmentResponse,{action:'status'}>;
type Connections=Extract<ProgramAssignmentResponse,{action:'connections'}>;
type Programs=Extract<ProgramAssignmentResponse,{action:'programs'}>;
type Preview=Extract<ProgramAssignmentResponse,{action:'preview'}>;

/**
 * Assigning a published program to a linked patient app account, and seeing where
 * each assignment has got to.
 *
 * This panel authors nothing, and now it cannot: it sends no content at all. An
 * earlier version asked the practitioner to paste a version id and a block of phases
 * JSON, and claimed in this comment that it authored nothing — but there was no
 * authenticated source lookup behind that claim, and the server trusted the paste. A
 * published version whose own content was empty could carry any phases a caller typed.
 *
 * What is here instead: a picker of the clinic's published versions, a preview the
 * server compiles from the published artifact, and an assign that names the version
 * and nothing else. The title, the steps, the released flags and any product all come
 * from what was published.
 *
 * It creates no enrollment, no charge and no protocol, and it never writes into the
 * patient's clinical plan — a program is an overlay the patient may add.
 */
export function AppProgramAssignmentsPanel(){
 const [status,setStatus]=useState<Status|null>(null);
 const [links,setLinks]=useState<Connections|null>(null);
 const [programs,setPrograms]=useState<Programs|null>(null);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [connectionId,setConnectionId]=useState('');
 const [programVersionId,setProgramVersionId]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const working=useRef(false),epoch=useRef(0),alive=useRef(true);
 function clear(){epoch.current++;working.current=false;setBusy(false);setStatus(null);setLinks(null);
  setPrograms(null);setPreview(null);setNotice('');}
 useEffect(()=>{
  alive.current=true;const lifecycleEpoch=epoch;
  const stop=onWorkforceSessionChange(()=>{clear();setError('Session changed. Refresh assignments.');});
  const hide=()=>{if(document.hidden){clear();setError('Refresh assignments to check current access.');}};
  document.addEventListener('visibilitychange',hide);
  return()=>{alive.current=false;lifecycleEpoch.current++;stop();document.removeEventListener('visibilitychange',hide);};
 },[]);

 async function run(input:ProgramAssignmentRequest){
  if(working.current)return;
  working.current=true;setBusy(true);setError('');setNotice('');
  const generation=epoch.current;
  try{
   const response=await fetch('/api/live/program-assignments',{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(25000)});
   if(!alive.current||epoch.current!==generation)return;
   if(!response.ok){
    if(response.status===401||response.status===403){clear();setError('Access changed. Sign in and check your clinic access before refreshing.');return;}
    // A conflict is the server refusing on purpose: an unpublished version, or content
    // that differs from what was already pinned under it.
    if(response.status===409){setError('Refused. Either that version is not published, or a different guide is already pinned to it. Nothing was assigned.');return;}
    throw new Error('refused');
   }
   const data=parseProgramAssignmentResponse(input,(await response.json()).data);
   if(!alive.current||epoch.current!==generation)return;
   if(data.action==='status')setStatus(data);
   if(data.action==='connections')setLinks(data);
   if(data.action==='programs')setPrograms(data);
   if(data.action==='preview')setPreview(data);
   if(data.action==='assign'){
    setNotice(data.duplicate
     ? 'That guide was already shared with this patient. Nothing changed and it was not shared twice.'
     : 'Shared with the patient app. They choose whether to add it; their plan is unchanged until they do.');
    setPreview(null);setProgramVersionId('');
    void run({action:'status'});
   }
   if(data.action==='release')setNotice('Phase released. The patient can move on once their steps are done and the phase has elapsed.');
  }catch{
   if(alive.current&&epoch.current===generation)setError('Program assignments are unavailable. Nothing was changed.');
  }finally{if(alive.current&&epoch.current===generation){working.current=false;setBusy(false);}}
 }

 function choose(versionId:string){
  setProgramVersionId(versionId);setPreview(null);
  if(versionId)void run({action:'preview',programVersionId:versionId});
 }

 const button='rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50';
 const field='block w-full rounded border p-2 text-sm';
 return <section aria-label="Patient app programs" className="mb-5 space-y-3 rounded-xl border bg-card p-5">
  <h2 className="text-lg font-bold">Patient app programs</h2>
  <p className="text-sm">Share a published program with a linked patient app account. Sharing does not enrol them, charge
   anything, order anything or change their plan — the patient decides whether to add it.</p>
  <p className="text-sm">Supplement steps are held for review until the governed catalogue is available to check them
   against, and a phase containing a held step will not advance. Share guides built from lessons, diet and habits.</p>
  <div className="flex flex-wrap gap-2">
   <button className={button} disabled={busy} onClick={()=>void run({action:'status'})}>Load / refresh assignments</button>
   <button className={button} disabled={busy} onClick={()=>void run({action:'connections'})}>Load linked patients</button>
   <button className={button} disabled={busy} onClick={()=>void run({action:'programs'})}>Load published programs</button>
  </div>
  {error?<p role="alert">{error}</p>:null}
  {notice?<p role="status">{notice}</p>:null}

  {links?<label className="block text-sm">Linked patient
   <select aria-label="Linked patient" className={field} value={connectionId} disabled={busy}
    onChange={event=>setConnectionId(event.target.value)}>
    <option value="">Select a linked patient…</option>
    {links.connections.map(link=><option key={link.connectionId} value={link.connectionId}>
     Patient {link.patientRecordId} · linked {new Date(link.verifiedAt).toLocaleDateString()}</option>)}
   </select>
   {links.connections.length===0?<span className="block pt-1">No patients have a live app link yet.</span>:null}
  </label>:null}

  {connectionId?<div className="space-y-2" data-testid="program-source-picker">
   {programs?<label className="block text-sm">Published program
    <select aria-label="Published program" className={field} value={programVersionId} disabled={busy}
     onChange={event=>choose(event.target.value)}>
     <option value="">Select a published program…</option>
     {programs.programs.map(entry=><option key={entry.programVersionId} value={entry.programVersionId}
      disabled={!entry.assignable}>
      {entry.title} · v{entry.programVersion}{entry.assignable
       ?` · ${entry.phaseCount} phases`
       :' · nothing approved for patients in this version'}</option>)}
    </select>
    {programs.programs.length===0
     ?<span className="block pt-1">No published programs yet. Publish a version before sharing it.</span>:null}
   </label>:<button className={button} disabled={busy}
     onClick={()=>void run({action:'programs'})}>Load published programs</button>}

   {programVersionId.trim()?<RevisionAnnouncePanel toVersionId={programVersionId.trim()}/>:null}
   {/* The supplement list this version compiles to, with its exclusions already applied. */}
   {programVersionId.trim()?<ProtocolCartPanel programVersionId={programVersionId.trim()}/>:null}
  {preview?<div className="rounded-lg border p-3" data-testid="program-preview">
    <p className="font-semibold">{preview.title}</p>
    <p className="text-sm">Version {preview.programVersion}. This is what the patient would see; it comes from the
     published version, not from anything typed here.</p>
    <ol className="mt-2 space-y-1 text-sm">{preview.phases.map(phase=><li key={phase.id}>
     <span className="font-medium">{phase.title}</span> · {phase.days} days · {phase.items.length} steps
     {phase.items.some(item=>preview.review.held.includes(item.id))
      ?<span> · contains a step held for review, so this phase will not advance</span>:null}
    </li>)}</ol>
    {preview.review.held.length>0?<p className="mt-2 text-sm" data-testid="program-preview-held">
     {preview.review.held.length} step{preview.review.held.length===1?'':'s'} held for review. Sharing is allowed; the
     patient will not be able to pass a phase containing one until the governed catalogue can check it.</p>:null}
   </div>:null}

   <button className={button} disabled={busy||!programVersionId.trim()||!preview}
    onClick={()=>void run({action:'assign',connectionId,programVersionId}as ProgramAssignmentRequest)}>
    Share with this patient</button>
  </div>:null}

  {status?status.assignments.length===0
   ?<p>No programs have been shared with a patient app account yet.</p>
   :<ul className="space-y-2">{status.assignments.map(item=><li key={item.enrollmentId} className="rounded-lg border p-3">
    <p className="font-semibold">{item.title}</p>
    <p className="text-sm">Patient {item.patientRecordId} · {item.state==='offered'?'shared, not added yet'
     :item.finished?'finished':item.state==='paused'?'paused by the patient'
     :item.state==='withdrawn'?'withdrawn by the patient'
     :`step ${item.phaseIndex+1} of ${item.phaseCount}`} · {item.completedCount} steps done</p>
    {item.state==='active'&&!item.finished?<PhaseRelease busy={busy}
     onRelease={phaseId=>void run({action:'release',enrollmentId:item.enrollmentId,phaseId})}/>:null}
   </li>)}</ul>:null}
 </section>;
}

/** Releasing a practitioner phase is a named clinical act, so the phase is typed explicitly. */
function PhaseRelease({busy,onRelease}:{busy:boolean;onRelease:(phaseId:string)=>void}){
 const [phaseId,setPhaseId]=useState('');
 return <div className="mt-2 flex flex-wrap items-end gap-2">
  <label className="text-sm">Release a phase that needs practitioner review
   <input aria-label="Phase id to release" className="block rounded border p-2 text-sm" value={phaseId} disabled={busy}
    onChange={event=>setPhaseId(event.target.value)}/></label>
  <button className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50"
   disabled={busy||!phaseId.trim()} onClick={()=>onRelease(phaseId.trim())}>Release phase</button>
 </div>;
}
