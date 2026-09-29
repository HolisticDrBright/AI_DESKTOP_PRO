'use client';
import {useEffect,useRef,useState} from 'react';
import {parseCareMessageResponse,MESSAGE_ACK,type CareMessageRequest,type CareMessageResponse} from '@/contracts/careMessages';
import {onWorkforceSessionChange} from '@/lib/workforce-session-change';
type List=Extract<CareMessageResponse,{action:'list'}>;type Read=Extract<CareMessageResponse,{action:'read'}>;
export function CareMessagesPanel(){
 const [list,setList]=useState<List|null>(null),[thread,setThread]=useState<Read|null>(null),[draft,setDraft]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const pending=useRef<CareMessageRequest|null>(null),working=useRef(false),epoch=useRef(0),alive=useRef(true);
 function clear(){epoch.current++;pending.current=null;working.current=false;setBusy(false);setList(null);setThread(null);setDraft('');setNotice('');}
 useEffect(()=>{alive.current=true;const lifecycleEpoch=epoch;const stop=onWorkforceSessionChange(()=>{clear();setError('Session changed. Refresh messages.');});
 const hide=()=>{if(document.hidden){clear();setError('Refresh messages to check current access.');}};
 document.addEventListener('visibilitychange',hide);
 return()=>{alive.current=false;lifecycleEpoch.current++;stop();document.removeEventListener('visibilitychange',hide);};},[]);
 async function run(input:CareMessageRequest){
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');const generation=epoch.current;
  try{
   const response=await fetch('/api/live/care-messages',{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(25000)});
   if(!alive.current||epoch.current!==generation)return;
   if(!response.ok){if(response.status===401||response.status===403){clear();setError('Access changed. Sign in and check your clinic connection before refreshing.');return;}throw new Error('refused');}
   const data=parseCareMessageResponse(input,(await response.json()).data);
   if(!alive.current||epoch.current!==generation)return;
   if(data.action!==input.action)throw new Error('invalid');
   if(data.action==='list'){setList(current=>input.action==='list'&&input.before&&current?{...data,threads:[...current.threads,...data.threads]}:data);}
   if(data.action==='read'){setThread(current=>input.action==='read'&&input.before&&current?{...data,messages:[...current.messages,...data.messages]}:data);}
   if(data.action==='send'){pending.current=null;setDraft('');setThread(null);setNotice('Reply stored securely for the patient app. This does not mean the patient has read it. Refresh and reopen the conversation.');}
  }catch{if(alive.current&&epoch.current===generation)setError('Messages unavailable or access refused. No delivery is confirmed. Retry the same message if sending was interrupted.');}
  finally{if(alive.current&&epoch.current===generation){working.current=false;setBusy(false);}}
 }
 const button='rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50';
 return <section aria-label="Patient app messages" className="mb-5 space-y-3 rounded-xl border bg-card p-5">
  <h2 className="text-lg font-bold">Patient app messages</h2>
  <p className="text-sm">Secure text conversations with linked V2 patients. Synthetic testing only. Not monitored for emergencies. No email, SMS or push notification is sent.</p>
  <button className={button} disabled={busy||!!pending.current} onClick={()=>{setThread(null);void run({action:'list'});}}>Load / refresh app messages</button>
  {error?<p role="alert">{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
  {list?.threads.length===0?<p>No app conversations yet.</p>:null}
  {list?.threads.map(item=><button className={button+' block w-full text-left'} key={item.threadId} disabled={busy||!!pending.current}
   onClick={()=>{setThread(null);setDraft('');void run({action:'read',threadId:item.threadId});}}>{item.subject} · Patient {item.patientRecordId}</button>)}
  {list?.nextBefore?<button className={button} disabled={busy||!!pending.current} onClick={()=>void run({action:'list',before:list.nextBefore!})}>Older conversations</button>:null}
  {thread?<div className="space-y-3"><h3 className="font-bold">{thread.thread.subject}</h3>
   {thread.nextBefore?<button className={button} disabled={busy} onClick={()=>void run({action:'read',threadId:thread.thread.threadId,before:thread.nextBefore!})}>Older messages</button>:null}
   {[...thread.messages].reverse().map(item=><article key={item.messageId} className="rounded-lg border p-3"><p className="text-xs">{item.sender==='consumer'?'Patient':'Care team'} · {new Date(item.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{item.body}</p></article>)}
   <label className="block">Reply to patient<textarea aria-label="Reply to patient" maxLength={4000} value={draft} disabled={busy||!!pending.current}
    onChange={e=>setDraft(e.target.value)} className="block min-h-24 w-full rounded border p-3"/></label>
   <button className={button} disabled={busy||(!draft.trim()&&!pending.current)} onClick={()=>{
    pending.current??={action:'send',threadId:thread.thread.threadId,connectionId:thread.thread.connectionId,requestId:crypto.randomUUID(),body:draft.trim(),acknowledgement:MESSAGE_ACK};
    void run(pending.current);}}>{busy?'Sending…':pending.current?'Retry same reply':'Send reply'}</button>
  </div>:null}
 </section>;
}
