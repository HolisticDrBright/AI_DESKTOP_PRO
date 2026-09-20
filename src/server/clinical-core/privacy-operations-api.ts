import type {ApiGatewayV2Event,ApiGatewayV2Response} from './aws-identity-api';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {privacyOperationSchema} from '@/contracts/privacyOperations';
import {PrivacyOperationError,type createPrivacyOperations} from './privacy-operations';
export const PRIVACY_OPERATIONS_ROUTE='POST /clinical-core/workforce/privacy-operations';
export type PrivacyOperationsConfiguration={workforceIssuer:string;workforceAudience:string;phiAllowed:boolean;
  activation:'blocked'|'approved';evidenceSha256?:string;mfaReviewSha256?:string;
  personalPurgeEnabled?:boolean;personalPurgeEvidenceSha256?:string;externalInventoryEnabled?:boolean;externalInventoryEvidenceSha256?:string;
  externalPurgeEnabled?:boolean;externalPurgeEvidenceSha256?:string;identityDeletionEnabled?:boolean;identityDeletionEvidenceSha256?:string;
  exportCleanupEnabled?:boolean;exportCleanupEvidenceSha256?:string};
export function createPrivacyOperationsApi(input:{configuration:PrivacyOperationsConfiguration;
  operations:()=>ReturnType<typeof createPrivacyOperations>;now?:()=>number}){
  const c=input.configuration,hash=/^[a-f0-9]{64}$/;
  if(!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.workforceIssuer)
    ||!/^[a-zA-Z0-9]{20,128}$/.test(c.workforceAudience))throw new Error('privacy_api_configuration_invalid');
  const active=c.phiAllowed&&c.activation==='approved'&&hash.test(c.evidenceSha256??'')&&hash.test(c.mfaReviewSha256??'');
  if(c.phiAllowed&&!active)throw new Error('privacy_api_activation_invalid');
  const purgeActive=active&&c.personalPurgeEnabled===true&&hash.test(c.personalPurgeEvidenceSha256??'');
  if(c.personalPurgeEnabled&&!purgeActive)throw new Error('privacy_purge_activation_invalid');
  const inventoryActive=active&&c.externalInventoryEnabled===true&&hash.test(c.externalInventoryEvidenceSha256??'');
  if(c.externalInventoryEnabled&&!inventoryActive)throw new Error('privacy_inventory_activation_invalid');
  // Purging inventoried stores needs the inventory and its own reviewed evidence.
  const externalPurgeActive=inventoryActive&&c.externalPurgeEnabled===true&&hash.test(c.externalPurgeEvidenceSha256??'');
  if(c.externalPurgeEnabled&&!externalPurgeActive)throw new Error('privacy_external_purge_activation_invalid');
  const identityDeletionActive=active&&c.identityDeletionEnabled===true&&hash.test(c.identityDeletionEvidenceSha256??'');
  if(c.identityDeletionEnabled&&!identityDeletionActive)throw new Error('privacy_identity_deletion_activation_invalid');
  // Export retention needs the reviewed export bucket configuration (checked by the lambda) and its own evidence.
  const exportCleanupActive=active&&c.exportCleanupEnabled===true&&hash.test(c.exportCleanupEvidenceSha256??'');
  if(c.exportCleanupEnabled&&!exportCleanupActive)throw new Error('privacy_export_cleanup_activation_invalid');
  return async(event:ApiGatewayV2Event):Promise<ApiGatewayV2Response>=>{
    if(!active)return response(503,{error:'production_not_activated',phiAllowed:false});
    if(event.routeKey!==PRIVACY_OPERATIONS_ROUTE)return response(404,{error:'route_not_found'});
    try{
      const context=identity(event,c,input.now?.()??Date.now());
      const type=Object.entries(event.headers??{}).find(([k])=>k.toLowerCase()==='content-type')?.[1];
      if(Object.keys(event.queryStringParameters??{}).length||!type?.toLowerCase().startsWith('application/json')
        ||typeof event.body!=='string'||event.body.length>16000)throw new PrivacyOperationError('request_invalid');
      const bytes=Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8');
      if(bytes.length>10000)throw new PrivacyOperationError('request_invalid');
      let raw:unknown;try{raw=JSON.parse(bytes.toString('utf8'));}catch{throw new PrivacyOperationError('request_invalid');}
      const parsed=privacyOperationSchema.safeParse(raw);
      if(!parsed.success)throw new PrivacyOperationError('request_invalid');
      if(parsed.data.action==='externalInventory'&&!inventoryActive)return response(503,{error:'external_inventory_not_activated'});
      if((parsed.data.action==='previewPersonalPurge'||parsed.data.action==='purgePersonal')&&!purgeActive)
        return response(503,{error:'personal_purge_not_activated'});
      if(parsed.data.action==='purgeExternal'&&!externalPurgeActive)return response(503,{error:'external_purge_not_activated'});
      if(parsed.data.action==='purgeIdentity'&&!identityDeletionActive)return response(503,{error:'identity_deletion_not_activated'});
      if(parsed.data.action==='cleanupExports'&&!exportCleanupActive)return response(503,{error:'export_cleanup_not_activated'});
      return response(200,{data:await input.operations()(context,parsed.data)});
    }catch(error){
      const code=error instanceof PrivacyOperationError?error.code:'service_unavailable';
      return response(code==='reauth_required'?401:code==='privacy_access_refused'||code==='legal_hold'?403:
        code==='request_invalid'?400:code==='conflict'?409:503,{error:code});
    }
  };
}
// Only API Gateway verified claims are consumed. Workforce-pool MFA is a
// separately reviewed deployment prerequisite; auth_time enforces fresh login.
function identity(event:ApiGatewayV2Event,c:PrivacyOperationsConfiguration,now:number):ProductionClinicalRequestContext{
  const v=event.requestContext?.authorizer?.jwt?.claims??{},uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validTime=(n:unknown)=>typeof n==='number'||typeof n==='string'&&/^\d+$/.test(n);
  if(v.iss!==c.workforceIssuer||v.aud!==c.workforceAudience||v.token_use!=='id'
    ||v['custom:production_bound']!=='true'||![true,'true'].includes(v.email_verified as string|boolean)
    ||[true,'true'].includes(v['custom:synthetic_attested'] as string|boolean)
    ||typeof v.sub!=='string'||!/^[A-Za-z0-9:_-]{8,128}$/.test(v.sub)
    ||typeof v['custom:person_id']!=='string'||!uuid.test(v['custom:person_id'])
    ||typeof v['custom:organization_id']!=='string'||!uuid.test(v['custom:organization_id'])
    ||![v.exp,v.iat,v.auth_time].every(n=>validTime(n)&&Number.isSafeInteger(Number(n))&&Number(n)>0)
    ||Number(v.exp)*1000<=now||Number(v.iat)>=Number(v.exp)||Number(v.iat)*1000>now+60000
    ||Number(v.auth_time)>Number(v.iat)||now-Number(v.auth_time)*1000>15*60000)
    throw new PrivacyOperationError('reauth_required');
  return {actorPersonId:v['custom:person_id'],organizationId:v['custom:organization_id'],identitySubject:v.sub,
    identityPool:'workforce',purpose:'consent_management',environment:'production-clinical',
    dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
}
function response(statusCode:number,payload:unknown):ApiGatewayV2Response{
  return {statusCode,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'},body:JSON.stringify(payload)};
}
