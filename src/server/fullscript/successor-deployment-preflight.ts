if(typeof window!=='undefined')throw Error('Fullscript successor preflight is server-only.');
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {SUCCESSOR_QUALIFICATION_RELEASE as release} from '../../../scripts/successor-qualification-release.mjs';
import {successorFullscriptTemplate} from '../../../scripts/successor-fullscript-template.mjs';
import {careMessagingZip} from '../../../scripts/care-messaging-zip.mjs';
import {fullscriptSuccessorTargetReleaseSchema} from './qualification-target-loader';

const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const hash=z.string().regex(/^(?!0{64}$)[a-f0-9]{64}$/);
const sourceSchema=z.object({sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),sourceClean:z.literal(true),sourceInputSha256:hash}).strict();
const buildSchema=sourceSchema.extend({
 contract:z.literal('successor-fullscript-api-build/1'),
 qualificationProfile:z.literal(release.qualificationProfile),migrationCount:z.literal(release.migrationCount),
 migrationReleaseSha256:z.literal(release.migrationReleaseSha256),migrationAssemblySha256:z.literal(release.migrationAssemblySha256),
 handler:z.literal('index.handler'),runtime:z.literal('nodejs22.x'),indexSha256:hash,zipSha256:hash,
 codeSha256:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),zipBytes:z.number().int().positive().max(16*1024*1024),
 execution:z.literal('qualification_only'),phiAllowed:z.literal(false),activation:z.literal('blocked'),
 targetEmbedded:z.literal(false),targetContract:z.literal('fullscript-qualification-target-release/4'),
 immutableTargetVersionRequired:z.literal(true),targetReviewRequired:z.literal(true),publishedVersionRequired:z.literal(true),
 credentialRole:z.literal('fullscript_draft_worker'),deployed:z.literal(false),hostedQualified:z.literal(false),
 providerActionPerformed:z.literal(false),completeFleetQualified:z.literal(false),targetBindingComplete:z.literal(false),
 sourceCandidateSha256:hash,templateSha256:hash,parentTemplateSha256:hash,
}).strict();
const parameterSchema=z.array(z.object({ParameterKey:z.string().min(1).max(100),ParameterValue:z.string().max(4096)}).strict()).max(40);
function decode(bytes:Buffer,maximum:number,format:'pretty'|'canonical'):unknown{
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>maximum)throw Error('refused');
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(!Buffer.from((format==='pretty'?JSON.stringify(value,null,2):canonical(value))+'\n').equals(bytes))throw Error('refused');
 return value;
}
export type SuccessorFullscriptPreflightInput={
 source:{sourceCommit:string;sourceClean:boolean;sourceInputSha256:string};buildBytes:Buffer;zipBytes:Buffer;
 targetBytes:Buffer;templateBytes:Buffer;parameterBytes:Buffer;now?:number;
};
/** Offline byte consistency only. Source must come from the command's current
 * observer; this function neither observes/rebuilds source nor admits a write.
 * Historical preflight and deployment/custody operators remain unchanged. */
