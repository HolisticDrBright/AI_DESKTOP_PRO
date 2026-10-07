import type {ApiGatewayV2Event,ApiGatewayV2Response} from './aws-identity-api';
import {careClaimRequest} from '@/contracts/careClaimRecovery';
import {ownedConsumerIdentity} from './owned-consumer-api';
import {OwnedStorageError} from './owned-consumer-records';
import {markQualificationResponse,qualificationAdmits} from './qualification-execution';
import {recordingWorkforceExecution} from './recording-authority-api';
import type {CareConnectionConfiguration} from './production-care-connections-api';
import {CareConnectionError} from './production-care-connections';
import type {createCareClaimRecovery} from './care-claim-recovery';

export const CARE_CLAIM_RECOVERY_ROUTE='POST /clinical-core/consumer/connection-claims';
export type CareClaimRecoveryConfiguration=CareConnectionConfiguration&{claimRecoveryReviewSha256?:string};
/** Consumer-only recovery boundary. Deployment opt-in and an independent review
 * are enforced by the artifact-bound handler; this API never approves either. */
export function createCareClaimRecoveryApi(input:{configuration:CareClaimRecoveryConfiguration;
  operations:()=>ReturnType<typeof createCareClaimRecovery>;now?:()=>number}){
  const c=structuredClone(input.configuration),execution=recordingWorkforceExecution(c),hash=/^[a-f0-9]{64}$/;
  const operations=input.operations,now=input.now??Date.now;
  if(!/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(c.consumerIssuer)
    ||!/^[A-Za-z0-9]{20,128}$/.test(c.consumerAudience)||c.consumerIssuer===c.workforceIssuer||c.consumerAudience===c.workforceAudience)
    throw new Error('care_claim_configuration_invalid');
  if(execution.serving&&(!hash.test(c.connectionReviewSha256??'')||!hash.test(c.mfaReviewSha256??'')||!hash.test(c.claimRecoveryReviewSha256??'')))
    throw new Error('care_claim_review_required');
  const handle=async(event:ApiGatewayV2Event):Promise<ApiGatewayV2Response>=>{
    if(!execution.serving)return reply(503,{error:'production_not_activated',phiAllowed:false});
    if(event.routeKey!==CARE_CLAIM_RECOVERY_ROUTE)return reply(404,{error:'route_not_found'});
    try{
      const media=Object.entries(event.headers??{}).find(([key])=>key.toLowerCase()==='content-type')?.[1];
      if(media?.split(';')[0]?.trim().toLowerCase()!=='application/json'||Object.keys(event.queryStringParameters??{}).length
        ||typeof event.body!=='string'||event.body.length>1400)throw new CareConnectionError('request_invalid');
      const bytes=Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8');
      if(!bytes.length||bytes.length>1024||event.isBase64Encoded&&bytes.toString('base64')!==event.body)throw new CareConnectionError('request_invalid');
      let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new CareConnectionError('request_invalid');}
      const parsed=careClaimRequest.safeParse(raw);if(!parsed.success)throw new CareConnectionError('request_invalid');
      const request=parsed.data,clock=now(),context=ownedConsumerIdentity(event,c,'identity_link',clock);
      if(context.organizationId!==c.organizationId)throw new CareConnectionError('identity_refused');
      if(!execution.active&&!qualificationAdmits(execution.qualification,context.identitySubject))return reply(503,{error:'production_not_activated',phiAllowed:false});
      if(request.action==='claim'){
        const claims=event.requestContext?.authorizer?.jwt?.claims??{},time=claims.auth_time;
        if(!(typeof time==='number'||typeof time==='string'&&/^\d+$/.test(time))||!Number.isSafeInteger(Number(time))
          ||Number(time)<=0||Number(time)>Number(claims.iat)||clock-Number(time)*1000>15*60000)
          return reply(401,{error:'reauth_required'});
      }
      return reply(200,{data:await operations()(context,request)});
    }catch(error){
      if(error instanceof OwnedStorageError)return reply(401,{error:'reauth_required'});
      const code=error instanceof CareConnectionError?error.category:'service_unavailable';
      return reply(code==='request_invalid'?400:code==='conflict'?409:['identity_refused','account_deletion_write_blocked'].includes(code)?403:503,{error:code});
    }
  };
  return async(event:ApiGatewayV2Event)=>markQualificationResponse(execution.qualification,await handle(event));
}
function reply(statusCode:number,value:unknown):ApiGatewayV2Response{
  return {statusCode,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'},body:JSON.stringify(value)};
}
