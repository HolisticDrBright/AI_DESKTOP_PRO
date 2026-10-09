import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {careRegisteredDeploymentFixture} from './test-fixtures/care-registered-deployment.mjs';
import {verifyCareRegisteredDeployment,verifyCareRegisteredBeforeExecution,runCareRegisteredExecution} from './care-registered-deployment.mjs';
import {verifyCareRegisteredUnexecutedProposalViews,verifyCareRegisteredExecutedProposalViews} from './care-registered-code-change.mjs';
import {verifyCareRegisteredPredecessorControl,verifyCareRegisteredSuccessorControl} from './care-registered-preflight.mjs';
const verify=f=>verifyCareRegisteredDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,f.started,f.completed);
test('complete registered successor readback proves exact bytes and unchanged authority without claiming recovery or release',()=>{
 const f=careRegisteredDeploymentFixture(),bytes=JSON.stringify(f.witness),r=verify(f);
 assert.equal(r.deployed,true);assert.equal(r.integrationNoOpProven,true);assert.equal(r.exactBytesVerified,true);
 assert.equal(r.compatibleRecoveryRequired,true);assert.equal(r.reportIsNotAuthority,true);
 for(const k of ['recoveryRehearsed','schemaChanged','hostedAcceptance','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 assert.equal(JSON.stringify(f.witness),bytes);
 assert.throws(()=>verifyCareRegisteredPredecessorControl(f.after.raw,f.source));
 assert.throws(()=>verifyCareRegisteredSuccessorControl(f.before.raw,f.source,f.candidate,f.current,f.artifact));
});
test('completed and available projections remain distinct; neither can be relabeled to admit another execution',()=>{
 const f=careRegisteredDeploymentFixture(),{before:b,after:a}=f,control=verifyCareRegisteredPredecessorControl(b.raw,f.source);
 const args=(s,d)=>[s,d,b.template,b.input,b.binding,b.raw,f.sourceText,control,f.current,f.candidate,f.artifact,f.completed];
 assert.doesNotThrow(()=>verifyCareRegisteredExecutedProposalViews(...args(a.summary,a.detailed)));
 assert.throws(()=>verifyCareRegisteredUnexecutedProposalViews(...args(a.summary,a.detailed)));
 assert.throws(()=>verifyCareRegisteredExecutedProposalViews(...args(b.summary,b.detailed)));
});
test('readback refuses source, pointer, exact-byte, freshness, fabricated flags and execution identity drift',()=>{
 for(const mutate of [f=>f.witness.current=structuredClone({...f.current,templateSha256:'0'.repeat(64)}),
  f=>f.sourceText+=' ',f=>f.artifact.versionId='null',f=>f.witness.artifact={...f.artifact,key:'other'},
  f=>f.witness.codeBytes[0]^=1,f=>f.witness.codeBytes=undefined,f=>f.witness.deployed=true,
  f=>f.witness.executionAdmittedAt=new Date(f.now+121000).toISOString(),
  f=>f.witness.after.observedAt=new Date(f.completed+1).toISOString(),f=>f.completed+=120001,
  f=>f.witness.after.summary.ExecutionStatus='AVAILABLE',f=>f.witness.after.detailed.ExecutionStatus='EXECUTE_IN_PROGRESS',
  f=>f.witness.after.summary.ChangeSetId+='other',f=>f.witness.after.summary.NextToken='page',
  f=>f.witness.after.raw.stack.Stacks[0].StackStatus='UPDATE_ROLLBACK_COMPLETE',
  f=>f.witness.after.raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue='other',
  f=>f.witness.after.raw.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion='other',
  f=>f.witness.after.raw.fn.CodeSha256=f.witness.before.raw.fn.CodeSha256,
  f=>f.witness.after.raw.fn.RevisionId=f.witness.before.raw.fn.RevisionId,
  f=>f.witness.after.raw.fn.Description='unreviewed mutation']){
  const f=careRegisteredDeploymentFixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('full control inventory refuses hidden authority, route, logging, identity and stage mutations',()=>{
 for(const mutate of [f=>f.witness.after.raw.fn.Environment.Variables.PHI_ALLOWED='true',
  f=>f.witness.after.raw.fn.Timeout++,f=>f.witness.after.raw.fn.Layers=['other'],
  f=>f.witness.after.raw.role.Role.AssumeRolePolicyDocument.Statement[0].Principal.Service='other',
  f=>f.witness.after.raw.policies[0].PolicyDocument.Statement[0].Action.push('rds-data:BatchExecuteStatement'),
  f=>f.witness.after.raw.attached.AttachedPolicies.push({PolicyName:'other',PolicyArn:'other'}),
  f=>f.witness.after.raw.logGroups.logGroups[0].retentionInDays=1,
  f=>f.witness.after.raw.routes.Items.pop(),f=>f.witness.after.raw.routes.NextToken='page',
  f=>f.witness.after.raw.routes.Items.at(-1).RouteKey='GET /changed-foreign-route',
  f=>f.witness.after.raw.authorizers.Items[0].JwtConfiguration.Audience=['other'],
  f=>f.witness.after.raw.resources.StackResources[0].PhysicalResourceId='replacement',
  f=>f.witness.after.raw.resources.NextToken='page',f=>f.witness.after.raw.integrations.Items[0].TimeoutInMillis=29000,
  f=>f.witness.after.raw.stage.DefaultRouteSettings.ThrottlingRateLimit++,
  f=>f.witness.after.raw.foundation.Stacks[0].Outputs.push({OutputKey:'UnreviewedBoundary',OutputValue:'true'}),
  f=>f.witness.after.raw.latestPolicy.RevisionId='other']){
  const f=careRegisteredDeploymentFixture();mutate(f);assert.throws(()=>verify(f));
 }
 const f=careRegisteredDeploymentFixture();f.witness.after.raw.stage.DeploymentId='newstage';
 f.witness.after.raw.stage.LastDeploymentStatusMessage="Successfully deployed stage with deployment ID 'newstage'";
 f.witness.after.raw.stage.LastUpdatedDate=new Date(f.completed).toISOString();assert.doesNotThrow(()=>verify(f));
});
test('canonical data, schema, ledger, counts and operator source must survive execution unchanged',()=>{
 for(const mutate of [f=>f.witness.after.database.operatorSource.sourceCommit='f'.repeat(40),
  f=>f.witness.after.database.schemaReplayPerformed=true,f=>f.witness.after.database.historicalInspection.rowCount++,
  f=>f.witness.after.database.historicalInspection.intentRowCount++,
  f=>f.witness.after.database.historicalInspection.completeDataSha256='0'.repeat(64),
  f=>f.witness.after.database.historicalInspection.schemaSha256='0'.repeat(64),
  f=>f.witness.after.database.liveMigrationCount++,f=>f.witness.after.database.repeatedReadbackVerified=false,
  f=>f.witness.after.database.observedAt=f.witness.before.database.observedAt]){
  const f=careRegisteredDeploymentFixture();mutate(f);assert.throws(()=>verify(f));
 }
});
function execution(){
 const f=careRegisteredDeploymentFixture(),events=[],caller={Account:P.account,
  Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'},state={now:f.now,executes:0,reads:0};
 const port={now:()=>state.now,current:async()=>structuredClone(f.current),identity:async()=>structuredClone(caller),
  custody:async()=>{},preflight:async()=>structuredClone(f.preflight),
  storage:async()=>({state:'stored_exact_version',bytesVerified:true,versionId:f.artifact.versionId,
   sha256:f.candidate.manifest.zipSha256,bytes:f.candidate.zip.length,deletionCertified:false}),
  before:async()=>structuredClone(f.before),admit:async e=>events.push(e),record:async e=>events.push(e),
  execute:async(binding,token)=>{state.executes++;events.push({stage:'actual_execute',binding,token});},
  execution:async()=>{state.reads++;return {stack:structuredClone(f.after.raw.stack),changeSet:structuredClone(f.after.summary)};},
  pause:async ms=>{state.now+=ms;},after:async()=>{state.now=f.completed;return {after:structuredClone(f.after),codeBytes:Buffer.from(f.candidate.zip)};}};
 return {f,events,caller,state,port};
}
const run=x=>runCareRegisteredExecution(x.f.candidate,x.f.current,x.f.sourceText,x.f.artifact,x.port);
test('execution is admitted once before the write; a lost reply is observed on the exact execution without retry',async()=>{
 for(const lost of [false,true]){
  const x=execution();if(lost){const execute=x.port.execute;x.port.execute=async(...a)=>{await execute(...a);throw Error('lost reply');};}
  const r=await run(x);assert.equal(x.state.executes,1);assert.equal(r.replyLost,lost);assert.equal(r.releaseAccepted,false);
  assert(x.events.findIndex(e=>e.stage==='registered_change_execute_admitted')<x.events.findIndex(e=>e.stage==='actual_execute'));
  assert.equal(x.events.at(-1).stage,'registered_deployed_bytes_control_verified');
 }
});
test('failed durable admission, stale source, root identity, custody or changed second before-read refuses without executing',async()=>{
 for(const kind of ['admission','source','root','custody','changed','late']){
  const x=execution();
  if(kind==='admission')x.port.admit=async()=>{throw Error('fsync failed');};
  if(kind==='source')x.port.current=async()=>({...x.f.current,templateSha256:'0'.repeat(64)});
  if(kind==='root')x.caller.Arn=`arn:aws:iam::${P.account}:root`;
  if(kind==='custody')x.port.custody=async()=>{throw Error('lost custody');};
  if(kind==='changed'||kind==='late'){let count=0;const before=x.port.before;x.port.before=async()=>{const b=await before();
   if(++count===2){if(kind==='changed')b.raw.fn.RevisionId+='other';else x.state.now+=120001;}return b;};}
  await assert.rejects(run(x));assert.equal(x.state.executes,0);
 }
});
test('missing independent preflight or stale/changed exact storage cannot admit execution',async()=>{
 for(const kind of ['rebuild','stale','control','storage','late_storage']){
  const x=execution();
  if(kind==='rebuild')x.f.preflight.independentSourceRebuildVerified=false;
  if(kind==='stale')x.f.preflight.observedAt=new Date(x.f.now-120001).toISOString();
  if(kind==='control')x.f.preflight.control.revision+='other';
  if(kind==='storage')x.port.storage=async()=>({state:'stored_exact_version',bytesVerified:true,versionId:'other'});
  if(kind==='late_storage'){let count=0;const storage=x.port.storage;x.port.storage=async()=>{const r=await storage();if(++count===2)r.versionId='other';return r;};}
  await assert.rejects(run(x));assert.equal(x.state.executes,0);
  assert.equal(x.events.some(e=>e.stage==='registered_change_execute_admitted'),false);
 }
});
test('slow complete observations renew through the real preflight port, never by refreshing an old report timestamp',async()=>{
 const x=execution(),oldTime=x.f.preflight.observedAt;let calls=0,beforeCalls=0;
 x.port.preflight=async()=>{const r=structuredClone(x.f.preflight);if(++calls===2){x.state.now+=180000;r.observedAt=new Date(x.state.now).toISOString();}return r;};
 const observe=x.port.before;x.port.before=async()=>{const b=await observe();if(++beforeCalls===2){
  b.observedAt=new Date(x.state.now).toISOString();b.database.observedAt=b.observedAt;}return b;};
 x.port.after=async()=>{x.state.now+=30000;const after=structuredClone(x.f.after);
  after.observedAt=new Date(x.state.now).toISOString();after.database.observedAt=after.observedAt;
  return {after,codeBytes:Buffer.from(x.f.candidate.zip)};};
 const r=await run(x);assert.equal(r.deployed,true);assert.equal(calls,2);assert.equal(x.f.preflight.observedAt,oldTime);
 assert.equal(x.state.executes,1);
});
test('renewed preflight source, role, rebuild or authority refusal cannot admit execution',async()=>{
 for(const kind of ['control','rebuild','source','failed']){
  const x=execution();let count=0;const observe=x.port.preflight;x.port.preflight=async()=>{const r=await observe();if(++count===2){
   if(kind==='failed')throw Error('renewal failed');if(kind==='control')r.control.revision+='changed';
   if(kind==='rebuild')r.independentSourceRebuildVerified=false;if(kind==='source')r.current.desktop.sha256='0'.repeat(64);
  }return r;};await assert.rejects(run(x));assert.equal(x.state.executes,0);
 }
});
test('terminal failure, unknown target, partial inventory or exhausted observation cannot certify or replay execution',async()=>{
 for(const kind of ['failed','target','page','pending','readback','source_after']){
  const x=execution(),observe=x.port.execution;
  x.port.execution=async()=>{const o=await observe();
   if(kind==='failed')o.stack.Stacks[0].StackStatus='UPDATE_ROLLBACK_COMPLETE';
   if(kind==='target')o.changeSet.ChangeSetId+='other';if(kind==='page')o.changeSet.NextToken='more';
   if(kind==='pending')o.changeSet.ExecutionStatus='EXECUTE_IN_PROGRESS';return o;};
  if(kind==='readback')x.f.after.raw.fn.Environment.Variables.OTHER='unsafe';
  if(kind==='source_after'){const after=x.port.after;x.port.after=async()=>{const r=await after();x.f.current.desktop.sha256='f'.repeat(64);return r;};}
  await assert.rejects(run(x));assert.equal(x.state.executes,1);
  assert.equal(x.events.some(e=>e.stage==='registered_deployed_bytes_control_verified'),false);
  if(kind==='pending')assert.equal(x.state.reads,120);
 }
});
test('execution primitives expose no saved-report CLI, target/profile override, transport or schema replay',()=>{
 const text=readFileSync(new URL('./care-registered-deployment.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(text,/execFile|process\.argv|process\.env|client\.send|readFileSync|update-function-code|migrate|downMigration/);
 assert.match(text,/compatibleRecoveryRequired:true/);assert.match(text,/recoveryRehearsed:false/);
 assert.match(text,/await port\.admit/);assert.match(text,/execute\(binding,token\)/);
 assert.throws(()=>verifyCareRegisteredBeforeExecution({},careRegisteredDeploymentFixture().candidate,{},'',{},0,0));
});
