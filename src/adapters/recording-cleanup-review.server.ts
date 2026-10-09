if(typeof window!=='undefined')throw new Error('Cleanup review is server-only');
import {AdapterError,codeFromHttpStatus} from './errors';
import {cleanupReviewRequestSchema,parseCleanupReviewResponse} from '@/contracts/recordingCleanupReview';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
export async function recordingCleanupReviewRequest(input:unknown,token:string|null,signal?:AbortSignal){
  if(!token)throw new AdapterError('unauthenticated');
  const parsed=cleanupReviewRequestSchema.safeParse(input);if(!parsed.success)throw new AdapterError('invalid');
  let origin:URL;try{origin=new URL(process.env.RECORDING_CLEANUP_REVIEW_API_ORIGIN??'');}catch{throw new AdapterError('unavailable');}
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||origin.port
    ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname))throw new AdapterError('unavailable');
  const controller=new AbortController(),requestSignal=controller.signal;
  let interrupt!:()=>void;
  const interrupted=new Promise<never>((_,reject)=>{interrupt=()=>{controller.abort();reject(new AdapterError('unavailable'));};});
  signal?.addEventListener('abort',interrupt,{once:true});
  const expiresAt=performance.now()+15000;
  const timer=setTimeout(interrupt,15000);
  const check=()=>{if(requestSignal.aborted||performance.now()>=expiresAt)throw new AdapterError('unavailable');};
  try{
    const operation=async()=>{
    check();
    const response=await fetch(origin.origin+'/clinical-core/workforce/encounter-recording/cleanup-review',{method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(parsed.data),
      cache:'no-store',redirect:'error',signal:requestSignal});
    if(requestSignal.aborted||performance.now()>=expiresAt){void response.body?.cancel().catch(()=>{});throw new AdapterError('unavailable');}
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw new AdapterError(response.status===409?'conflict':codeFromHttpStatus(response.status));}
    if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new AdapterError('unavailable');
    const headers=new Headers(response.headers);if(headers.has('content-encoding'))headers.delete('content-length');
    const bytes=await readBoundedRequestBody({body:response.body,headers,signal:requestSignal},128000,10000);
    check();
    return parseCleanupReviewResponse(parsed.data,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    };
    if(signal?.aborted)interrupt();
    return await Promise.race([operation(),interrupted]);
  }catch(error){if(error instanceof AdapterError)throw error;throw new AdapterError('unavailable');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',interrupt);}
}
