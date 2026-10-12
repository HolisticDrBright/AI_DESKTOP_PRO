if(typeof window!=='undefined')throw new Error('program media HTTP is server-only');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {readBoundedRequestBody,BoundedBodyError} from '@/server/bounded-request-body';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
import {PROGRAM_MEDIA_FAILURES,programMediaPrepareRequest,programMediaReadRequest,programMediaTextRequest,
 programMediaVersionRequest,programMediaReference,programMediaReferenceStatus,programMediaReservation,programMediaArtifact,
 programMediaPreview,programMediaCleanupReceipt,programMediaExtension,type ProgramMediaFailure} from '@/contracts/programMedia';
import {ProgramMediaError} from './program-media-authoring';

export const PROGRAM_MEDIA_HTTP_CONTRACT='program-media-control-http/1' as const;
const PATH='/api/live/programs/media/control',MAX_BODY_BYTES=1_048_576,MAX_REPLY_BYTES=1_048_576,MAX_DEADLINE_MS=30_000;

/** Metadata only. Video/image bytes never enter a JSON body, base64 field or
 * request-specific authority object. Chunk transport has its own admission. */
export const programMediaControlCommand=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('prepare'),request:programMediaPrepareRequest.refine(r=>r.bytes<=(r.kind==='image'?16_777_216:268_435_456))}).strict(),
 z.object({operation:z.literal('reconcile'),request:programMediaReadRequest}).strict(),
 z.object({operation:z.literal('attachText'),request:programMediaTextRequest}).strict(),
 z.object({operation:z.literal('preview'),request:programMediaReadRequest}).strict(),
 z.object({operation:z.literal('publish'),request:programMediaVersionRequest}).strict(),
 z.object({operation:z.literal('retire'),request:programMediaVersionRequest}).strict(),
 z.object({operation:z.literal('describeReference'),request:programMediaReference}).strict(),
 z.object({operation:z.literal('cleanupOrphans'),request:z.object({programId:z.string().uuid()}).strict()}).strict(),
]);
export type ProgramMediaControlCommand=z.infer<typeof programMediaControlCommand>;
type Source={execute(value:unknown,signal:AbortSignal):Promise<unknown>};
const STATUS:Record<ProgramMediaFailure,number>={program_media_disabled:503,request_invalid:400,access_refused:403,not_found:404,
 conflict:409,not_ready:409,retired:409,storage_unverified:503,service_unavailable:503,reservation_expired:409,text_source_refused:422};
const json=(status:number,value:unknown,extra:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{
 'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','Pragma':'no-cache','Vary':'Cookie, Origin',
 'X-Content-Type-Options':'nosniff',...extra}});
const refuse=(code:ProgramMediaFailure,status=STATUS[code],headers?:Record<string,string>)=>json(status,{contractVersion:PROGRAM_MEDIA_HTTP_CONTRACT,ok:false,error:{code}},headers);

function checkedReply(command:ProgramMediaControlCommand,value:unknown){
 let data:unknown;
 switch(command.operation){
  case 'prepare':{
   const r=programMediaReservation.parse(value),q=command.request;
   if(r.commandId!==q.commandId||r.programId!==q.programId||r.kind!==q.kind||r.contentType!==q.contentType||r.sha256!==q.sha256||r.bytes!==q.bytes)throw new Error('reply_unbound');
   data=r;break;
  }
  case 'reconcile':data=z.union([programMediaArtifact,programMediaReservation]).parse(value);break;
  case 'attachText':{
   const r=programMediaArtifact.parse(value),q=command.request,t=r[q.slot];
   if(!t||t.text!==q.text||t.source!==q.source||t.format!==q.format||t.sha256!==createHash('sha256').update(q.text).digest('hex'))throw new Error('reply_unbound');
   data=r;break;
  }
  case 'retire':{
   const r=programMediaArtifact.parse(value);if(r.state!=='retired')throw new Error('reply_unbound');data=r;break;
  }
  case 'preview':data=programMediaPreview.parse(value);break;
  case 'publish':{
   const r=programMediaReference.parse(value);if(r.version!==command.request.expectedVersion)throw new Error('reply_unbound');data=r;break;
  }
  case 'describeReference':{
   const r=programMediaReferenceStatus.parse(value);if(JSON.stringify(r.reference)!==JSON.stringify(command.request))throw new Error('reply_unbound');data=r;break;
  }
  case 'cleanupOrphans':{
   const r=programMediaCleanupReceipt.parse(value);if(r.programId!==command.request.programId)throw new Error('reply_unbound');data=r;break;
  }
 }
 if(command.operation!=='prepare'&&command.operation!=='cleanupOrphans'&&command.operation!=='describeReference'
  &&(data as {artifactId:string}).artifactId!==command.request.artifactId)throw new Error('reply_unbound');
 if(data&&typeof data==='object'&&'objectKey' in data){
  const r=programMediaReservation.or(programMediaArtifact).parse(data);
  if(r.objectKey!==`program-media/${r.clinic}/${r.programId}/${r.artifactId}/${r.sha256}.${programMediaExtension(r.kind,r.contentType)}`)throw new Error('reply_unbound');
 }
 return data;
}

