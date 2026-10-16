import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {applicantClientKey,forwardToApplicantApi} from '@/server/workforce-applicant-upstream';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
import {clinicalAuthorityMode} from '@/adapters/selected-clinic.server';
import {clinicChoices} from '@/server/clinic-choices';
import {sharedAbuseBoundary} from '@/server/public-abuse-boundary';
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

// The applicant API is reached only through src/server/workforce-applicant-upstream.ts (execute-api origin, bounded JSON).
async function forward(request:Request,token:string,method:'GET'|'POST',path:string,body?:unknown){
 const answer=await forwardToApplicantApi(request,token,{method,path,body,refusals:APPLICATION_REFUSALS});
 if(answer.ok)return {status:answer.status,payload:answer.payload};
 const pendingId=answer.error==='workforce_application_already_pending'&&typeof answer.payload.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(answer.payload.requestId)?{requestId:answer.payload.requestId.toLowerCase()}:{};
 return {status:answer.status,payload:{error:answer.error,...pendingId}};
}
const clientKey=applicantClientKey;

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