export function preflightSuccessorFullscriptDeployment(input:SuccessorFullscriptPreflightInput){
 try{
  const source=sourceSchema.parse(input.source),now=input.now??Date.now();
  if(!Number.isSafeInteger(now)||now<=0)throw Error('refused');
  const build=buildSchema.parse(decode(input.buildBytes,8192,'pretty'));
  if(Object.entries(source).some(([key,value])=>build[key as keyof typeof build]!==value)
   ||!Buffer.isBuffer(input.zipBytes)||input.zipBytes.length!==build.zipBytes
   ||sha(input.zipBytes)!==build.zipSha256
   ||createHash('sha256').update(input.zipBytes).digest('base64')!==build.codeSha256)throw Error('refused');
  const zip=input.zipBytes;
  if(zip.length<100||zip.readUInt32LE(0)!==0x04034b50)throw Error('refused');
  const nameLength=zip.readUInt16LE(26),extraLength=zip.readUInt16LE(28),size=zip.readUInt32LE(18),offset=30+nameLength+extraLength;
  if(size===0||offset+size>zip.length||zip.subarray(30,30+nameLength).toString()!=='index.js')throw Error('refused');
  const code=zip.subarray(offset,offset+size);
  if(sha(code)!==build.indexSha256||!careMessagingZip(code).equals(zip))throw Error('refused');
  const {parent,template}=successorFullscriptTemplate(build);
  const templateBytes=Buffer.from(JSON.stringify(template,null,2)+'\n');
  if(!Buffer.isBuffer(input.templateBytes)||!templateBytes.equals(input.templateBytes)
   ||sha(templateBytes)!==build.templateSha256
   ||sha(Buffer.from(JSON.stringify(parent,null,2)+'\n'))!==build.parentTemplateSha256)throw Error('refused');
  const targetRelease=fullscriptSuccessorTargetReleaseSchema.parse(decode(input.targetBytes,65536,'canonical'));
  const target=targetRelease.target,credentials=targetRelease.credentials;
  if(Date.parse(targetRelease.review.reviewedAt)>now||target.sourceCommit!==source.sourceCommit
   ||target.sourceInputSha256!==source.sourceInputSha256||target.codeSha256!==build.codeSha256
   ||target.consumerSubjects.length+target.workforceSubjects.length>16)throw Error('refused');
  const rows=parameterSchema.parse(decode(input.parameterBytes,65536,'canonical'));
  const parameters=Object.fromEntries(rows.map(row=>[row.ParameterKey,row.ParameterValue]));
  const definitions=template.Parameters as Record<string,{AllowedPattern?:string;AllowedValues?:string[]}>;
  if(rows.length!==Object.keys(parameters).length||rows.length!==Object.keys(definitions).length
   ||Object.keys(parameters).some(key=>!Object.hasOwn(definitions,key)))throw Error('refused');
  for(const [key,value] of Object.entries(parameters)){
   const rule=definitions[key];
   if(rule.AllowedPattern&&!new RegExp(rule.AllowedPattern).test(value)
    ||rule.AllowedValues&&!rule.AllowedValues.includes(value))throw Error('refused');
  }
  const expected={
   QualificationExecution:'true',PhiAllowed:'false',Activation:'blocked',SourceCommit:source.sourceCommit,SourceClean:'true',
   SourceInputSha256:source.sourceInputSha256,SuccessorQualificationProfile:release.qualificationProfile,
   MigrationReleaseSha256:release.migrationReleaseSha256,MigrationAssemblySha256:release.migrationAssemblySha256,
   QualificationIdentitySubjects:[...target.consumerSubjects,...target.workforceSubjects].join(','),
   CodeSha256:build.codeSha256,FunctionName:target.functionArn.split(':').at(-1)!,ApiId:target.apiId,
   OrganizationId:target.organizationId,ConsumerPoolId:target.consumerIssuer.split('/').at(-1)!,
   WorkforcePoolId:target.workforceIssuer.split('/').at(-1)!,ConsumerAudience:target.consumerAudience,WorkforceAudience:target.workforceAudience,
   DatabaseName:target.databaseName,DatabaseClusterArn:target.clusterArn,DatabaseSecretArn:target.secretArn,
   TargetReviewSha256:sha(input.targetBytes),ProviderSecretArn:credentials.providerSecretArn,
   ProviderSecretVersion:credentials.providerSecretVersion,TokenTableName:credentials.tokenTable,RedirectUri:credentials.redirectUri,
  };
  if(Object.entries(expected).some(([key,value])=>parameters[key]!==value)
   ||parameters.CodeObjectVersion==='null'||parameters.TargetObjectVersion==='null')throw Error('refused');
  return Object.freeze({contract:'successor-fullscript-deployment-preflight/1',verdict:'locally_consistent',
   ...source,migrationCount:release.migrationCount,migrationReleaseSha256:release.migrationReleaseSha256,
   migrationAssemblySha256:release.migrationAssemblySha256,zipSha256:build.zipSha256,templateSha256:build.templateSha256,
   targetSha256:sha(input.targetBytes),parameterSha256:sha(input.parameterBytes),parameterCount:rows.length,
   awsObserved:false,sourceObserved:false,sourceRebuilt:false,ownerDeploymentReviewRequired:true,
   approvedForDeployment:false,deployed:false,hostedQualified:false,providerActionPerformed:false,
   completeFleetQualified:false,phiAllowed:false,activation:'blocked'} as const);
 }catch{throw Error('successor_fullscript_deployment_preflight_refused');}
}
