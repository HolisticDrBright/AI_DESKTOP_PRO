import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=b=>createHash('sha256').update(b).digest('hex');
const command=resolve('dist/aws-clinical-core/fullscript-deployment-preflight/index.cjs');
const nativeCommand=resolve('dist/aws-clinical-core/fullscript-deployment-operator/index.cjs');
let directory,args,target,parameters,manifest,nativeBuild;
before(()=>{
 for(const script of ['build-fullscript-api.mjs','build-fullscript-qualification-template.mjs','build-fullscript-deployment-preflight.mjs','build-fullscript-deployment-operator.mjs']){
  const result=execFileSync(process.execPath,['scripts/'+script],{encoding:'utf8',timeout:60000,windowsHide:true});
  if(script==='build-fullscript-deployment-operator.mjs')nativeBuild=JSON.parse(result);
 }
 manifest=JSON.parse(readFileSync('dist/aws-clinical-core/fullscript-api/artifact-manifest.json','utf8'));
 assert.equal(manifest.clean,true,'actual CLI acceptance requires clean committed source');
 assert.equal(nativeBuild.clean,true,'native refusals must not pass merely because the built source was dirty');
 assert.equal(nativeBuild.sourceCommit,manifest.sourceCommit);
 assert.equal(sha(readFileSync(nativeCommand)),nativeBuild.operatorSha256);
 const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
 // FICTIONAL review fixture only, never saved into AWS or treated as owner approval.
 target={contract:'fullscript-qualification-target-release/2',target:{execution:'qualification',account:'588966314750',region:'us-east-2',phiAllowed:false,
  activation:'blocked',sourceCommit:manifest.sourceCommit,apiId:'a123456789',functionArn:'arn:aws:lambda:us-east-2:588966314750:function:alp-fullscript-qualification-fictional',
  codeSha256:manifest.codeSha256,clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-db',
  databaseName:'clinical_core_qualification',organizationId:'11111111-1111-4111-8111-111111111111',consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',
  consumerAudience:'c'.repeat(26),workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce',workforceAudience:'w'.repeat(26),
  consumerSubjects:['FICTIONAL-consumer-one','FICTIONAL-consumer-two'],workforceSubjects:['FICTIONAL-workforce'],
  migrations:artifact.manifest.migrations.map(m=>({version:m.version,name:m.file.slice(15,-4),sha256:sha(Buffer.from(artifact.files[m.file]))}))},
  credentials:{providerSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-provider',providerSecretVersion:'f'.repeat(32),
   tokenTable:'fictional-tokens',redirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback'},
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-10-01T00:00:00.000Z',decision:'approved',scope:'fictional-fullscript-api-target-only',versionBinding:'observed-numeric-version-of-exact-reviewed-code'}};
 const template=JSON.parse(readFileSync('dist/aws-clinical-core/fullscript-api/template.json','utf8'));
 const p={...Object.fromEntries(Object.entries(template.Parameters).map(([k,v])=>[k,v.Default??''])),QualificationExecution:'true',
  FunctionName:target.target.functionArn.split(':').at(-1),ApiId:target.target.apiId,OrganizationId:target.target.organizationId,
  ConsumerAudience:target.target.consumerAudience,WorkforceAudience:target.target.workforceAudience,ConsumerPoolId:'us-east-2_FictionalConsumer',WorkforcePoolId:'us-east-2_FictionalWorkforce',
  CodeObjectVersion:'FICTIONAL-code-version',TargetKey:'fullscript/qualification-target/'+'1'.repeat(32)+'/target.json',TargetObjectVersion:'FICTIONAL-target-version',
  TargetReviewSha256:sha(Buffer.from(canonical(target)+'\n')),DatabaseClusterArn:target.target.clusterArn,DatabaseSecretArn:target.target.secretArn,
  ProviderSecretArn:target.credentials.providerSecretArn,ProviderSecretVersion:target.credentials.providerSecretVersion,TokenTableName:target.credentials.tokenTable,
  RedirectUri:target.credentials.redirectUri,AlarmTopicArn:'arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms'};
 parameters=Object.entries(p).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}));
 directory=mkdtempSync(join(tmpdir(),'alp-fictional-fullscript-preflight-'));
 writeFileSync(join(directory,'target.json'),canonical(target)+'\n');writeFileSync(join(directory,'parameters.json'),canonical(parameters)+'\n');
 args=['--inspect-fictional-fullscript-deployment-only',resolve('dist/aws-clinical-core/fullscript-api/artifact-manifest.json'),
  resolve('dist/aws-clinical-core/fullscript-api/function.zip'),resolve('dist/aws-clinical-core/fullscript-api/template.json'),join(directory,'target.json'),join(directory,'parameters.json')];
});
after(()=>{if(directory)rmSync(directory,{recursive:true,force:true});}); // exact mkdtemp directory owned only by this test
function run(values=args,cwd=process.cwd()){return spawnSync(process.execPath,[command,...values],{cwd,encoding:'utf8',timeout:15000,windowsHide:true,
 env:{...process.env,AWS_EC2_METADATA_DISABLED:'true',AWS_ACCESS_KEY_ID:'FICTIONAL-not-a-credential',AWS_SECRET_ACCESS_KEY:'FICTIONAL-not-a-credential'}});}
