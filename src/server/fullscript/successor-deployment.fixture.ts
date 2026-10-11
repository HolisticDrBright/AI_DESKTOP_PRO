import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {SUCCESSOR_QUALIFICATION_RELEASE as release,successorQualificationReleaseArtifact} from '../../../scripts/successor-qualification-release.mjs';
import {successorFullscriptTemplate} from '../../../scripts/successor-fullscript-template.mjs';
import {careMessagingZip} from '../../../scripts/care-messaging-zip.mjs';
import {preflightSuccessorFullscriptDeployment,type SuccessorFullscriptPreflightInput} from './successor-deployment-preflight';
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const bytes=(v:unknown)=>Buffer.from(canonical(v)+'\n'),pretty=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');

// Local test data only. No real review, credentials or AWS calls.
export function createSuccessorDeploymentFixture(){
 const raw=execFileSync(process.execPath,['scripts/build-telehealth-transfer-authority-candidate.mjs','--json'],{
  encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,windowsHide:true});
 const artifact=successorQualificationReleaseArtifact(JSON.parse(raw));
 const source={sourceCommit:'a'.repeat(40),sourceClean:true,sourceInputSha256:'b'.repeat(64)};
 // Explicit fictional source and review. This is not an independently built
 // API artifact, actual target, owner approval or executable deployment input.
 const code=Buffer.from('module.exports.handler=()=>{throw Error("FICTIONAL fixture only")};\n'),zipBytes=careMessagingZip(code);
 const build={contract:'successor-fullscript-api-build/1',...source,...release,handler:'index.handler',runtime:'nodejs22.x',
  indexSha256:sha(code),zipSha256:sha(zipBytes),codeSha256:createHash('sha256').update(zipBytes).digest('base64'),zipBytes:zipBytes.length,
  execution:'qualification_only',phiAllowed:false,activation:'blocked',targetEmbedded:false,targetContract:'fullscript-qualification-target-release/4',
  immutableTargetVersionRequired:true,targetReviewRequired:true,publishedVersionRequired:true,credentialRole:'fullscript_draft_worker',
  deployed:false,hostedQualified:false,providerActionPerformed:false,completeFleetQualified:false,targetBindingComplete:false,sourceCandidateSha256:sha(Buffer.from(raw))};
 const {parent,template}=successorFullscriptTemplate(build),templateBytes=pretty(template);
 const manifest={...build,templateSha256:sha(templateBytes),parentTemplateSha256:sha(pretty(parent))};
 const target={contract:'fullscript-qualification-target-release/4',target:{
  execution:'qualification',account:'588966314750',region:'us-east-2',phiAllowed:false,activation:'blocked',
  sourceCommit:source.sourceCommit,sourceInputSha256:source.sourceInputSha256,schemaRelease:'clinical-successor-qualification/117',
  qualificationProfile:release.qualificationProfile,migrationReleaseSha256:release.migrationReleaseSha256,migrationAssemblySha256:release.migrationAssemblySha256,
  apiId:'a123456789',functionArn:'arn:aws:lambda:us-east-2:588966314750:function:alp-fullscript-successor-qualification-fictional',
  codeSha256:build.codeSha256,clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:FICTIONAL',
  secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/fullscript-worker-FICTIONAL',
  databaseName:'clinical_core_qualification',organizationId:'11111111-1111-4111-8111-111111111111',
  consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',consumerAudience:'c'.repeat(26),
  workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce',workforceAudience:'w'.repeat(26),
  consumerSubjects:['FICTIONAL-consumer-one','FICTIONAL-consumer-two'],workforceSubjects:['FICTIONAL-workforce'],migrations:artifact.rows},
  credentials:{providerSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:FICTIONAL-provider',
   providerSecretVersion:'f'.repeat(32),tokenTable:'FICTIONAL-tokens',redirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback'},
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-10-01T00:00:00.000Z',decision:'approved',scope:'fictional-fullscript-api-target-only',
   versionBinding:'observed-numeric-version-of-exact-reviewed-code'}};
 const definitions=template.Parameters as Record<string,{Default?:string}>;
 const parameters={...Object.fromEntries(Object.entries(definitions).map(([key,value])=>[key,value.Default??''])),
  QualificationExecution:'true',FunctionName:target.target.functionArn.split(':').at(-1)!,ApiId:target.target.apiId,
  ConsumerAudience:target.target.consumerAudience,WorkforceAudience:target.target.workforceAudience,
  ConsumerPoolId:'us-east-2_FictionalConsumer',WorkforcePoolId:'us-east-2_FictionalWorkforce',OrganizationId:target.target.organizationId,
  CodeObjectVersion:'FICTIONAL-code-version',TargetKey:'fullscript/qualification-target/'+'1'.repeat(32)+'/target.json',
  TargetObjectVersion:'FICTIONAL-target-version',TargetReviewSha256:sha(bytes(target)),
  DatabaseClusterArn:target.target.clusterArn,DatabaseSecretArn:target.target.secretArn,ProviderSecretArn:target.credentials.providerSecretArn,
  ProviderSecretVersion:target.credentials.providerSecretVersion,TokenTableName:target.credentials.tokenTable,RedirectUri:target.credentials.redirectUri,
  QualificationIdentitySubjects:[...target.target.consumerSubjects,...target.target.workforceSubjects].join(','),
  AlarmTopicArn:'arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms'};
 const input:SuccessorFullscriptPreflightInput={source,now:Date.parse('2026-10-11T16:00:00Z'),buildBytes:pretty(manifest),zipBytes,targetBytes:bytes(target),
  templateBytes,parameterBytes:bytes(Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})))}; 
 const p=preflightSuccessorFullscriptDeployment(input);
 const review={contract:'successor-fullscript-qualification-deployment-review/1',reviewer:'Brandon Bright',reviewedAt:'2026-10-11T15:59:00.000Z',decision:'approved',
  scope:'create-one-fictional-successor-fullscript-stack-only',sourceCommit:p.sourceCommit,sourceInputSha256:p.sourceInputSha256,
  qualificationProfile:release.qualificationProfile,migrationCount:p.migrationCount,migrationReleaseSha256:p.migrationReleaseSha256,migrationAssemblySha256:p.migrationAssemblySha256,
  zipSha256:p.zipSha256,templateSha256:p.templateSha256,targetSha256:p.targetSha256,parameterSha256:p.parameterSha256,
  stackName:'alp-fullscript-successor-qualification-fictional',runId:'1'.repeat(32),resourceReviewSha256:'2'.repeat(64),
  sqlPrivilegeReviewSha256:'3'.repeat(64),credentialReviewSha256:'4'.repeat(64),phiAllowed:false,activation:'blocked',providerActionsAllowed:false};
 return {...input,reviewBytes:bytes(review)};
}
