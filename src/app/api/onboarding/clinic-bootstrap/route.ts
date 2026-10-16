import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
import {clinicalAuthorityMode} from '@/adapters/selected-clinic.server';
import {clinicChoices} from '@/server/clinic-choices';
import {sharedAbuseBoundary} from '@/server/public-abuse-boundary';
import {applicantClientKey,forwardToApplicantApi} from '@/server/workforce-applicant-upstream';
import {DESKTOP_CLINIC_BOOTSTRAP_RELEASE} from '@/server/clinic-bootstrap-release';
import {CLINIC_BOOTSTRAP_REFUSALS,clinicBootstrapAnswer,clinicBootstrapState,clinicBootstrapSubmission} from '@/contracts/workforceClinicBootstrap';

/**
 * The signed-in practitioner's own NEW clinic (workforce-clinic-bootstrap/1), through the BLOCKED applicant API.
 *
 * Held twice before anything is read: this Desktop's `DESKTOP_CLINIC_BOOTSTRAP_RELEASE` and the service's own release,
 * then the candidate's owner-only release row. While any is off the answer is `workforce_clinic_bootstrap_not_released`.
 *
 * The browser sends a request id (a retry key) and a clinic name, and nothing else: a clinic, person, role, subject,
 * address, assurance or flag in the body is a 400 and nothing is sent. The service takes the subject and address from
 * the current identity-provider account; no clinic is ever sent or read from the session (an independent family in
 * src/server/clinic-authority-families.ts). A lost reply is safe to resend: the same id answers the same clinic.
 */
const ROUTE='/clinical-core/workforce/clinic-bootstrap';
const json=(status:number,value:unknown)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
const notReleased=()=>json(503,{error:'workforce_clinic_bootstrap_not_released'});

export async function GET(request:Request){
 if(DESKTOP_CLINIC_BOOTSTRAP_RELEASE!=='qualification')return notReleased();
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 if(await sharedAbuseBoundary().decide('workforce_application_status',{client:applicantClientKey(request)})!=='admitted')return json(429,{error:'workforce_application_rate_limited'});
 try{
  const answer=await forwardToApplicantApi(request,session.token,{method:'GET',path:ROUTE,refusals:CLINIC_BOOTSTRAP_REFUSALS});
  if(!answer.ok)return json(answer.status,{error:answer.error});
  if(answer.status!==200)throw new Error('invalid');
  const state=answer.payload.data===null?null:clinicBootstrapState.parse(answer.payload.data);
  const clinicSignIn=clinicalAuthorityMode()==='database_current'?'current_membership':'legacy_claims';
  // Whether the new clinic is among this session's own clinics, read by subject only; unknown when it cannot be read.
  let inSession:boolean|null=null;
  if(state&&clinicSignIn==='current_membership'&&state.clinicalAccess==='available'){
   try{inSession=(await clinicChoices(session.token)).clinics.some(clinic=>clinic.organizationId===state.organizationId);}catch{inSession=null;}
  }
  return json(200,{data:{clinic:state,clinicSignIn,inSession}});
 }catch{return json(503,{error:'workforce_application_unavailable'});}
}

export async function POST(request:Request){
 if(DESKTOP_CLINIC_BOOTSTRAP_RELEASE!=='qualification')return notReleased();
 if(!sameBrowserOrigin(request))return json(403,{error:'identity_refused'});
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 let body:{requestId:string;clinicLabel:string};
 try{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||request.headers.has('content-encoding'))throw new Error('invalid');
  body=clinicBootstrapSubmission.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedRequestBody(request,1024,5000))));
 }catch{return json(400,{error:'request_invalid'});}
 if(await sharedAbuseBoundary().decide('workforce_application_submit',{client:applicantClientKey(request)})!=='admitted')return json(429,{error:'workforce_application_rate_limited'});
 try{
  const answer=await forwardToApplicantApi(request,session.token,{method:'POST',path:ROUTE,body,refusals:CLINIC_BOOTSTRAP_REFUSALS});
  if(!answer.ok)return json(answer.status,{error:answer.error});
  if(answer.status!==200&&answer.status!==201)throw new Error('invalid');
  const created=clinicBootstrapAnswer.parse(answer.payload.data);
  // An answer for another request is not this one's.
  if(created.requestId!==body.requestId)throw new Error('invalid');
  return json(created.duplicate?200:201,{data:created});
 }catch{return json(503,{error:'workforce_application_unavailable'});}
}
