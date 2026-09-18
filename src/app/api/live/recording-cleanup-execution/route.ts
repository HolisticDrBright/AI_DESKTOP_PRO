import {liveGuard} from '../route-helpers';
import {getRequestSession} from '@/server/session';
import {recordingCleanupExecutionRequest} from '@/adapters/recording-cleanup-execution.server';
import {AdapterError,HTTP_STATUS} from '@/adapters/errors';
import {BoundedBodyError,readBoundedRequestBody} from '@/server/bounded-request-body';
import {cleanupExecutionRequestSchema} from '@/contracts/recordingCleanupExecution';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
export async function POST(request:Request){
  const blocked=liveGuard();if(blocked){blocked.headers.set('cache-control','no-store');return blocked;}
  try{
    const url=new URL(request.url);
    if(request.headers.get('origin')!==url.origin||request.headers.has('sec-fetch-site')&&request.headers.get('sec-fetch-site')!=='same-origin')throw new AdapterError('forbidden');
    const session=await getRequestSession();if(!session.signedIn||!session.token)throw new AdapterError('unauthenticated');
    if(url.search||request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new AdapterError('invalid');
    const bytes=await readBoundedRequestBody(request,2048,5000);let raw:unknown;
    try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AdapterError('invalid');}
    const parsed=cleanupExecutionRequestSchema.safeParse(raw);if(!parsed.success)throw new AdapterError('invalid');
    return Response.json(await recordingCleanupExecutionRequest(parsed.data,session.token,request.signal),{headers});
  }catch(error){
    const safe=error instanceof AdapterError?error:new AdapterError(error instanceof BoundedBodyError?'invalid':'unavailable');
    return Response.json({error:{code:safe.code}},{status:error instanceof BoundedBodyError&&error.reason==='too_large'?413:HTTP_STATUS[safe.code],headers});
  }
}
