import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {JOIN_REVIEW_REFUSALS,joinReviewRequest,parseJoinReviewResponse,type JoinReviewRequest} from '@/contracts/workforceJoinReview';
import {liveGuard} from '../../route-helpers';
import {CLINIC_MEMBERSHIP_REFUSAL,refusedUnderClinicMembership} from '@/server/clinic-authority-families';
import {currentMembershipCall,decidedInSelectedClinic} from '@/server/current-membership-route';
import {clinicalAuthorityMode} from '@/adapters/selected-clinic.server';
import {CLINIC_BINDING_HEADER} from '@/lib/clinic-binding-headers';
import {sameBrowserOrigin} from '@/server/same-browser-origin';

/**
 * A clinic administrator's join-request queue and decisions (workforce-join-review/1). Gated: it exists only under
 * clinic-membership sign-in, and even then refuses before the token leaves this process unless the deployment pairs
 * `workforce_join_review` with a current-membership service. The BLOCKED service and its SQL candidate are not deployed,
 * so today every request answers the clinic-membership refusal, and the card says so instead of showing an empty queue.
 *
 * The session's own clinic selection is the only clinic sent. The browser supplies a request or membership id, a reason
 * from a closed list and, to approve, the applicant's address; never a person, a role or a clinic. Bodies are bounded,
 * answers are no-store, and nothing about a request or an applicant is logged.
 */
const PATH={list:'/clinical-core/workforce/join-requests',approve:'/clinical-core/workforce/join-requests/decisions',
 reject:'/clinical-core/workforce/join-requests/decisions',revoke:'/clinical-core/workforce/memberships/revocations'} as const;
const PASSED=new Set([400,401,403,404,409,422,429]);
const json=(status:number,value:unknown,binding:string|null=null)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store',...(binding?{[CLINIC_BINDING_HEADER]:binding}:{})}});

async function call(request:Request,read:()=>Promise<JoinReviewRequest>,writes:boolean):Promise<NextResponse>{
 const blocked=liveGuard();if(blocked)return blocked;
 if(writes&&!sameBrowserOrigin(request))return json(403,{error:'identity_refused'});
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 // There is no claim-path review: a clinic decides who joins only from current membership rows.
 if(clinicalAuthorityMode()!=='database_current')return json(503,{error:CLINIC_MEMBERSHIP_REFUSAL});
 if(refusedUnderClinicMembership('workforce_join_review'))return json(503,{error:CLINIC_MEMBERSHIP_REFUSAL});
 const clinic=await currentMembershipCall(session.token);if(!clinic.ok)return json(clinic.status,{error:clinic.error});
 // The body is read only after the fence: a stale tab is refused as "clinic changed" whatever it sent.
 let body:JoinReviewRequest;
 try{body=await read();}catch{return json(400,{error:'request_invalid'});}
 try{
  const origin=new URL(process.env.WORKFORCE_JOIN_REVIEW_API_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||origin.port
   ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname))return json(503,{error:'service_unavailable'});
  const response=await fetch(origin.origin+PATH[body.action],{method:body.action==='list'?'GET':'POST',redirect:'error',cache:'no-store',
   signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+session.token,...(body.action==='list'?{}:{'content-type':'application/json'}),...clinic.headers},
   body:body.action==='list'?undefined:JSON.stringify(body)});
  const bytes=await readBoundedRequestBody({body:response.body,headers:response.headers,signal:request.signal},65536,15000);
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('invalid');
  const payload=JSON.parse(new TextDecoder().decode(bytes)) as {data?:unknown;error?:unknown};
  if(!response.ok){
   const code=typeof payload.error==='string'&&(JOIN_REVIEW_REFUSALS as readonly string[]).includes(payload.error)?payload.error:'service_unavailable';
   return json(PASSED.has(response.status)?response.status:503,{error:code});
  }
  // An answer that does not name the selected clinic was not decided by current membership in it.
  if(!decidedInSelectedClinic(response,clinic.organizationId))return json(503,{error:CLINIC_MEMBERSHIP_REFUSAL});
  return json(200,{data:parseJoinReviewResponse(body,payload.data)},clinic.binding);
 }catch{return json(503,{error:'service_unavailable'});}
}

export async function GET(request:Request){return call(request,async()=>({action:'list'}),false);}
export async function POST(request:Request){
 return call(request,async()=>{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||request.headers.has('content-encoding'))throw new Error('invalid');
  const parsed=joinReviewRequest.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedRequestBody(request,2048,5000))));
  if(parsed.action==='list')throw new Error('invalid');
  return parsed;
 },true);
}