function refused(result){assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'fullscript_deployment_preflight_refused');}
test('actual clean built CLI reports consistency only without revealing target identifiers',()=>{
 const result=run();assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
 assert.equal(report.sourceCommit,manifest.sourceCommit);assert.equal(report.parameterCount,27);
 for(const key of ['awsObserved','approvedForDeployment','deployed','hostedQualified','phiAllowed'])assert.equal(report[key],false);
 assert.equal(report.ownerDeploymentReviewRequired,true);assert.ok(!result.stdout.includes('fictional-provider'));assert.equal(result.stderr,'');
});
test('actual clean CLI admits the exact112 release only with its distinct template and reviewed byte binding',()=>{
 const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-consent-copy-candidate.mjs','--json'],
  {encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
 execFileSync(process.execPath,['scripts/build-fullscript-qualification-template.mjs','--telehealth-consent-copy'],
  {encoding:'utf8',timeout:15000,windowsHide:true});
 const v=structuredClone(target);v.contract='fullscript-qualification-target-release/3';v.target.schemaRelease='telehealth-consent-copy/112';
 v.target.migrations=artifact.manifest.migrations.map(m=>({version:m.version,name:m.file.slice(15,-4),sha256:sha(Buffer.from(artifact.files[m.file]))}));
 const content=Buffer.from(canonical(v)+'\n'),rows=structuredClone(parameters);
 rows.find(r=>r.ParameterKey==='TargetReviewSha256').ParameterValue=sha(content);
 const targetPath=join(directory,'target-112.json'),parameterPath=join(directory,'parameters-112.json');
 writeFileSync(targetPath,content);writeFileSync(parameterPath,canonical(rows)+'\n');
 const values=[...args];values[3]=resolve('dist/aws-clinical-core/fullscript-api/template-consent-112.json');values[4]=targetPath;values[5]=parameterPath;
 const result=run(values);assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
 assert.equal(report.approvedForDeployment,false);assert.equal(report.awsObserved,false);assert.equal(report.phiAllowed,false);
 refused(run(values.map((v,i)=>i===3?args[3]:v)));
 const changed=structuredClone(v);changed.target.migrations.pop();writeFileSync(targetPath,canonical(changed)+'\n');
 rows.find(r=>r.ParameterKey==='TargetReviewSha256').ParameterValue=sha(Buffer.from(canonical(changed)+'\n'));
 writeFileSync(parameterPath,canonical(rows)+'\n');refused(run(values));
});
for(const [name,change] of [['wrong-command',a=>['--deploy',...a.slice(1)]],['extra-argument',a=>[...a,'--approve']],
 ['relative-path',a=>a.map((v,i)=>i===1?'artifact-manifest.json':v)],['missing-path',a=>a.map((v,i)=>i===4?join(directory,'missing.json'):v)]])
 test('actual CLI refuses '+name,()=>refused(run(change(args))));
test('actual CLI refuses a changed parameter and returns no field values',()=>{
 const changed=structuredClone(parameters);changed.find(r=>r.ParameterKey==='DatabaseName').ParameterValue='clinical_core';
 const path=join(directory,'changed-parameters.json');writeFileSync(path,canonical(changed)+'\n');refused(run([...args.slice(0,5),path]));
});
test('actual CLI refuses outside the checked source repository',()=>refused(run(args,directory)));
// These native-command cases deliberately stop before credentials or AWS.
// No valid owner deployment review is fabricated to exercise a live write.
function native(values,cwd=process.cwd()){
 return spawnSync(process.execPath,[nativeCommand,...values],{cwd,encoding:'utf8',timeout:15000,windowsHide:true});
}
function nativeRefused(result){assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'fullscript_deployment_command_refused');}
test('native artifact refuses absent explicit command and unknown modes before any cloud call',()=>{
 for(const values of [[],['--deploy'],['--fictional-fullscript-deployment-only','production',...args.slice(1),'missing-review.json']])nativeRefused(native(values));
});
test('native artifact refuses relative or missing review files before credentials',()=>{
 nativeRefused(native(['--fictional-fullscript-deployment-only','inspect',...args.slice(1),'relative-review.json']));
 nativeRefused(native(['--fictional-fullscript-deployment-only','deploy',...args.slice(1),join(directory,'missing-review.json')]));
});
test('native artifact refuses an invalid review in every mode, with no field values printed',()=>{
 const review=join(directory,'invalid-review.json');writeFileSync(review,'{"decision":"not-reviewed","private":"FICTIONAL"}\n');
 for(const mode of ['inspect','deploy','resume-unadmitted','execute-prepared','observe'])
  nativeRefused(native(['--fictional-fullscript-deployment-only',mode,...args.slice(1),review]));
});
