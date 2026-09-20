import type {ApiGatewayV2Event,ApiGatewayV2Response} from './aws-identity-api';
import {recordingWorkforceActivation,recordingWorkforceIdentity,type RecordingAuthorityConfiguration} from './recording-authority-api';
import {RecordingAuthorityError} from './encounter-recording-operations';
import {RecordingCleanupError} from './recording-cleanup-authority';
import type {createRecordingCleanupQueue} from './recording-cleanup-queue';
import {cleanupReviewRequestSchema,cleanupWorkPageSchema,cleanupHistoryPageSchema,processingDeletionStatusSchema} from '@/contracts/recordingCleanupReview';
export const RECORDING_CLEANUP_REVIEW_ROUTE='POST /clinical-core/workforce/encounter-recording/cleanup-review';
export type CleanupReviewConfiguration=RecordingAuthorityConfiguration&{cleanupReviewSha256?:string};
const reply=(statusCode:number,value:unknown):ApiGatewayV2Response=>({statusCode,body:JSON.stringify(value),
  headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
/** Read interface only: the service type deliberately has no claim/finish/run,
 * storage or approval operation. A later dispatcher needs independent authority. */
export function createRecordingCleanupReviewApi(input:{configuration:CleanupReviewConfiguration;
  service:()=>Pick<ReturnType<typeof createRecordingCleanupQueue>,'list'|'history'|'processing'>;now?:()=>number}){
  const c=input.configuration,active=recordingWorkforceActivation(c)&&/^[a-f0-9]{64}$/.test(c.cleanupReviewSha256??'');
  if(c.phiAllowed&&!active)throw new Error('recording_cleanup_review_activation_invalid');
  return async(event:ApiGatewayV2Event):Promise<ApiGatewayV2Response>=>{
    if(!active)return reply(503,{error:'production_not_activated',phiAllowed:false});
    if(event.routeKey!==RECORDING_CLEANUP_REVIEW_ROUTE)return reply(404,{error:'route_not_found'});
    try{
      const context={...recordingWorkforceIdentity(event,c,input.now?.()??Date.now()),purpose:'consent_management' as const};
      const types=Object.entries(event.headers??{}).filter(([k])=>k.toLowerCase()==='content-type');
      if(types.length!==1||types[0][1]?.split(';')[0].trim().toLowerCase()!=='application/json'
        ||Object.keys(event.queryStringParameters??{}).length||Object.keys(event.headers??{}).some(k=>k.toLowerCase().startsWith('x-alp-'))
        ||typeof event.body!=='string'||event.body.length>4096)throw new RecordingCleanupError('request_invalid');
      const bytes=Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8');
      if(bytes.length>2048||event.isBase64Encoded&&bytes.toString('base64')!==event.body)throw new RecordingCleanupError('request_invalid');
      let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RecordingCleanupError('request_invalid');}
      const parsed=cleanupReviewRequestSchema.safeParse(raw);if(!parsed.success)throw new RecordingCleanupError('request_invalid');
      const request=parsed.data,service=input.service();let data:unknown;
      if(request.action==='queue')data=cleanupWorkPageSchema.parse(await service.list(context,request.after));
      else if(request.action==='processing'){
        const status=processingDeletionStatusSchema.parse(await service.processing(context,request.recordingId));
        if(status.recordingId!==request.recordingId)throw new RecordingCleanupError('service_unavailable');data=status;
      }else{
        const result=cleanupHistoryPageSchema.parse(await service.history(context,request.recordingId,request.after));
        if(result.recordingId!==request.recordingId)throw new RecordingCleanupError('service_unavailable');data=result;
      }
      return reply(200,{data,capabilities:{review:true,dispatch:false,storageDeletion:false}});
    }catch(error){
      const runtimeCode=error instanceof Error&&error.name==='RecordingCleanupError'&&'code' in error&&typeof error.code==='string'
        &&['request_invalid','access_refused','legal_hold','not_ready','service_unavailable'].includes(error.code)?error.code:'service_unavailable';
      const code=error instanceof RecordingAuthorityError?error.code:runtimeCode;
      return reply(code==='reauth_required'?401:code==='request_invalid'?400:code==='access_refused'?403:code==='not_ready'||code==='legal_hold'?409:503,{error:code});
    }
  };
}
