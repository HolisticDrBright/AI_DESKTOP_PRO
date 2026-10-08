import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from './care-recovery-routing.mjs';
import {careControlSource as source,careControlObservation} from './test-fixtures/care-control.mjs';
import {careIntentContinuationFixture} from './test-fixtures/care-intent-continuation.mjs';
import {verifyCancellationControlPlane} from './verify-synthetic-care-cancellation.mjs';
import {verifyIntentLiveControl,verifyIntentCodeLocation,intentPolicyAbsent} from './care-intent-live.mjs';
import {executeIntentChange,intentReleaseArgs,verifyIntentReleasePort} from './release-synthetic-care-intent.mjs';
const clone=structuredClone;
test('only exact qualified policy absence is admitted with either observed AWS CLI error format',()=>{
 const args=['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'];
 const missing='An error occurred (ResourceNotFoundException) when calling the GetPolicy operation: The resource you requested does not exist.';
 for(const stderr of [missing,'aws: [ERROR]: '+missing+'\n\nAdditional error details:\nType: User\n']){
  assert.equal(intentPolicyAbsent(args,'2',{stderr:Buffer.from(stderr)}),true);
  for(const other of [undefined,'1','3','$LATEST'])assert.equal(intentPolicyAbsent(args,other,{stderr}),false);
 }
 for(const stderr of [missing.replace('ResourceNotFoundException','AccessDeniedException'),
  missing.replace('GetPolicy','GetFunction'),'transport failure','prefix '+missing,''])
  assert.equal(intentPolicyAbsent(args,'2',{stderr}),false);
 for(const other of [['lambda','get-policy','--function-name','other','--qualifier','2'],
  args.slice(0,-2),[...args,'--other'],['lambda','get-function','--function-name',P.functionName,'--qualifier','2']])
  assert.equal(intentPolicyAbsent(other,'2',{stderr:missing}),false);
});
test('single-attempt GetPolicy absence admits only the exact zero-retry header',()=>{
 const args=['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'];
 const missing='An error occurred (ResourceNotFoundException) when calling the GetPolicy operation (reached max retries: 0): The resource you requested does not exist.';
 for(const prefix of ['','aws: [ERROR]: ']){
  assert.equal(intentPolicyAbsent(args,'2',{stderr:prefix+missing}),true);
  assert.equal(intentPolicyAbsent(args,'2',{stderr:Buffer.from(prefix+missing)}),true);
 }
 for(const stderr of [missing.replace('ResourceNotFoundException','AccessDeniedException'),
  missing.replace('GetPolicy','GetFunction'),missing.replace('retries: 0','retries: 1'),
  missing.replace('retries: 0','retries: -1'),missing.replace('retries: 0','retries: 00'),
  missing.replace(' (reached max retries: 0)',' (unknown qualifier)'),
  'prefix '+missing,missing+'x'.repeat(65536),{},null])
  assert.equal(intentPolicyAbsent(args,'2',{stderr}),false);
 for(const version of [undefined,'1','3','$LATEST'])assert.equal(intentPolicyAbsent(args,version,{stderr:missing}),false);
 assert.equal(intentPolicyAbsent(args.slice(0,-2),'2',{stderr:missing}),false);
});
function fixture(){
 const s=careIntentContinuationFixture().supplied,old=careControlObservation(),control=verifyCancellationControlPlane(old,source);
 const input={template:clone(old.template)},before={binding:{stackId:old.stack.Stacks[0].StackId,id:'fictional-change-set'},
  live:{fn:clone(old.fn)},summary:{Parameters:clone(old.stack.Stacks[0].Parameters)}};
 before.summary.Parameters.find(x=>x.ParameterKey==='LambdaCodeKey').ParameterValue=s.candidate.manifest.key;
 input.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=s.artifact.versionId;
 const actual=clone(old);actual.template=clone(input.template);actual.stack.Stacks[0].StackName=P.stack;
 actual.stack.Stacks[0].Parameters=clone(before.summary.Parameters);
 actual.fn.RevisionId='successor-revision';actual.fn.CodeSize=s.candidate.zip.length;
 actual.fn.CodeSha256=Buffer.from(s.candidate.manifest.zipSha256,'hex').toString('base64');
 return {s,actual,input,before,preparation:{control}};
}
const verify=f=>verifyIntentLiveControl(f.actual,source,f.input,f.s.candidate,f.before,f.preparation);
test('live code profile admits only separately checked code-pointer differences and preserves original authority gates',()=>{
 const f=fixture(),copy=clone(f.actual),proof=verify(f);
 assert.equal(proof.templateSha256,sha256(canonical(f.actual.template)));assert.equal(proof.phiAllowed,false);
 assert.deepEqual(f.actual,copy);assert.throws(()=>verifyCancellationControlPlane(f.actual,source));
 for(const mutation of [o=>o.fn.CodeSize++,o=>o.fn.CodeSha256='wrong',o=>o.fn.RevisionId='fictional-revision',
  o=>o.fn.Environment.Variables.PHI_ALLOWED='true',o=>o.fn.Role='wrong',o=>o.fn.MemorySize=512,o=>o.fn.Layers=[{Arn:'other'}],
  o=>o.template.Resources.IdentityApiFunction.Properties.Timeout=30,o=>o.fn.RuntimeVersionConfig={RuntimeVersionArn:'other'},
  o=>o.stack.Stacks[0].Parameters.push(clone(o.stack.Stacks[0].Parameters[0])),o=>o.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',
  o=>o.routes.Items[0].AuthorizationType='NONE',o=>o.integrations.Items.push({IntegrationId:'unknown'}),
  o=>o.latestPolicy.Policy='{}',o=>o.logGroups.logGroups[0].retentionInDays=0,
  o=>o.foundation.Stacks[0].Outputs.find(v=>v.OutputKey==='PhiAllowed').OutputValue='true']){
  const value=fixture();mutation(value.actual);assert.throws(()=>verify(value));}
});
test('retained control profile independently pins the exact URI before normalization; version 1 and unrelated routes refuse',()=>{
 const f=fixture();f.actual.integrations.Items[0].IntegrationUri=R.latestArn+':2';
 assert.equal(verifyIntentLiveControl(f.actual,source,f.input,f.s.candidate,f.before,f.preparation,'2').routeCount,51);
 for(const version of [undefined,'1','3','$LATEST'])assert.throws(()=>verifyIntentLiveControl(f.actual,source,f.input,f.s.candidate,f.before,f.preparation,version));
});
test('presigned Lambda download locations are memory-only and pinned to observed managed host/account/function without redirects',()=>{
 const f=fixture(),configuration=f.actual.fn;
 const valid={Configuration:clone(configuration),Code:{RepositoryType:'S3',
  Location:`https://awslambda-us-east-2-tasks.s3.us-east-2.amazonaws.com/snapshots/${P.account}/${P.functionName}-11111111-1111-4111-8111-111111111111?X-Amz-Signature=fictional`}};
 assert.match(verifyIntentCodeLocation(valid,configuration),/^https:/);
 for(const mutation of [v=>v.Configuration.CodeSize++,v=>v.Code.RepositoryType='ECR',v=>v.Code.Location=v.Code.Location.replace('https:','http:'),
  v=>v.Code.Location=v.Code.Location.replace('awslambda-us-east-2-tasks','attacker'),v=>v.Code.Location=v.Code.Location.replace(P.account,'173535830222'),
  v=>v.Code.Location=v.Code.Location.replace(P.functionName,'other-function'),v=>v.Code.Location+='\x23fragment',
  v=>v.Code.Location=v.Code.Location.replace('https://','https://user:password@'),v=>v.Code.Location=v.Code.Location.split('?')[0]]){
  const value=clone(valid);mutation(value);assert.throws(()=>verifyIntentCodeLocation(value,configuration));}
});
test('execute response loss observes the same admitted execution and never retries a mutation',async()=>{
 for(const lost of [false,true]){
  const f=fixture(),calls=[];let reads=0;
  const context={current:f.s.current,admit:async e=>calls.push(e.stage),record:async e=>calls.push(e.stage)};
  const d={guard:async()=>calls.push('guard'),execute:async binding=>{calls.push('execute');assert.equal(binding.id,f.before.binding.id);if(lost)throw Error('response lost');},
   observe:async binding=>{calls.push('observe');return {stack:{Stacks:[{StackId:binding.stackId,StackStatus:++reads<2?'UPDATE_IN_PROGRESS':'UPDATE_COMPLETE'}]},
    changeSet:{ChangeSetId:binding.id,StackId:binding.stackId,Status:'CREATE_COMPLETE',ExecutionStatus:reads<2?'EXECUTE_IN_PROGRESS':'EXECUTE_COMPLETE'}};},pause:async()=>{}};
  await executeIntentChange(f.before,context,d);assert.equal(calls.filter(v=>v==='execute').length,1);
  assert.ok(calls.indexOf('intent_change_execute_admitted')<calls.indexOf('execute'));
  assert.equal(calls.filter(v=>v==='observe').length,2);
 }
});
test('failed admission, rollback, wrong target, partial inventory and observation expiration cannot pass or replay',async()=>{
 for(const mode of ['admission','rollback','target','pagination','timeout']){
  const f=fixture(),calls=[];
  const context={current:f.s.current,admit:async()=>{if(mode==='admission')throw Error('journal failed');},record:async()=>{}};
  const d={guard:async()=>{},execute:async()=>calls.push('execute'),pause:async()=>{},observe:async()=>({
   stack:{Stacks:[{StackId:f.before.binding.stackId,StackStatus:mode==='rollback'?'UPDATE_ROLLBACK_COMPLETE':mode==='timeout'?'UPDATE_IN_PROGRESS':'UPDATE_COMPLETE'}]},
   changeSet:{ChangeSetId:mode==='target'?'other':f.before.binding.id,StackId:f.before.binding.stackId,Status:'CREATE_COMPLETE',
    ExecutionStatus:mode==='timeout'?'EXECUTE_IN_PROGRESS':'EXECUTE_COMPLETE',...(mode==='pagination'?{NextToken:'hidden'}:{})}})};
  await assert.rejects(executeIntentChange(f.before,context,d));assert.equal(calls.length,mode==='admission'?0:1);
 }
});
test('only the fixed CLI and source-bound embedded database port exist; no report or authority overrides',()=>{
 const f=fixture();intentReleaseArgs(['--v2-root','fictional-v2','--candidate','fictional-candidate','--release-fictional-intent-with-fresh-recovery']);
 for(const args of [[],['--skip'],['--target','production'],['--v2-root','a','--candidate','b','--release-fictional-intent-with-fresh-recovery','--approve']])assert.throws(()=>intentReleaseArgs(args));
 const bytes=Buffer.from('fictional database port'),m={contract:'care-intent-release-database-build/1',sourceCommit:f.s.current.desktop.commit,clean:true,
  sha256:sha256(bytes),execution:'synthetic-staging',phiAllowed:false,releaseMapping:f.s.current.migrations};
 for(const k of ['embeddedMigrations','embeddedReferenceMigrations','embeddedOverlay','mandatoryFreshCompatibleRecovery','mandatoryDeploymentReadback','mandatoryRollbackRehearsal'])m[k]=true;
 for(const k of ['targetOverrides','standaloneUpgradeAvailable','canonicalRegistered','migrationPerformed','hostedAcceptance'])m[k]=false;
 verifyIntentReleasePort(m,bytes,f.s.current);
 for(const [k,v] of Object.entries({clean:false,sourceCommit:'f'.repeat(40),phiAllowed:true,targetOverrides:true,mandatoryFreshCompatibleRecovery:false,sha256:'f'.repeat(64)}))
  assert.throws(()=>verifyIntentReleasePort({...m,[k]:v},bytes,f.s.current));
 const code=readFileSync(new URL('./release-synthetic-care-intent.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(code,/process\.env|--disable-rollback|update-function-code|--report|--skip|--approve/);
 assert.match(code,/runCareIntentUpload\(root,mobileRoot,directory/);assert.match(code,/rehearseCareIntentRouting/);assert.match(code,/releaseCareIntent/);
 assert.match(code,/verifyIntentReleasePort\(/);assert.match(code,/maxAttempts:1/);
});
