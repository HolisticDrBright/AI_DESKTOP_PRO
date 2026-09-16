import type {ApiGatewayV2Event,ApiGatewayV2Response} from './aws-identity-api';
import {ownedConsumerIdentity} from './owned-consumer-api';
import {OwnedStorageError,type createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedVoiceAuthorization,voiceOwner} from './owned-voice-authorization';
import {VoiceAuthorizationRevoked,type VoiceAuthorizationPolicy} from './voice-authorization';
import type {VoiceJobs} from './voice-jobs';
import {CoreSubscriptionError,requireConsumerCore} from './core-subscription-guard';

export type OwnedVoiceConfiguration={
  consumerIssuer:string;consumerAudience:string;phiAllowed:boolean;activationState:'blocked'|'approved';
  activationEvidenceSha256?:string;providerEvidenceSha256?:string;allowedScopes:readonly string[];
};
const ROOT='/clinical-core/consumer/chat-transcription/jobs';
export type OwnedVoiceEvent=ApiGatewayV2Event&{source?:string;rawPath?:string;requestContext?:ApiGatewayV2Event['requestContext']&{http?:{method?:string}}};
export function createOwnedVoiceApi(input:{
  configuration:OwnedVoiceConfiguration;
  adapter:()=>Pick<ReturnType<typeof createOwnedConsumerRecordsAdapter>,'consentState'>;
  service:(policy:VoiceAuthorizationPolicy)=>Pick<VoiceJobs,'start'|'status'|'cancel'|'sweep'>;
  now?:()=>number;
  requireCore?:(headers:Record<string,string|undefined>)=>Promise<void>;
}){
  const c=input.configuration;
  if(!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    ||!/^[a-zA-Z0-9]{20,128}$/.test(c.consumerAudience))throw new Error('owned_voice_configuration_invalid');
  const active=c.phiAllowed===true&&c.activationState==='approved'
    &&[c.activationEvidenceSha256,c.providerEvidenceSha256].every(v=>/^[a-f0-9]{64}$/.test(v??''));
  const featureEnabled=['ai_context','voice_transcription'].every(s=>c.allowedScopes.includes(s));
  if(c.phiAllowed&&!active)throw new Error('owned_voice_activation_invalid');
  const authorization=createOwnedVoiceAuthorization(input.adapter,input.now);
  const policy:VoiceAuthorizationPolicy={verify:job=>{
    if(!featureEnabled)throw new VoiceAuthorizationRevoked();
    return authorization.policy.verify(job);
  }};
  return async(event:OwnedVoiceEvent):Promise<ApiGatewayV2Response>=>{
    if(!active)return reply(503,{error:'production_not_activated',phiAllowed:false});
    if(event.source==='aws.events'&&!event.requestContext){
      try{await input.service(policy).sweep();return reply(200,{swept:true});}
      catch{throw new Error('owned_voice_sweep_retry_required');}
    }
    try{
      const method=event.requestContext?.http?.method;
      const path=event.rawPath??'';
      const id=path.startsWith(ROOT+'/')?path.slice(ROOT.length+1):undefined;
      if(!(method==='POST'&&path===ROOT)&&!(id&&/^[a-f0-9]{64}$/.test(id)&&['GET','DELETE'].includes(method??'')))return reply(404,{error:'voice_job_not_found'});
      const context=ownedConsumerIdentity(event,c,'consent_management',input.now?.()??Date.now());
      if(Object.keys(event.queryStringParameters??{}).length)throw invalid();
      // This DB call revalidates active identity, even on cancellation after withdrawal.
      await input.adapter().consentState(context,'voice_transcription');
      if(method==='POST'){
        if(!featureEnabled)return reply(403,{error:'feature_scope_not_enabled'});
        const body=parse(event);
        await (input.requireCore??requireConsumerCore)(event.headers??{});
        const captured=await authorization.capture(context);
        return reply(202,await input.service(policy).start(voiceOwner(context),body,captured));
      }
      if(event.body)throw invalid();
      const service=input.service(policy);
      return method==='DELETE'?reply(202,await service.cancel(voiceOwner(context),id!)):reply(200,await service.status(voiceOwner(context),id!));
    }catch(error){
      if(error instanceof CoreSubscriptionError)return reply(402,{error:'core_subscription_required'});
      if(error instanceof VoiceAuthorizationRevoked)return reply(403,{error:'voice_consent_required'});
      if(error instanceof OwnedStorageError){
        if(error.code==='owner_required')return reply(401,{error:'reauth_required'});
        if(error.code==='consent_required')return reply(403,{error:'voice_consent_required'});
      }
      const status=error&&typeof error==='object'&&'status' in error?Number(error.status):503;
      return reply([400,404].includes(status)?status:503,{error:status===404?'voice_job_not_found':status===400?'voice_request_refused':'chat_transcription_unavailable'});
    }
  };
}
function parse(event:ApiGatewayV2Event):Record<string,unknown>{
  const type=Object.entries(event.headers??{}).find(([k])=>k.toLowerCase()==='content-type')?.[1];
  if(!type?.toLowerCase().startsWith('application/json')||typeof event.body!=='string'||event.body.length>7_400_000)throw invalid();
  const raw=event.isBase64Encoded?Buffer.from(event.body,'base64'):Buffer.from(event.body);
  if(raw.length>5_600_000)throw invalid();
  try{const body=JSON.parse(raw.toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw invalid();return body;}catch{throw invalid();}
}
function invalid(){return Object.assign(new Error('voice_request_refused'),{status:400});}
function reply(statusCode:number,body:unknown):ApiGatewayV2Response{return {statusCode,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'},body:JSON.stringify(body)};}
