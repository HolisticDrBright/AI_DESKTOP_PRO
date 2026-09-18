import {z} from 'zod';
import type {ApiGatewayV2Event,ApiGatewayV2Response} from './aws-identity-api';
import {recordingWorkforceActivation,recordingWorkforceIdentity,type RecordingAuthorityConfiguration} from './recording-authority-api';
import {RecordingAuthorityError} from './encounter-recording-operations';
import {RecordingCleanupError} from './recording-cleanup-authority';
import type {createRecordingCleanupRunner} from './recording-cleanup-queue';
import {cleanupExecutionRequestSchema,cleanupExecutionReceiptSchema} from '@/contracts/recordingCleanupExecution';
export const RECORDING_CLEANUP_EXECUTION_ROUTE='POST /clinical-core/workforce/encounter-recording/cleanup-execution';
export type CleanupExecutionConfiguration=RecordingAuthorityConfiguration&{
  cleanupReleaseId?:string;workerSha256?:string;executionReviewSha256?:string;
  storageReviewSha256?:string;holdCoordinationReviewSha256?:string;
};
const reply=(statusCode:number,value:unknown):ApiGatewayV2Response=>({statusCode,body:JSON.stringify(value),
  headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
/** One manually authorized bounded pass. The runner's committed claim is the
 * durable handoff and duplicate fence, not a browser-owned promise. A missing
 * response requires reading history or retrying THE SAME requestId, never a
 * generated replacement. No background scheduler or hold mutation is exposed. */
export function createRecordingCleanupExecutionApi(input:{configuration:CleanupExecutionConfiguration;
  service:()=>ReturnType<typeof createRecordingCleanupRunner>;now?:()=>number}){
  const c=input.configuration,active=recordingWorkforceActivation(c)
    &&z.string().uuid().safeParse(c.cleanupReleaseId).success
    &&[c.workerSha256,c.executionReviewSha256,c.storageReviewSha256,c.holdCoordinationReviewSha256]
      .every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value));
  if(c.phiAllowed&&!active)throw new Error('recording_cleanup_execution_activation_invalid');
  return async(event:ApiGatewayV2Event):Promise<ApiGatewayV2Response>=>{
    if(!active)return reply(503,{error:'production_not_activated',phiAllowed:false});
    if(event.routeKey!==RECORDING_CLEANUP_EXECUTION_ROUTE)return reply(404,{error:'route_not_found'});
    try{
      const context={...recordingWorkforceIdentity(event,c,input.now?.()??Date.now()),purpose:'consent_management' as const};
      const types=Object.entries(event.headers??{}).filter(([k])=>k.toLowerCase()==='content-type');
      if(types.length!==1||types[0][1]?.split(';')[0].trim().toLowerCase()!=='application/json'
        ||Object.keys(event.queryStringParameters??{}).length||Object.keys(event.headers??{}).some(k=>k.toLowerCase().startsWith('x-alp-'))
        ||typeof event.body!=='string'||event.body.length>4096)throw new RecordingCleanupError('request_invalid');
      const bytes=Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8');
      if(bytes.length>2048||event.isBase64Encoded&&bytes.toString('base64')!==event.body)throw new RecordingCleanupError('request_invalid');
      let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RecordingCleanupError('request_invalid');}
      const parsed=cleanupExecutionRequestSchema.safeParse(raw);if(!parsed.success)throw new RecordingCleanupError('request_invalid');
      const request=parsed.data;
      const data=cleanupExecutionReceiptSchema.parse(await input.service()(context,{
        recordingId:request.recordingId,version:request.version,cleanupReleaseId:c.cleanupReleaseId!,workerSha256:c.workerSha256!,
      },request.requestId));
      if(data.recordingId!==request.recordingId||data.runId!==request.requestId)throw new RecordingCleanupError('service_unavailable');
      return reply(200,{data,capabilities:{boundedPass:true,scheduledDispatch:false,holdMutation:false,wholeRecordingErasure:false}});
    }catch(error){
      const runtimeCode=error instanceof Error&&error.name==='RecordingCleanupError'&&'code' in error&&typeof error.code==='string'
        &&['request_invalid','access_refused','legal_hold','not_ready','service_unavailable'].includes(error.code)?error.code:'service_unavailable';
      const code=error instanceof RecordingAuthorityError?error.code:runtimeCode;
      return reply(code==='reauth_required'?401:code==='request_invalid'?400:code==='access_refused'?403:code==='not_ready'||code==='legal_hold'?409:503,{error:code});
    }
  };
}
