import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
import {clinicalAuthorityMode} from '@/adapters/selected-clinic.server';
import {clinicChoices} from '@/server/clinic-choices';
import {abuseKey,sharedAbuseBoundary} from '@/server/public-abuse-boundary';
import {APPLICATION_REFUSALS,applicationSubmission,applicationWithdrawal,normalizeApplicationRows} from '@/contracts/workforceApplication';

/**
 * The signed-in practitioner's own application (workforce-application/1), through the BLOCKED applicant API. A clinic is
 * never sent and never read from the session here: an applicant has no clinic yet, and the applicant API decides from
 * the signed-in subject and its current Cognito account alone (src/server/clinic-authority-families.ts lists this as an
 * independent family).
 *
 * Without `WORKFORCE_APPLICATIONS_API_ORIGIN` there is no service to ask, so every answer is
 * `application_service_not_configured`, which the page shows as unavailable rather than as "no application". The
 * browser sends a request id (a retry key), a clinic code or a proposed clinic name, and nothing else; bodies are
 * bounded both ways, answers are no-store, and nothing about the applicant is logged.
 */
const ROUTE='/clinical-core/workforce/applications';
const json=(status:number,value:unknown)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
const PASSED=new Set([400,401,403,404,409,429]);

function upstreamOrigin():string|null{
 try{
  const origin=new URL(process.env.WORKFORCE_APPLICATIONS_API_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||origin.port
   ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname))return null;
  return origin.origin;
 }catch{return null;}
}
function clientKey(request:Request):string{
 const forwarded=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0,128)||'local';
 return abuseKey('client',forwarded);
}

async function forward(request:Request,token:string,method:'GET'|'POST',path:string,body?:unknown){
 const origin=upstreamOrigin();if(!origin)return {status:503,payload:{error:'application_service_not_configured'}};
 const response=await fetch(origin+path,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),
  headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const bytes=await readBoundedRequestBody({body:response.body,headers:response.headers,signal:request.signal},65536,15000);
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('invalid');
 const payload=JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;
 if(response.ok)return {status:response.status,payload};
 const code=typeof payload.error==='string'&&(APPLICATION_REFUSALS as readonly string[]).includes(payload.error)?payload.error:'workforce_application_unavailable';
 const pendingId=code==='workforce_application_already_pending'&&typeof payload.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(payload.requestId)?{requestId:payload.requestId.toLowerCase()}:{};
 return {status:PASSED.has(response.status)?response.status:503,payload:{error:code,...pendingId}};
}

export async function GET(request:Request){
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 if(await sharedAbuseBoundary().decide('workforce_application_status',{client:clientKey(request)})!=='admitted')return json(429,{error:'workforce_application_rate_limited'});
 try{
  const answer=await forward(request,session.token,'GET',ROUTE);
  if(answer.status!==200)return json(answer.status,answer.payload);
  const entries=normalizeApplicationRows(answer.payload.data);
  const clinicSignIn=clinicalAuthorityMode()==='database_current'?'current_membership':'legacy_claims';
  // The session's own clinics, read by subject only; when they cannot be read the page says so instead of guessing.
  let clinicIds:string[]|null=null;
  if(clinicSignIn==='current_membership'&&entries.some(entry=>entry.clinicalAccess==='available')){
   try{clinicIds=(await clinicChoices(session.token)).clinics.map(clinic=>clinic.organizationId).filter((id):id is string=>typeof id==='string');}catch{clinicIds=null;}
  }
  return json(200,{data:{entries,clinicSignIn,clinicIds}});
 }catch{return json(503,{error:'workforce_application_unavailable'});}
}

export async function POST(request:Request){
 if(!sameBrowserOrigin(request))return json(403,{error:'identity_refused'});
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 let action:'submit'|'withdraw',body:unknown;
 try{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||request.headers.has('content-encoding'))throw new Error('invalid');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedRequestBody(request,2048,5000))) as Record<string,unknown>;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid');
  const {action:requested,...rest}=value;
  if(requested==='submit'){action='submit';body=applicationSubmission.parse(rest);}
  else if(requested==='withdraw'){action='withdraw';body=applicationWithdrawal.parse(rest);}
  else throw new Error('invalid');
 }catch{return json(400,{error:'request_invalid'});}
 const surface=action==='submit'?'workforce_application_submit':'workforce_application_withdraw';
 if(await sharedAbuseBoundary().decide(surface,{client:clientKey(request)})!=='admitted')return json(429,{error:'workforce_application_rate_limited'});
 try{
  const answer=await forward(request,session.token,'POST',action==='submit'?ROUTE:`${ROUTE}/withdraw`,body);
  if(answer.status>=300)return json(answer.status,answer.payload);
  const data=answer.payload.data as Record<string,unknown>|undefined;
  if(action==='submit'){
   const requestId=(body as {requestId:string}).requestId;
   if(data?.requestId!==requestId||data?.status!=='pending')throw new Error('invalid');
   return json(202,{data:{requestId,status:'pending'}});
  }
  if(data?.withdrawn!==true)throw new Error('invalid');
  return json(200,{data:{withdrawn:true,duplicate:data.duplicate===true}});
 }catch{return json(503,{error:'workforce_application_unavailable'});}
}
