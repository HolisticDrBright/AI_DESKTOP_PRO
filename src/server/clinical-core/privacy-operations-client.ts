import {privacyOperationSchema,parsePrivacyOperationResult,type PrivacyOperation} from '@/contracts/privacyOperations';
import {PrivacyOperationError} from './privacy-operations';
/** Server-only token forwarding to one reviewed AWS origin, never direct SQL. */
export async function requestPrivacyOperation(token:string|null,input:PrivacyOperation){
  if(typeof window!=='undefined')throw new Error('server_only');
  if(!token)throw new PrivacyOperationError('reauth_required');
  const parsed=privacyOperationSchema.safeParse(input);
  if(!parsed.success)throw new PrivacyOperationError('request_invalid');
  const raw=process.env.CLINICAL_AWS_PRIVACY_OPERATIONS_ORIGIN??'';
  let url:URL;
  try{url=new URL(raw);}catch{throw new PrivacyOperationError('service_unavailable');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port
    ||!/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname))
    throw new PrivacyOperationError('service_unavailable');
  try{
    const r=await fetch(url.origin+'/clinical-core/workforce/privacy-operations',{method:'POST',headers:{
      Authorization:'Bearer '+token,'content-type':'application/json',Accept:'application/json'},
      body:JSON.stringify(parsed.data),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!r.ok){
      // Only known, action/status-bound machine codes may cross this boundary.
      // Never relay arbitrary provider text, credentials or clinical values.
      let code:unknown;
      try{const text=await r.text();if(Buffer.byteLength(text)<=2000)code=JSON.parse(text)?.error;}catch{/* generic refusal below */}
      if(r.status===503&&code==='external_inventory_not_activated'&&parsed.data.action==='externalInventory')
        throw new PrivacyOperationError(code);
      if(r.status===503&&code==='personal_purge_not_activated'
        &&['previewPersonalPurge','purgePersonal'].includes(parsed.data.action))throw new PrivacyOperationError(code);
      if(r.status===403&&code==='legal_hold')throw new PrivacyOperationError(code);
      throw new PrivacyOperationError(r.status===401?'reauth_required':r.status===403?'privacy_access_refused':
        r.status===409?'conflict':r.status===400?'request_invalid':'service_unavailable');
    }
    const text=await r.text();
    if(Buffer.byteLength(text)>250000)throw new Error('oversize');
    const body=JSON.parse(text);
    return parsePrivacyOperationResult(parsed.data,body?.data);
  }catch(error){if(error instanceof PrivacyOperationError)throw error;throw new PrivacyOperationError('service_unavailable');}
}
