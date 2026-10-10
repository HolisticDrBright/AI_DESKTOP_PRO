if (typeof window !== 'undefined') throw new Error('Fullscript qualification API is server-only.');
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {FULLSCRIPT_UPGRADE} from '../clinical-core/fullscript-migration-release';
import type {ApiGatewayV2Event,ApiGatewayV2Response} from '../clinical-core/aws-identity-api';
import {ownedConsumerIdentity} from '../clinical-core/owned-consumer-api';
import {recordingWorkforceIdentity} from '../clinical-core/recording-authority-api';
import type {DraftDeliveryActor} from './draft-delivery';
import type {RequestSession} from '../session';
import type {createCanonicalFullscriptDelivery} from './canonical-delivery-runtime';

const hash=z.string().regex(/^[a-f0-9]{64}$/).refine(v=>v!=='0'.repeat(64));
const uuid=z.string().uuid();
const issuer=z.string().regex(/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/);
const audience=z.string().regex(/^[A-Za-z0-9]{20,128}$/);
const subject=z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const ledger=z.array(z.object({version:z.string().regex(/^\d{14}$/),name:z.string().regex(/^[a-z0-9_]{1,200}$/),sha256:hash}).strict()).length(111)
 .refine(rows=>rows.every((row,i)=>i===0||row.version>rows[i-1].version))
 .refine(rows=>digest(rows.map(r=>`${r.version}:${r.sha256}`).join('\n'))===FULLSCRIPT_UPGRADE.successor111)
 .refine(rows=>digest(rows.map(r=>`${r.version}:${r.version}_${r.name}.sql:${r.sha256}`).join('\n'))===FULLSCRIPT_UPGRADE.successorArtifact);
export const fullscriptQualificationTargetSchema=z.object({
 execution:z.literal('qualification'),account:z.literal('588966314750'),region:z.literal('us-east-2'),
 phiAllowed:z.literal(false),activation:z.literal('blocked'),reviewSha256:hash,sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
 apiId:z.string().regex(/^[a-z0-9]{10}$/),functionArn:z.string().regex(/^arn:aws:lambda:us-east-2:588966314750:function:[A-Za-z0-9_-]+:[1-9][0-9]*$/),
 codeSha256:z.string().regex(/^[A-Za-z0-9+/]{43}=$/).refine(v=>Buffer.from(v,'base64').toString('base64')===v),
 clusterArn:z.string().regex(/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]+$/),
 secretArn:z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/),
 databaseName:z.literal('clinical_core_qualification'),organizationId:uuid,
 consumerIssuer:issuer,consumerAudience:audience,workforceIssuer:issuer,workforceAudience:audience,
 consumerSubjects:z.array(subject).min(2).max(10),workforceSubjects:z.array(subject).min(1).max(10),
 migrations:ledger,
}).strict().refine(c=>c.consumerIssuer!==c.workforceIssuer&&c.consumerAudience!==c.workforceAudience
 &&new Set([...c.consumerSubjects,...c.workforceSubjects]).size===c.consumerSubjects.length+c.workforceSubjects.length);
