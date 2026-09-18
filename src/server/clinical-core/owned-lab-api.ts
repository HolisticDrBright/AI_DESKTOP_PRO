import type {ApiGatewayV2Event,ApiGatewayV2Response} from './aws-identity-api';
import {ownedConsumerIdentity} from './owned-consumer-api';
import {OwnedStorageError,type createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedLabAuthorization,LabAuthorizationRevoked,LAB_AUTHORIZATION_SCOPES} from './owned-lab-authorization';
import {createLabAnalysisApi,type ApiEvent,type Claims,type LabApiOptions} from './aws-lab-analysis-api';
import {CoreSubscriptionError,requireConsumerCore} from './core-subscription-guard';
import type {ExternalDeletionGuard} from './owned-external-deletion';
import {publishLabResult,retractLabPublication} from './owned-lab-publication';

/** Independent production lab/document processing candidate. Mirrors the owned
 * voice candidate: verified production consumer identity, separate ai_context
 * and lab_history consent bound to every job, paid Core at creation, ownership
 * re-verified before upload, dispatch and read. Default blocked; no clinic
 * connection is required or inferred. */
export type OwnedLabConfiguration={
  consumerIssuer:string;consumerAudience:string;phiAllowed:boolean;activationState:'blocked'|'approved';
  activationEvidenceSha256?:string;providerEvidenceSha256?:string;allowedScopes:readonly string[];
};
const ROOT='/clinical-core/consumer/labs';
export type OwnedLabEvent=ApiGatewayV2Event&ApiEvent&{rawPath?:string;requestContext?:ApiGatewayV2Event['requestContext']&{http?:{method?:string}}};
type Handler=(event:ApiEvent)=>Promise<{statusCode:number;headers:Record<string,string>;body:string}>;
export function createOwnedLabApi(input:{
  configuration:OwnedLabConfiguration;
  adapter:()=>Pick<ReturnType<typeof createOwnedConsumerRecordsAdapter>,'consentState'|'processingConsentStates'>&Partial<Pick<ReturnType<typeof createOwnedConsumerRecordsAdapter>,'write'|'get'>>;
  now?:()=>number;
  deletionGuard?:ExternalDeletionGuard;
  requireCore?:(headers:Record<string,string|undefined>)=>Promise<void>;
  /** Test seam: the mode-aware lab API factory. Production code uses the real one. */
  api?:(options:LabApiOptions)=>Handler;
}){
  const c=input.configuration;
  if(!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    ||!/^[a-zA-Z0-9]{20,128}$/.test(c.consumerAudience))throw new Error('owned_lab_configuration_invalid');
  const active=c.phiAllowed===true&&c.activationState==='approved'
    &&[c.activationEvidenceSha256,c.providerEvidenceSha256].every(v=>/^[a-f0-9]{64}$/.test(v??''));
  if(c.phiAllowed&&!active)throw new Error('owned_lab_activation_invalid');
  const featureEnabled=LAB_AUTHORIZATION_SCOPES.every(s=>c.allowedScopes.includes(s));
  const now=input.now??(()=>Date.now());
  const authorization=createOwnedLabAuthorization(input.adapter,now);
  const identity=(event:ApiEvent):Claims=>{
    const context=ownedConsumerIdentity(event as ApiGatewayV2Event,c,'clinical_data',now());
    return {sub:context.identitySubject,'custom:person_id':context.actorPersonId,'custom:organization_id':context.organizationId};
  };
  const inner=(input.api??createLabAnalysisApi)({
    mode:'production',identity,deletionGuard:input.deletionGuard,
    revalidatePrivacyIdentity:async event=>{
      const context=ownedConsumerIdentity(event as ApiGatewayV2Event,c,'consent_management',now());
      // Fetching consent state checks the active DB identity, not a grant.
      await input.adapter().consentState(context,'lab_history');
    },
    capture:async event=>{
      if(!active||!featureEnabled)throw new LabAuthorizationRevoked();
      return authorization.capture(ownedConsumerIdentity(event as ApiGatewayV2Event,c,'consent_management',now()));
    },
    policy:{verify:job=>{if(!active||!featureEnabled)throw new LabAuthorizationRevoked();return authorization.policy.verify(job);}},
    publish:async job=>{
      if(!active||!featureEnabled)throw new LabAuthorizationRevoked();
      // Publication re-verifies the job's consent binding before the personal copy is written.
      await authorization.policy.verify(job);
      return publishLabResult({job,now,adapter:()=>{
        const a=input.adapter();
        if(typeof a.write!=='function'||typeof a.get!=='function')throw new OwnedStorageError('storage_unavailable');
        return a as Required<Pick<typeof a,'write'|'get'>>;
      }});
    },
    retract:async job=>{
      if(!active||!featureEnabled)throw new LabAuthorizationRevoked();
      // Deletion does not re-verify the job's consent binding: a withdrawn
      // consent must not stop the owner removing old work. The tombstone write
      // itself binds the revision and reports a retained copy when refused.
      return retractLabPublication({job,now,adapter:()=>{
        const a=input.adapter();
        if(typeof a.write!=='function'||typeof a.get!=='function')throw new OwnedStorageError('storage_unavailable');
        return a as Required<Pick<typeof a,'write'|'get'>>;
      }});
    },
    requireCore:input.requireCore??requireConsumerCore,
  });
  return async(event:OwnedLabEvent):Promise<ApiGatewayV2Response>=>{
    if(!active)return reply(503,{error:'production_not_activated',phiAllowed:false});
    try{
      const path=event.rawPath??'';
      if(path!==ROOT&&!path.startsWith(ROOT+'/'))return reply(404,{error:'lab_analysis_request_refused'});
      const context=ownedConsumerIdentity(event,c,'clinical_data',now());
      if(!featureEnabled)return reply(403,{error:'feature_scope_not_enabled'});
      // This DB call revalidates the active database identity before any job
      // row is read, even for inventory listing and cancellation.
      await input.adapter().consentState({...context,purpose:'consent_management'},'lab_history');
      const response=await inner(event);
      return {statusCode:response.statusCode,headers:{...response.headers,'x-content-type-options':'nosniff'},body:response.body};
    }catch(error){
      if(error instanceof CoreSubscriptionError)return reply(402,{error:'core_subscription_required'});
      if(error instanceof LabAuthorizationRevoked)return reply(403,{error:error.reason});
      if(error instanceof OwnedStorageError){
        if(error.code==='account_deletion_write_blocked')return reply(403,{error:error.code});
        if(error.code==='owner_required')return reply(401,{error:'reauth_required'});
        if(error.code==='consent_required')return reply(403,{error:'lab_consent_required'});
      }
      return reply(503,{error:'lab_analysis_unavailable'});
    }
  };
}
function reply(statusCode:number,data:unknown):ApiGatewayV2Response{
  return {statusCode,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'},body:JSON.stringify({data})};
}
