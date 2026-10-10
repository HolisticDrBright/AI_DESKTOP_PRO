if (typeof window !== 'undefined') throw Error('Fullscript deployment preflight is server-only.');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {fullscriptTargetReleaseSchema} from './qualification-target-loader';
import {fullscriptQualificationTemplate} from '../../../scripts/fullscript-qualification-template.mjs';

const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const digest=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const buildSchema=z.object({contract:z.literal('fullscript-api-build/1'),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
 clean:z.literal(true),handler:z.literal('index.handler'),runtime:z.literal('nodejs22.x'),indexSha256:hash,zipSha256:hash,
 codeSha256:z.string(),execution:z.literal('qualification_only'),phiAllowed:z.literal(false),activation:z.literal('blocked'),
 targetEmbedded:z.literal(false),immutableTargetVersionRequired:z.literal(true),targetReviewRequired:z.literal(true),
 publishedVersionRequired:z.literal(true),deployed:z.literal(false),hostedQualified:z.literal(false),providerActionPerformed:z.literal(false)}).strict();
const parameterSchema=z.array(z.object({ParameterKey:z.string().min(1).max(100),ParameterValue:z.string().max(4096)}).strict()).max(40);
function decode(bytes:Buffer,maximum:number,format:'canonical'|'pretty'):unknown {
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>maximum)throw Error('refused');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 const expected=Buffer.from((format==='canonical'?canonical(value):JSON.stringify(value,null,2))+'\n');
 if(!expected.equals(bytes))throw Error('refused'); // duplicate keys and altered encoding never disappear into parsing
 return value;
}
/** Offline consistency only. No approval, AWS observation, upload or deployment.
 * Every parameter is explicit: no UsePreviousValue or hidden stack default. A
 * successful report still requires independent IAM/resource/owner review. */
export function preflightFullscriptDeployment(input:{sourceCommit:string;clean:boolean;buildBytes:Buffer;zipBytes:Buffer;
 targetBytes:Buffer;templateBytes:Buffer;parameterBytes:Buffer;now?:number}){
 try {
  const source=input.sourceCommit,clean=input.clean,now=input.now??Date.now();
  if(!clean||!/^[a-f0-9]{40}$/.test(source)||!Number.isSafeInteger(now)||now<=0)throw Error('refused');
  const build=buildSchema.parse(decode(input.buildBytes,8192,'pretty'));
  if(build.sourceCommit!==source||!Buffer.isBuffer(input.zipBytes)||input.zipBytes.length===0||input.zipBytes.length>16*1024*1024
   ||digest(input.zipBytes)!==build.zipSha256||createHash('sha256').update(input.zipBytes).digest('base64')!==build.codeSha256)throw Error('refused');
  const template=fullscriptQualificationTemplate(build);
  if(!Buffer.from(JSON.stringify(template,null,2)+'\n').equals(input.templateBytes))throw Error('refused');
  const release=fullscriptTargetReleaseSchema.parse(decode(input.targetBytes,65536,'canonical'));
  const target=release.target,credentials=release.credentials;
  if(Date.parse(release.review.reviewedAt)>now||target.sourceCommit!==source||target.codeSha256!==build.codeSha256)throw Error('refused');
  const rows=parameterSchema.parse(decode(input.parameterBytes,65536,'canonical'));
  const parameters=Object.fromEntries(rows.map(row=>[row.ParameterKey,row.ParameterValue]));
  const definitions=template.Parameters as Record<string,{AllowedPattern?:string;AllowedValues?:string[]}>;
  if(rows.length!==Object.keys(parameters).length||rows.length!==Object.keys(definitions).length
   ||Object.keys(parameters).some(key=>!Object.hasOwn(definitions,key)))throw Error('refused');
  for(const [key,value] of Object.entries(parameters)){
   const definition=definitions[key];
   if(definition.AllowedPattern&&!new RegExp(definition.AllowedPattern).test(value)
    ||definition.AllowedValues&&!definition.AllowedValues.includes(value))throw Error('refused');
  }
  const expected={QualificationExecution:'true',PhiAllowed:'false',Activation:'blocked',SourceCommit:source,CodeSha256:build.codeSha256,
   FunctionName:target.functionArn.split(':').at(-1)!,ApiId:target.apiId,OrganizationId:target.organizationId,
   ConsumerPoolId:target.consumerIssuer.split('/').at(-1)!,WorkforcePoolId:target.workforceIssuer.split('/').at(-1)!,
   ConsumerAudience:target.consumerAudience,WorkforceAudience:target.workforceAudience,
   DatabaseName:target.databaseName,DatabaseClusterArn:target.clusterArn,DatabaseSecretArn:target.secretArn,
   TargetReviewSha256:digest(input.targetBytes),ProviderSecretArn:credentials.providerSecretArn,
   ProviderSecretVersion:credentials.providerSecretVersion,TokenTableName:credentials.tokenTable,RedirectUri:credentials.redirectUri};
  if(Object.entries(expected).some(([key,value])=>parameters[key]!==value)
   ||parameters.CodeObjectVersion==='null'||parameters.TargetObjectVersion==='null'
   ||parameters.ConsumerAudience===parameters.WorkforceAudience
   ||credentials.providerSecretArn===target.secretArn)throw Error('refused');
  return Object.freeze({contract:'fullscript-deployment-preflight/1',verdict:'locally_consistent',sourceCommit:source,
   zipSha256:build.zipSha256,templateSha256:digest(input.templateBytes),targetSha256:digest(input.targetBytes),
   parameterSha256:digest(input.parameterBytes),parameterCount:rows.length,awsObserved:false,ownerDeploymentReviewRequired:true,
   approvedForDeployment:false,deployed:false,hostedQualified:false,phiAllowed:false,activation:'blocked'} as const);
 }catch{throw Error('fullscript_deployment_preflight_refused');} // no target/credential/path values in errors
}
