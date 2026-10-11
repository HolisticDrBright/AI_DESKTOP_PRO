import {beforeAll,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {SUCCESSOR_QUALIFICATION_RELEASE as release,successorQualificationReleaseArtifact} from '../../../scripts/successor-qualification-release.mjs';
import {successorFullscriptTemplate} from '../../../scripts/successor-fullscript-template.mjs';
import {careMessagingZip} from '../../../scripts/care-messaging-zip.mjs';
import {preflightFullscriptDeployment} from './qualification-deployment-preflight';
import {preflightSuccessorFullscriptDeployment,type SuccessorFullscriptPreflightInput} from './successor-deployment-preflight';
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const bytes=(v:unknown)=>Buffer.from(canonical(v)+'\n'),pretty=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
let fixture:SuccessorFullscriptPreflightInput;
beforeAll(()=>{
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
 fixture={source,now:Date.parse('2026-10-11T16:00:00Z'),buildBytes:pretty(manifest),zipBytes,targetBytes:bytes(target),
  templateBytes,parameterBytes:bytes(Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})))};
},60000);
it('successor binds exact 117 bytes and explicit parameters but grants no deployment or hosted authority',()=>{
 const result=preflightSuccessorFullscriptDeployment(fixture);
 expect(result).toMatchObject({...fixture.source,migrationCount:117,verdict:'locally_consistent',awsObserved:false,sourceRebuilt:false,
  sourceObserved:false,approvedForDeployment:false,deployed:false,hostedQualified:false,providerActionPerformed:false,phiAllowed:false});
 expect(JSON.stringify(result)).not.toContain('FICTIONAL-provider');
});
it('the historical deployment preflight still refuses the successor rather than widening old admission',()=>{
 expect(()=>preflightFullscriptDeployment({...fixture,sourceCommit:fixture.source.sourceCommit,clean:true})).toThrow('fullscript_deployment_preflight_refused');
});
it.each(['SourceInputSha256','SourceCommit','SourceClean','SuccessorQualificationProfile','MigrationReleaseSha256','MigrationAssemblySha256',
 'QualificationIdentitySubjects','FunctionName','ApiId','OrganizationId','ConsumerAudience','WorkforceAudience','DatabaseName',
 'DatabaseSecretArn','ProviderSecretArn','ProviderSecretVersion','CodeKey','CodeSha256','TargetReviewSha256','CodeObjectVersion','TargetObjectVersion'])
 ('refuses changed explicit %s',key=>{
  const rows=JSON.parse(fixture.parameterBytes.toString()) as {ParameterKey:string;ParameterValue:string}[];
  rows.find(row=>row.ParameterKey===key)!.ParameterValue=key.endsWith('ObjectVersion')?'null':'changed';
  expect(()=>preflightSuccessorFullscriptDeployment({...fixture,parameterBytes:bytes(rows)})).toThrow('successor_fullscript_deployment_preflight_refused');
 });
it.each(['dirty','wrong-commit','wrong-input','missing','extra'])('refuses unbound source %s',kind=>{
 const source={...fixture.source} as Record<string,unknown>;
 if(kind==='dirty')source.sourceClean=false;if(kind==='wrong-commit')source.sourceCommit='c'.repeat(40);
 if(kind==='wrong-input')source.sourceInputSha256='d'.repeat(64);if(kind==='missing')delete source.sourceInputSha256;if(kind==='extra')source.approved=true;
 expect(()=>preflightSuccessorFullscriptDeployment({...fixture,source:source as typeof fixture.source})).toThrow();
});
it.each(['target-drift','future-review','wrong-ledger','missing-review','duplicate-key','parameters-missing','parameters-extra','parameters-duplicate',
 'template-drift','build-extra','manifest-size','manifest-index','zip-trailing','zip-crc','old-target-contract'])
 ('refuses altered byte input %s',kind=>{
  const input={...fixture},target=JSON.parse(input.targetBytes.toString()),build=JSON.parse(input.buildBytes.toString());
  if(kind==='target-drift')target.target.sourceInputSha256='e'.repeat(64);
  if(kind==='future-review')target.review.reviewedAt='2030-01-01T00:00:00.000Z';
  if(kind==='wrong-ledger')target.target.migrations.pop();if(kind==='missing-review')delete target.review;
  if(kind==='old-target-contract')target.contract='fullscript-qualification-target-release/3';
  input.targetBytes=bytes(target);
  if(kind==='duplicate-key')input.targetBytes=Buffer.from(input.targetBytes.toString().replace('"account":','"account":"hidden","account":'));
  if(kind.startsWith('parameters-')){
   const rows=JSON.parse(input.parameterBytes.toString());
   if(kind==='parameters-missing')rows.pop();if(kind==='parameters-extra')rows.push({ParameterKey:'Unexpected',ParameterValue:'x'});
   if(kind==='parameters-duplicate')rows.push(rows[0]);input.parameterBytes=bytes(rows);
  }
  if(kind==='template-drift')input.templateBytes=Buffer.concat([input.templateBytes,Buffer.from(' ')]);
  if(kind==='build-extra')build.approved=true;if(kind==='manifest-size')build.zipBytes++;
  if(kind==='manifest-index')build.indexSha256='f'.repeat(64);
  if(kind==='zip-trailing'||kind==='zip-crc'){
   input.zipBytes=Buffer.from(input.zipBytes);
   if(kind==='zip-trailing')input.zipBytes=Buffer.concat([input.zipBytes,Buffer.from('extra')]);else input.zipBytes[14]^=1;
   build.zipBytes=input.zipBytes.length;build.zipSha256=sha(input.zipBytes);build.codeSha256=createHash('sha256').update(input.zipBytes).digest('base64');
  }
  input.buildBytes=pretty(build);
  expect(()=>preflightSuccessorFullscriptDeployment(input)).toThrow('successor_fullscript_deployment_preflight_refused');
 });
