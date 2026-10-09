import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {catalogRuntimeDeploymentFixture} from './test-fixtures/catalog-runtime-deployment.mjs';
import {verifyCatalogRuntimeDeployment,verifyCatalogRuntimeBeforeExecution,runCatalogRuntimeExecution,
 verifyCatalogRuntimeReconciledDeployment,verifyCatalogRuntimeRestorationDeployment} from './catalog-runtime-deployment.mjs';
import {verifyCatalogRuntimeUnexecutedProposalViews,verifyCatalogRuntimeExecutedProposalViews} from './catalog-runtime-code-change.mjs';
import {verifyCatalogRuntimePredecessorControl,verifyCatalogRuntimeSuccessorControl} from './catalog-runtime-preflight.mjs';
const verify=f=>verifyCatalogRuntimeDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,f.started,f.completed);
test('complete catalog successor readback proves exact bytes and unchanged authority without claiming recovery or release',()=>{
 const f=catalogRuntimeDeploymentFixture(),bytes=JSON.stringify(f.witness),r=verify(f);
 assert.equal(r.deployed,true);assert.equal(r.integrationNoOpProven,true);assert.equal(r.exactBytesVerified,true);
 assert.equal(r.compatibleRecoveryRequired,true);assert.equal(r.reportIsNotAuthority,true);
 for(const k of ['recoveryRehearsed','schemaChanged','hostedAcceptance','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 assert.equal(JSON.stringify(f.witness),bytes);
 assert.throws(()=>verifyCatalogRuntimePredecessorControl(f.after.raw,f.source));
 assert.throws(()=>verifyCatalogRuntimeSuccessorControl(f.before.raw,f.source,f.candidate,f.current,f.artifact));
});
test('completed and available projections remain distinct; neither can be relabeled to admit another execution',()=>{
 const f=catalogRuntimeDeploymentFixture(),{before:b,after:a}=f,control=verifyCatalogRuntimePredecessorControl(b.raw,f.source);
 const args=(s,d)=>[s,d,b.template,b.input,b.binding,b.raw,f.sourceText,control,f.current,f.candidate,f.artifact,f.completed];
 assert.doesNotThrow(()=>verifyCatalogRuntimeExecutedProposalViews(...args(a.summary,a.detailed)));
 assert.throws(()=>verifyCatalogRuntimeUnexecutedProposalViews(...args(a.summary,a.detailed)));
 assert.throws(()=>verifyCatalogRuntimeExecutedProposalViews(...args(b.summary,b.detailed)));
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
  const f=catalogRuntimeDeploymentFixture();mutate(f);assert.throws(()=>verify(f));
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
  const f=catalogRuntimeDeploymentFixture();mutate(f);assert.throws(()=>verify(f));
 }
 const f=catalogRuntimeDeploymentFixture();f.witness.after.raw.stage.DeploymentId='newstage';
 f.witness.after.raw.stage.LastDeploymentStatusMessage="Successfully deployed stage with deployment ID 'newstage'";
 f.witness.after.raw.stage.LastUpdatedDate=new Date(f.completed).toISOString();assert.doesNotThrow(()=>verify(f));
});
test('canonical data, schema, ledger, counts and operator source must survive execution unchanged',()=>{
 for(const mutate of [f=>f.witness.after.database.operatorSource.sourceCommit='f'.repeat(40),
  f=>f.witness.after.database.schemaReplayPerformed=true,f=>f.witness.after.database.catalogInspection.rowCount++,
  f=>f.witness.after.database.catalogInspection.referenceMigrationCount++,
  f=>f.witness.after.database.catalogInspection.dataSha256='0'.repeat(64),
  f=>f.witness.after.database.catalogInspection.preservedSchemaSha256='0'.repeat(64),
  f=>f.witness.after.database.liveMigrationCount++,f=>f.witness.after.database.repeatedReadbackVerified=false,
  f=>f.witness.after.database.observedAt=f.witness.before.database.observedAt]){
  const f=catalogRuntimeDeploymentFixture();mutate(f);assert.throws(()=>verify(f));
 }
});
function execution(){
 const f=catalogRuntimeDeploymentFixture(),events=[],caller={Account:P.account,
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
const run=x=>runCatalogRuntimeExecution(x.f.candidate,x.f.current,x.f.sourceText,x.f.artifact,x.port);
test('execution is admitted once before the write; a lost reply is observed on the exact execution without retry',async()=>{
 for(const lost of [false,true]){
  const x=execution();if(lost){const execute=x.port.execute;x.port.execute=async(...a)=>{await execute(...a);throw Error('lost reply');};}
  const r=await run(x);assert.equal(x.state.executes,1);assert.equal(r.replyLost,lost);assert.equal(r.releaseAccepted,false);
  assert(x.events.findIndex(e=>e.stage==='catalog_runtime_change_execute_admitted')<x.events.findIndex(e=>e.stage==='actual_execute'));
  assert.equal(x.events.at(-1).stage,'catalog_runtime_deployed_bytes_control_verified');
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
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_execute_admitted'),false);
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
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_deployed_bytes_control_verified'),false);
  if(kind==='pending')assert.equal(x.state.reads,120);
 }
});
test('execution primitives expose no saved-report CLI, target/profile override, transport or schema replay',()=>{
 const text=readFileSync(new URL('./catalog-runtime-deployment.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(text,/execFile|process\.argv|process\.env|client\.send|readFileSync|update-function-code|migrate|downMigration/);
 assert.match(text,/compatibleRecoveryRequired:true/);assert.match(text,/recoveryRehearsed:false/);
 assert.match(text,/await port\.admit/);assert.match(text,/execute\(structuredClone\(binding\),token\)/);
 assert.throws(()=>verifyCatalogRuntimeBeforeExecution({},catalogRuntimeDeploymentFixture().candidate,{},'',{},0,0));
});

test('post-admission expiry, source/principal/custody loss and asynchronous admission rejection never reach execute',async()=>{
 for(const kind of ['expiry','source','principal','custody','rejection']){
  const x=execution(),admit=x.port.admit;let admitted=false;
  const originalCustody=x.port.custody;x.port.custody=async()=>{if(admitted&&kind==='custody')throw Error('custody changed');await originalCustody();};
  x.port.admit=async e=>{await admit(e);await Promise.resolve();admitted=true;
   if(kind==='expiry')x.state.now+=120001;
   if(kind==='source')x.f.current.desktop.sha256='f'.repeat(64);
   if(kind==='principal')x.caller.Arn+='changed';
   if(kind==='rejection')throw Error('journal unconfirmed');
  };
  await assert.rejects(run(x));assert.equal(x.state.executes,0);
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_execute_reply_unconfirmed'),false);
 }
});

test('supplied candidate, artifact and caller are captured before asynchronous ports can mutate them',async()=>{
 const x=execution(),originalZip=Buffer.from(x.f.candidate.zip),originalCurrent=structuredClone(x.f.current),
  originalArtifact=structuredClone(x.f.artifact),after=structuredClone(x.f.after);
 let identityReads=0;
 x.port.identity=async()=>{if(++identityReads===1){x.f.candidate.zip.fill(0);x.f.candidate.manifest.zipSha256='f'.repeat(64);
  x.f.artifact.versionId='mutated';x.f.current.desktop.commit='f'.repeat(40);}
  return structuredClone(x.caller);};
 x.port.current=async()=>structuredClone(originalCurrent);
 x.port.storage=async()=>({state:'stored_exact_version',bytesVerified:true,versionId:originalArtifact.versionId,
  sha256:originalArtifact.sha256,bytes:originalZip.length,deletionCertified:false});
 x.port.after=async()=>{x.state.now=x.f.completed;return {after:structuredClone(after),codeBytes:Buffer.from(originalZip)};};
 const r=await run(x);assert.equal(r.deployed,true);assert.deepEqual(r.current,originalCurrent);
 assert.equal(r.codeVersion,originalArtifact.versionId);assert.equal(x.state.executes,1);
});

test('a provider cannot mutate the admitted binding through execute, poll or readback arguments',async()=>{
 const x=execution(),execute=x.port.execute,observe=x.port.execution,after=x.port.after;
 x.port.execute=async(binding,token)=>{await execute(binding,token);binding.id+='mutated';binding.stackId='other';};
 x.port.execution=async binding=>{binding.id='other';return observe();};
 x.port.after=async binding=>{binding.name='other';return after();};
 const r=await run(x);assert.equal(r.changeSetId,x.f.binding.id);assert.equal(x.state.executes,1);
});

test('final exact object drift refuses deployment certification without replaying execution',async()=>{
 const x=execution(),storage=x.port.storage;let count=0;
 x.port.storage=async()=>{const r=await storage();if(++count===3)r.versionId='other';return r;};
 await assert.rejects(run(x));assert.equal(x.state.executes,1);
 assert.equal(x.events.some(e=>e.stage==='catalog_runtime_deployed_bytes_control_verified'),false);
});

test('final storage and awaited journal boundaries cannot publish expired or unconfirmed readback',async()=>{
 for(const kind of ['late_storage','late_journal','failed_journal','source_journal']){
  const x=execution(),storage=x.port.storage,record=x.port.record;let count=0;
  x.port.storage=async()=>{const r=await storage();if(++count===3&&kind==='late_storage')x.state.now+=120001;return r;};
  x.port.record=async e=>{await record(e);await Promise.resolve();if(e.stage==='catalog_runtime_deployed_bytes_control_verified'){
   if(kind==='late_journal')x.state.now+=120001;
   if(kind==='failed_journal')throw Error('journal not confirmed');
   if(kind==='source_journal')x.f.current.desktop.sha256='f'.repeat(64);
  }};
  await assert.rejects(run(x));assert.equal(x.state.executes,1);
 }
});

test('stopped-writer readback has a separate current operator identity and cannot rewrite historical admission',()=>{
 const f=catalogRuntimeDeploymentFixture(),operator=structuredClone(f.current);
 operator.desktop.commit='e'.repeat(40);operator.desktop.sha256='d'.repeat(64);
 f.witness.after.database.operatorSource.sourceCommit=operator.desktop.commit;
 const bytes=JSON.stringify(f.witness);
 const r=verifyCatalogRuntimeReconciledDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,operator,f.now+1,f.completed);
 assert.equal(r.originalExecutionOutcome,'unconfirmed');assert.equal(r.retryPerformed,false);
 assert.equal(r.recoveryRehearsed,false);assert.deepEqual(r.operatorSource,operator);
 assert.equal(JSON.stringify(f.witness),bytes);
 const bad=structuredClone(operator);bad.mobile.contractSha256='f'.repeat(64);
 assert.throws(()=>verifyCatalogRuntimeReconciledDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,bad,f.now+1,f.completed));
 const dirty=structuredClone(operator);dirty.desktop.clean=false;
 assert.throws(()=>verifyCatalogRuntimeReconciledDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,dirty,f.now+1,f.completed));
 const old=structuredClone(f.witness);old.after.database.observedAt=new Date(f.now).toISOString();
 assert.throws(()=>verifyCatalogRuntimeReconciledDeployment(old,f.candidate,f.current,f.sourceText,f.artifact,operator,f.now+1,f.completed));
});

test('a retained routing observation is distinct from latest restoration and certifies neither recovery nor release',()=>{
 const f=catalogRuntimeDeploymentFixture();
 const owned=f.witness.after.raw.integrations.Items.find(v=>v.IntegrationId==='2k0pka6');
 owned.IntegrationUri+=':2';
 const r=verifyCatalogRuntimeRestorationDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,f.current,f.now+1,f.completed,'2');
 assert.equal(r.observedRoutingVersion,'2');assert.equal(r.integrationNoOpProven,false);
 assert.equal(r.recoveryRehearsed,false);assert.equal(r.releaseAccepted,false);
 assert.throws(()=>verify(f));
 assert.throws(()=>verifyCatalogRuntimeRestorationDeployment(f.witness,f.candidate,f.current,f.sourceText,f.artifact,f.current,f.now+1,f.completed,'3'));
});