/** Uninstalled HTTP source. The trusted host MUST authenticate current MFA
 * workforce authority before returning the request-specific native source.
 * That source separately rechecks DB release, scope, authority and STS storage.
 * This module does not create a host login, activation, secret or network port.
 * An interrupted response certifies neither cancellation nor deletion: native
 * durable write admission remains responsible for late/uncertain work. */
export function createProgramMediaControlHandler(input:{
 sourceForRequest:(request:Request,signal:AbortSignal)=>Promise<Source>;
 enabled?:boolean;timeoutMs?:number;
}){
 const enabled=input.enabled===true,timeout=input.timeoutMs??MAX_DEADLINE_MS,sourceForRequest=input.sourceForRequest;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_DEADLINE_MS)throw new Error('program_media_http_limits_invalid');
 return async(request:Request):Promise<Response>=>{
  if(!enabled)return refuse('program_media_disabled');
  const url=new URL(request.url);
  if(url.pathname!==PATH)return refuse('not_found');
  // URL.search is empty for a trailing '?'; the raw request URL still differs.
  if(request.url.includes('?')||url.hash)return refuse('request_invalid');
  if(request.method!=='POST')return refuse('request_invalid',405,{'Allow':'POST'});
  if(!sameBrowserOrigin(request)||request.signal.aborted)return refuse('access_refused');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')
   ||(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity'))return refuse('request_invalid',415);
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)<1||Number(length)>MAX_BODY_BYTES))return refuse('request_invalid');
  const controller=new AbortController(),deadline=Date.now()+timeout;
  let interrupted!:(error:ProgramMediaError)=>void;
  const stopped=new Promise<never>((_,reject)=>{interrupted=reject;});
  const onAbort=()=>{controller.abort();interrupted(new ProgramMediaError('access_refused'));};
  const timer=setTimeout(()=>{controller.abort();interrupted(new ProgramMediaError('service_unavailable'));},timeout);
  request.signal.addEventListener('abort',onAbort,{once:true});
  const assertLive=()=>{if(controller.signal.aborted||request.signal.aborted||Date.now()>=deadline)throw new ProgramMediaError('service_unavailable');};
  async function execute(){
   assertLive();const source=await sourceForRequest(request,controller.signal);assertLive();
   if(!source||typeof source.execute!=='function')throw new ProgramMediaError('service_unavailable');
   let command:ProgramMediaControlCommand;
   try{
    const bytes=await readBoundedRequestBody({body:request.body,headers:request.headers,signal:controller.signal},MAX_BODY_BYTES,Math.min(5000,Math.max(1,deadline-Date.now())));
    command=programMediaControlCommand.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
   }catch(error){
    assertLive();if(error instanceof BoundedBodyError&&error.reason==='interrupted')throw new ProgramMediaError('access_refused');
    throw new ProgramMediaError('request_invalid');
   }
   assertLive();const answer=await source.execute(structuredClone(command),controller.signal);assertLive();
   const data=checkedReply(command,answer),body={contractVersion:PROGRAM_MEDIA_HTTP_CONTRACT,ok:true,data};
   if(Buffer.byteLength(JSON.stringify(body),'utf8')>MAX_REPLY_BYTES)throw new ProgramMediaError('service_unavailable');
   return json(200,body);
  }
  try{return await Promise.race([execute(),stopped]);}
  catch(error){return refuse(error instanceof ProgramMediaError&&PROGRAM_MEDIA_FAILURES.includes(error.code)?error.code:'service_unavailable');}
  finally{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);controller.abort();}
 };
}