export type FullscriptQualificationTarget=z.infer<typeof fullscriptQualificationTargetSchema>;
export type FullscriptQualificationEvent=ApiGatewayV2Event&{requestContext?:NonNullable<ApiGatewayV2Event['requestContext']>&{apiId?:string;routeId?:string}};
export type FullscriptLambdaContext={invokedFunctionArn:string;functionVersion:string};
export type FullscriptRequestIdentity={actor:DraftDeliveryActor;session?:RequestSession;claims:Record<string,string|number|boolean|undefined>};
type Operations=ReturnType<typeof createCanonicalFullscriptDelivery>;
export const FULLSCRIPT_QUALIFICATION_ROUTES={
 workforce:'POST /clinical-core/workforce/fullscript/draft',consumer:'POST /clinical-core/consumer/fullscript/draft',
} as const;
const requestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('prepare'),manifestId:uuid,patientRecordId:uuid}).strict(),
 ...(['send','read','cancel','reconcile'] as const).map(action=>z.object({action:z.literal(action),id:uuid}).strict()),
 z.object({action:z.literal('export'),id:uuid,before:z.string().regex(/^[1-9][0-9]{0,18}$/).optional()}).strict(),
]);
class RequestRefused extends Error {constructor(readonly code:'request_invalid'|'reauth_required'|'fullscript_delivery_refused'){super(code);}}
export class FullscriptQualificationReauth extends Error {constructor(){super('reauth_required');}}
function body(event:FullscriptQualificationEvent){
 const contentType=Object.entries(event.headers??{}).find(([key])=>key.toLowerCase()==='content-type')?.[1];
 if(Object.keys(event.queryStringParameters??{}).length||contentType?.split(';')[0].trim().toLowerCase()!=='application/json'
  ||typeof event.body!=='string'||event.body.length>8192)throw new RequestRefused('request_invalid');
 const bytes=Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8');
 if(bytes.length===0||bytes.length>4096||event.isBase64Encoded&&bytes.toString('base64')!==event.body)throw new RequestRefused('request_invalid');
 try{return requestSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
 catch{throw new RequestRefused('request_invalid');}
}
function identity(event:FullscriptQualificationEvent,c:FullscriptQualificationTarget,workforce:boolean,now:number):FullscriptRequestIdentity{
 try{
  const context=workforce?recordingWorkforceIdentity(event,c,now):ownedConsumerIdentity(event,c,'clinical_data',now);
  const claims=event.requestContext?.authorizer?.jwt?.claims??{};
  // Even consumer reads require a fresh sign-in; refresh iat is not auth_time.
  const auth=claims.auth_time;
  if(!Number.isSafeInteger(Number(auth))||Number(auth)<=0||Number(auth)>Number(claims.iat)
   ||now-Number(auth)*1000>15*60000||typeof claims.email!=='string'||!z.string().email().safeParse(claims.email).success
   ||context.organizationId!==c.organizationId
   ||!(workforce?c.workforceSubjects:c.consumerSubjects).includes(context.identitySubject))throw new Error('refused');
  const actor:DraftDeliveryActor={organizationId:context.organizationId,personId:context.actorPersonId,
   identitySubject:context.identitySubject,identityPool:context.identityPool,environment:'synthetic-staging',phiAllowed:false};
  return {actor,claims,...(workforce?{session:{signedIn:true,email:claims.email,expired:false,
   expiresAt:Number(claims.exp)*1000,orgId:context.organizationId,token:null}}:{})};
 }catch{throw new RequestRefused('reauth_required');}
}
/** Internal composition seam. Production wiring MUST use the native observer;
 * no incoming request can provide an actor, review, target or provider. This
 * source candidate is not installed in the identity API or a deployed stack. */
export function createQualificationFullscriptApi(input:{target:unknown;
 observe:(event:FullscriptQualificationEvent,context:FullscriptLambdaContext,identity:FullscriptRequestIdentity)=>Promise<void>;
 operations:(identity:FullscriptRequestIdentity)=>Operations;now?:()=>number}){
 const c=fullscriptQualificationTargetSchema.parse(structuredClone(input.target));
 return async(event:FullscriptQualificationEvent,context:FullscriptLambdaContext):Promise<ApiGatewayV2Response>=>{
  const reply=(statusCode:number,value:unknown)=>({statusCode,headers:{'content-type':'application/json','cache-control':'no-store',
   'x-content-type-options':'nosniff','x-clinical-execution':'qualification'},body:JSON.stringify(value)});
  if(event.routeKey!==FULLSCRIPT_QUALIFICATION_ROUTES.workforce&&event.routeKey!==FULLSCRIPT_QUALIFICATION_ROUTES.consumer)
   return reply(404,{error:'route_not_found',phiAllowed:false});
  try{
   const workforce=event.routeKey===FULLSCRIPT_QUALIFICATION_ROUTES.workforce;
   const who=identity(event,c,workforce,input.now?.()??Date.now()),request=body(event);
   if(!workforce&&!['read','cancel','export'].includes(request.action))throw new RequestRefused('fullscript_delivery_refused');
   // Actual AWS target and current account/pool/user checks BEFORE constructing
   // the service, starting a ledger writer or loading OAuth credentials.
   await input.observe(event,context,who);
   const operations=input.operations(who);
   const data=request.action==='prepare'?await operations.prepare({manifestId:request.manifestId,patientRecordId:request.patientRecordId})
    :request.action==='export'?await operations.exportForOwner(request.id,request.before??null)
    :await operations[request.action](request.id);
   return reply(200,{data,phiAllowed:false,patientSent:false});
  }catch(error){
   const code=error instanceof RequestRefused?error.code:error instanceof FullscriptQualificationReauth?'reauth_required':'fullscript_delivery_refused';
   return reply(code==='request_invalid'?400:code==='reauth_required'?401:503,{error:code,phiAllowed:false});
  }
 };
}
