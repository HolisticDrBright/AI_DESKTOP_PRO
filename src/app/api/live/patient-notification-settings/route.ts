import {NextResponse} from 'next/server';
import {getRequestSession} from '@/server/session';
import {readBoundedRequestBody} from '@/server/bounded-request-body';
import {sameBrowserOrigin} from '@/server/same-browser-origin';
import {clinicNotificationSettingsRequest,clinicNotificationSettingsView} from '@/contracts/patientNotifications';
import {liveGuard} from '../route-helpers';
import {patientNotificationSwitches} from '@/server/notifications/notification-switches';
/**
 * The clinic's read-only view of a linked patient's reminder and notice choices.
 *
 * One request exists, `read`, and it names a connection and nothing else. There is no
 * request here, or upstream, that changes a choice: only the patient can turn texts on,
 * from the app, at a number and wording they agree to. The practitioner's cookie session
 * is exchanged for the workforce JWT here, so the browser never holds it.
 *
 * An answer the service could not give is 503, never an empty set of choices: "this
 * patient chose nothing" is a claim only a successful read can make.
 */
const json=(status:number,value:unknown)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request:Request){
 const blocked=liveGuard();if(blocked)return blocked;
 // Switched off, the route does not exist as far as a caller can tell, and nothing leaves the process.
 if(!patientNotificationSwitches(process.env).NOTIFICATION_PREFERENCES_ENABLED)return json(404,{error:'not_found'});
 if(!sameBrowserOrigin(request))return json(403,{error:'identity_refused'});
 const session=await getRequestSession();if(!session.token)return json(401,{error:'reauth_required'});
 try{
  const parsed=clinicNotificationSettingsRequest.safeParse(JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request,4096,5000))));
  if(!parsed.success)return json(400,{error:'request_invalid'});
  const origin=new URL(process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||origin.port
   ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(origin.hostname))return json(503,{error:'service_unavailable'});
  const response=await fetch(origin.origin+'/clinical-core/workforce/notifications/settings',{method:'POST',redirect:'error',cache:'no-store',
   signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},body:JSON.stringify(parsed.data)});
  // A refusal is the server deciding (not a member, not a verified link), so it passes through.
  if(response.status===401||response.status===403)return json(response.status,{error:'notification_settings_refused'});
  if(!response.ok)return json(503,{error:'service_unavailable'});
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('invalid');
  const bytes=await readBoundedRequestBody({body:response.body,headers:response.headers,signal:request.signal},65536,20000);
  const view=clinicNotificationSettingsView.parse(JSON.parse(new TextDecoder().decode(bytes)).data);
  // An answer about a different patient is not an answer about this one.
  if(view.connectionId!==parsed.data.connectionId)throw new Error('connection_mismatch');
  return json(200,{data:view});
 }catch{return json(503,{error:'service_unavailable'});}
}
