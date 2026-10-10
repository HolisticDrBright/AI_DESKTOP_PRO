if(typeof window!=='undefined')throw Error('Fullscript target loader is server-only.');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {fullscriptQualificationTargetSchema,type FullscriptQualificationTarget,type FullscriptLambdaContext} from './qualification-api';

const bucket='alp-qualification-code-588966314750-us-east-2';
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const baseArn=z.string().regex(/^arn:aws:lambda:us-east-2:588966314750:function:[A-Za-z0-9_-]+$/);
// The artifact pins exact code, source, configuration and function NAME before
// publication. AWS's numeric invocation context supplies the version, which the
// existing observer independently verifies against actual code/env/API routes.
// This avoids putting a zip's digest inside that zip or guessing a version.
const targetPayload=z.object({...fullscriptQualificationTargetSchema.shape,functionArn:baseArn})
 .omit({reviewSha256:true}).strict();
export const fullscriptTargetReleaseSchema=z.object({contract:z.literal('fullscript-qualification-target-release/1'),
 target:targetPayload,
 review:z.object({reviewer:z.literal('Brandon Bright'),reviewedAt:z.string().datetime(),decision:z.literal('approved'),
  scope:z.literal('fictional-fullscript-api-target-only'),versionBinding:z.literal('observed-numeric-version-of-exact-reviewed-code')}).strict(),
}).strict();
export type FullscriptTargetBuild={sourceCommit:string;clean:boolean};
type Store={send(command:GetObjectCommand,options:{abortSignal:AbortSignal}):Promise<Record<string,unknown>>};
type Stream=AsyncIterable<Uint8Array>&{destroy?:()=>void};
const refuse=():never=>{throw Error('fullscript_target_release_refused');};
const requireTrue=(v:unknown)=>{if(!v)refuse();};
const destroyStream=(value:unknown)=>{try{
 if(value&&typeof (value as Stream).destroy==='function')(value as Stream).destroy!();
}catch{/* A broken stream cannot suppress refusal or deadline. */}};

/** Per-request immutable-version fetch; no successful-observation cache. Caller
 * request bodies cannot supply this configuration. Review metadata is a local
 * operator attestation, not a cryptographic signature or provider approval. */
export async function loadFullscriptQualificationTarget(input:{env:Record<string,string|undefined>;build:FullscriptTargetBuild;
 context:FullscriptLambdaContext;store:Store;timeoutMs?:number}):Promise<FullscriptQualificationTarget>{
 const env={...input.env},build={...input.build},context={...input.context};
 requireTrue(build.clean===true&&/^[a-f0-9]{40}$/.test(build.sourceCommit)
  &&env.AWS_REGION==='us-east-2'&&env.PHI_ALLOWED==='false'&&env.PRODUCTION_ACTIVATION==='blocked'
  &&env.QUALIFICATION_EXECUTION==='true'&&env.QUALIFICATION_ACCOUNT_ID==='588966314750'
  &&env.FULLSCRIPT_SOURCE_COMMIT===build.sourceCommit&&env.FULLSCRIPT_TARGET_BUCKET===bucket
  &&/^fullscript\/qualification-target\/[a-f0-9]{32}\/target\.json$/.test(env.FULLSCRIPT_TARGET_KEY??'')
  &&/^[A-Za-z0-9_.+/=-]{1,1024}$/.test(env.FULLSCRIPT_TARGET_VERSION??'')&&env.FULLSCRIPT_TARGET_VERSION!=='null'
  &&/^[a-f0-9]{64}$/.test(env.QUALIFICATION_REVIEW_SHA256??'')&&env.QUALIFICATION_REVIEW_SHA256!=='0'.repeat(64)
  &&/^[1-9][0-9]*$/.test(context.functionVersion)
  &&new RegExp('^arn:aws:lambda:us-east-2:588966314750:function:[A-Za-z0-9_-]+:'+context.functionVersion+'$').test(context.invokedFunctionArn));
 const maximum=65536,controller=new AbortController(),timeout=input.timeoutMs??5000;
 requireTrue(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=5000);
 let body:Stream|undefined;
 const stopBody=()=>destroyStream(body);
 const endsAt=Date.now()+timeout;
 let rejectDeadline:(e:Error)=>void=()=>{};
 const deadline=new Promise<never>((_resolve,reject)=>{rejectDeadline=reject;});
 const timer=setTimeout(()=>{controller.abort();rejectDeadline(Error('fullscript_target_release_refused'));stopBody();},timeout);
 try{
  const request=input.store.send(new GetObjectCommand({Bucket:bucket,Key:env.FULLSCRIPT_TARGET_KEY,
   VersionId:env.FULLSCRIPT_TARGET_VERSION,ExpectedBucketOwner:'588966314750'}),{abortSignal:controller.signal}).then(value=>{
    if(controller.signal.aborted){destroyStream(value.Body);return refuse();}return value;
   });
  const object=await Promise.race([request,deadline]);
  body=object.Body as Stream|undefined;
  requireTrue((object.$metadata as Record<string,unknown>|undefined)?.httpStatusCode===200
   &&object.VersionId===env.FULLSCRIPT_TARGET_VERSION&&object.DeleteMarker!==true&&object.ContentRange===undefined
   &&object.ContentType==='application/json'&&object.ContentEncoding===undefined
   &&object.ServerSideEncryption==='AES256'&&Number.isSafeInteger(object.ContentLength)
   &&Number(object.ContentLength)>0&&Number(object.ContentLength)<=maximum
   &&body&&typeof body[Symbol.asyncIterator]==='function');
  const chunks:Buffer[]=[],iterator=body![Symbol.asyncIterator]();let size=0;
  while(true){requireTrue(Date.now()<=endsAt);const next=await Promise.race([iterator.next(),deadline]);if(next.done)break;
   requireTrue(next.value instanceof Uint8Array&&next.value.byteLength>0);size+=next.value.byteLength;
   requireTrue(size<=maximum&&size<=Number(object.ContentLength));chunks.push(Buffer.from(next.value));}
  requireTrue(!controller.signal.aborted&&size===object.ContentLength);
  const bytes=Buffer.concat(chunks,size);requireTrue(sha(bytes)===env.QUALIFICATION_REVIEW_SHA256);
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return refuse();}
  requireTrue(Buffer.from(canonical(raw)+'\n').equals(bytes));
  const release=fullscriptTargetReleaseSchema.parse(raw);
  requireTrue(Date.parse(release.review.reviewedAt)<=Date.now()&&release.target.sourceCommit===build.sourceCommit
   &&context.invokedFunctionArn===release.target.functionArn+':'+context.functionVersion
   &&env.CLINICAL_DATABASE_NAME===release.target.databaseName&&env.CLINICAL_DATABASE_CLUSTER_ARN===release.target.clusterArn
   &&env.CLINICAL_DATABASE_SECRET_ARN===release.target.secretArn);
  requireTrue(Date.now()<=endsAt&&!controller.signal.aborted);
  return fullscriptQualificationTargetSchema.parse({...release.target,functionArn:context.invokedFunctionArn,
   reviewSha256:env.QUALIFICATION_REVIEW_SHA256});
 }catch{controller.abort();stopBody();return refuse();}
 finally{clearTimeout(timer);}
}

/** Native construction always pins the regional S3 origin and one attempt. */
export function nativeFullscriptTargetStore():Store{
 const client=new S3Client({region:'us-east-2',endpoint:'https://s3.us-east-2.amazonaws.com',maxAttempts:1,followRegionRedirects:false});
 return {send:async(command,options)=>({...await client.send(command,options)})};
}
