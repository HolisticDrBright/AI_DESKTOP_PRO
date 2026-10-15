import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {careMessageRequest,parseCareMessageResponse} from '@/contracts/careMessages';
import {liveGuard} from '../route-helpers';
import {CLINIC_MEMBERSHIP_REFUSAL,refusedUnderClinicMembership} from '@/server/clinic-authority-families';
import {currentMembershipCall,decidedInSelectedClinic} from '@/server/current-membership-route';
import {CLINIC_BINDING_HEADER} from '@/lib/clinic-binding-headers';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
const json=(status:number,value:unknown,binding:string|null=null)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store',...(binding?{[CLINIC_BINDING_HEADER]:binding}:{})}});
export async function POST(request:Request){
 const blocked=liveGuard();if(blocked)return blocked;
 if(!sameBrowserOrigin(request))return json(403,{error:'identity_refused'});
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 // Gated under clinic-membership sign-in: refused before the token leaves unless this deployment pairs the family with a
 // current-membership service (src/server/clinic-authority-families.ts). Then only the session's own clinic is sent.
 if(refusedUnderClinicMembership('care_messages'))return json(503,{error:CLINIC_MEMBERSHIP_REFUSAL});
 const clinic=await currentMembershipCall(session.token);if(!clinic.ok)return json(clinic.status,{error:clinic.error});
 try{
  const body=careMessageRequest.parse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request,20480,5000))));
  const origin=new URL(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||origin.port
   ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname))return json(503,{error:'service_unavailable'});
  const response=await fetch(origin.origin+'/clinical-core/workforce/messages',{method:'POST',redirect:'error',cache:'no-store',
   signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+session.token,'content-type':'application/json',...clinic.headers},body:JSON.stringify(body)});
  if(!response.ok)return json([401,403,409,429].includes(response.status)?response.status:503,{error:'message_request_refused'});
  // An answer that does not name the selected clinic was not decided by current membership in it.
  if(!decidedInSelectedClinic(response,clinic.organizationId))return json(503,{error:CLINIC_MEMBERSHIP_REFUSAL});
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('invalid');
  const bytes=await readBoundedRequestBody({body:response.body,headers:response.headers,signal:request.signal},1000000,20000);
  const data=parseCareMessageResponse(body,JSON.parse(new TextDecoder().decode(bytes)).data);
  if(data.action!==body.action)throw new Error('invalid');
  return json(200,{data},clinic.binding);
 }catch{return json(503,{error:'service_unavailable'});}
}
