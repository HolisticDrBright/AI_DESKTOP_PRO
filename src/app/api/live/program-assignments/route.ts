import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
import {programAssignmentRequest,parseProgramAssignmentResponse} from '@/contracts/programAssignments';
import {liveGuard} from '../route-helpers';
/**
 * Workforce side of the program assignment service. The practitioner's cookie
 * session is exchanged for the workforce JWT here, so the browser never holds it,
 * and only the workforce actions are reachable — a consumer action posted to this
 * route is refused before anything leaves the process.
 */
const json=(status:number,value:unknown)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
const WORKFORCE=new Set(['assign','status','release','connections','programs','preview']);
export async function POST(request:Request){
 const blocked=liveGuard();if(blocked)return blocked;
 if(!sameBrowserOrigin(request))return json(403,{error:'identity_refused'});
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 try{
  const body=programAssignmentRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request,262144,5000))));
  if(!WORKFORCE.has(body.action))return json(403,{error:'identity_refused'});
  const origin=new URL(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||origin.port
   ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname))return json(503,{error:'service_unavailable'});
  const response=await fetch(origin.origin+'/clinical-core/workforce/programs',{method:'POST',redirect:'error',cache:'no-store',
   signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},body:JSON.stringify(body)});
  // A refused assignment, an unpublished version or a re-pin conflict is the server
  // deciding, so the status is passed through and the panel can say which it was.
  if(!response.ok)return json([401,403,409,429].includes(response.status)?response.status:503,{error:'program_request_refused'});
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('invalid');
  const bytes=await readBoundedRequestBody({body:response.body,headers:response.headers,signal:request.signal},1000000,20000);
  return json(200,{data:parseProgramAssignmentResponse(body,JSON.parse(new TextDecoder().decode(bytes)).data)});
 }catch{return json(503,{error:'service_unavailable'});}
}
