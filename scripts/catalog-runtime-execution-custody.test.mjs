import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {catalogRuntimeDeploymentFixture} from './test-fixtures/catalog-runtime-deployment.mjs';
import {catalogRuntimeExecutionAdmission,verifyCatalogRuntimeExecutionCustody,runCatalogRuntimeExecutionReconciliation} from './catalog-runtime-execution-custody.mjs';
function fixture(){
 const f=catalogRuntimeDeploymentFixture(),operator=structuredClone(f.current);operator.desktop.commit='e'.repeat(40);operator.desktop.sha256='d'.repeat(64);
 const lock={runId:'1'.repeat(32),pid:12345,purpose:'catalog-runtime-artifact-execution',desktop:f.current.desktop,mobile:f.current.mobile},
  token=sha256(canonical({contract:'catalog-runtime-execution-input/1',binding:f.binding,current:f.current,artifact:f.artifact})),
  admission=catalogRuntimeExecutionAdmission(f.before,f.current,f.artifact,operator,f.witness.executionAdmittedAt,token),
  files=new Map([['before1',Buffer.from(JSON.stringify(f.before,null,2)+'\n')],['before2',Buffer.from(JSON.stringify(f.before,null,2)+'\n')],
   ['admission',Buffer.from(JSON.stringify(admission,null,2)+'\n')]]);
 const events=[{at:new Date(f.started).toISOString(),stage:'catalog_runtime_execution_started',runId:lock.runId,operatorSource:operator},
  ...['before1','before2'].map(file=>({at:f.before.observedAt,stage:'catalog_runtime_execution_before_archived',file,sha256:sha256(files.get(file))})),
  {at:f.witness.executionAdmittedAt,stage:'catalog_runtime_change_execute_admitted',stackId:f.binding.stackId,changeSetId:f.binding.id,
   clientToken:token,admissionFile:'admission',admissionSha256:sha256(files.get('admission'))}];
 const encode=()=>({lockBytes:Buffer.from(JSON.stringify(lock)+'\n'),journalBytes:Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 const state={now:f.completed+600000},calls=[],caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 f.after.observedAt=new Date(state.now).toISOString();f.after.database.observedAt=f.after.observedAt;
 f.after.database.operatorSource={sourceCommit:operator.desktop.commit,clean:true};
 const port={now:()=>state.now,evidence:async file=>files.get(file),unchanged:async()=>{},identity:async()=>structuredClone(caller),
  writerStopped:async()=>true,custody:async()=>encode(),storage:async()=>{calls.push('storage');return structuredClone(f.artifact);},
  database:async()=>{calls.push('database');return structuredClone(f.after.database);},
  control:async()=>{calls.push('control');return structuredClone(f.after.raw);},
  views:async binding=>{assert.deepEqual(binding,f.binding);calls.push('views');return {summary:structuredClone(f.after.summary),
   detailed:structuredClone(f.after.detailed),template:structuredClone(f.after.template)};},
  download:async()=>{calls.push('download');return Buffer.from(f.candidate.zip);}};
 return {f,operator,lock,token,admission,files,events,encode,state,calls,caller,port};
}
const verify=x=>verifyCatalogRuntimeExecutionCustody(x.f.candidate,x.f.artifact,x.f.sourceText,x.encode(),x.state.now,x.port.evidence);
const run=x=>runCatalogRuntimeExecutionReconciliation(x.f.candidate,x.f.artifact,x.f.sourceText,x.encode(),x.operator,x.port);
function unexecuted(){const x=fixture();x.f.after.raw=structuredClone(x.f.before.raw);x.f.after.summary=structuredClone(x.f.before.summary);
 x.f.after.detailed=structuredClone(x.f.before.detailed);x.f.after.template=structuredClone(x.f.before.template);
 x.port.download=async()=>Buffer.from('fictional-original-predecessor');
 // The fixture predecessor digest is an actual pinned hash, not these text
 // bytes. Unexecuted negative cases must refuse this placeholder download.
 return x;}

test('a hard-crash admitted prefix binds immutable before and admission bytes, not an execution outcome',async()=>{
 const x=fixture(),r=await verify(x);assert.equal(r.originalExecutionOutcome,'unconfirmed');assert.deepEqual(r.before,x.f.before);
 assert.equal(r.operator.desktop.commit,x.operator.desktop.commit);assert.equal(r.binding.id,x.f.binding.id);
 x.events.push({at:new Date(x.f.completed).toISOString(),stage:'catalog_runtime_execution_finding',
  code:'synthetic_care_registered_release_refused:fictional',writeAdmitted:true});assert.doesNotThrow(()=>x.encode());await verify(x);
});
test('exact journal encoding/order, authority, target, original bytes and settlement are mandatory',async()=>{
 for(const mutate of [x=>x.lock.purpose='catalog-runtime-artifact-proposal',x=>x.lock.pid=0,x=>x.lock.desktop.commit='f'.repeat(40),
  x=>x.events[0].operatorSource.desktop.clean=false,x=>x.events[0].operatorSource.mobile.contractSha256='f'.repeat(64),
  x=>x.events.splice(1,1),x=>x.events[2].stage='catalog_runtime_execution_completed',
  x=>x.events[3].stackId+='other',x=>x.events[3].changeSetId+='other',x=>x.events[3].clientToken='f'.repeat(64),
  x=>x.events[3].admissionSha256='f'.repeat(64),x=>x.files.get('before2')[0]^=1,x=>x.files.get('admission')[0]^=1,
  x=>x.events[1].extra=true,x=>x.events[1].at='invalid',x=>x.events[3].at=new Date(x.state.now-59999).toISOString()]){
  const x=fixture();mutate(x);await assert.rejects(verify(x));
 }
 const x=fixture(),c=x.encode();c.lockBytes=Buffer.from(JSON.stringify(x.lock,null,2)+'\n');
 await assert.rejects(verifyCatalogRuntimeExecutionCustody(x.f.candidate,x.f.artifact,x.f.sourceText,c,x.state.now,x.port.evidence));
});
test('a journal cannot skip terminal observation or change reply attribution',async()=>{
 for(const kind of ['verified','completed','reply','terminal']){
  const x=fixture(),at=new Date(x.f.completed).toISOString();
  if(kind==='verified')x.events.push({at,stage:'catalog_runtime_deployed_bytes_control_verified',changeSetId:x.f.binding.id,revision:'new',zipSha256:x.f.candidate.manifest.zipSha256});
  if(kind==='completed')x.events.push({at,stage:'catalog_runtime_execution_completed',receipt:'receipt'});
  if(kind==='reply')x.events.push({at,stage:'catalog_runtime_change_execute_reply_unconfirmed',changeSetId:'other'});
  if(kind==='terminal')x.events.push({at,stage:'catalog_runtime_change_execute_terminal',changeSetId:x.f.binding.id,replyLost:true});
  await assert.rejects(verify(x));
 }
 const x=fixture(),at=new Date(x.f.completed).toISOString();
 x.events.push({at,stage:'catalog_runtime_change_execute_reply_unconfirmed',changeSetId:x.f.binding.id},
  {at,stage:'catalog_runtime_change_execute_terminal',changeSetId:x.f.binding.id,replyLost:true},
  {at,stage:'catalog_runtime_deployed_bytes_control_verified',changeSetId:x.f.binding.id,revision:'new',zipSha256:x.f.candidate.manifest.zipSha256},
  {at,stage:'catalog_runtime_execution_completed',receipt:'receipt'});await verify(x);
});
test('a legitimately renewed final observation preserves the older first archive instead of refreshing its timestamp',async()=>{
 const x=fixture(),before2=structuredClone(x.f.before),time=x.f.now+180000;
 before2.observedAt=new Date(time).toISOString();before2.database.observedAt=before2.observedAt;
 const admission=catalogRuntimeExecutionAdmission(before2,x.f.current,x.f.artifact,x.operator,new Date(time+1000).toISOString(),x.token);
 x.files.set('before2',Buffer.from(JSON.stringify(before2,null,2)+'\n'));x.files.set('admission',Buffer.from(JSON.stringify(admission,null,2)+'\n'));
 x.events[2].at=before2.observedAt;x.events[2].sha256=sha256(x.files.get('before2'));
 x.events[3].at=admission.executionAdmittedAt;x.events[3].admissionSha256=sha256(x.files.get('admission'));
 const r=await verify(x);assert.equal(r.before.observedAt,before2.observedAt);
 assert.equal(JSON.parse(x.files.get('before1').toString()).observedAt,x.f.before.observedAt);
 x.events[3].at=new Date(time+120001).toISOString();await assert.rejects(verify(x));
});
test('reconciliation observes completed deployment three times with exact bytes and unchanged database; never claims recovery',async()=>{
 const x=fixture(),r=await run(x);assert.equal(r.observation,'verified_deployed');assert.equal(r.deployed,true);
 assert.equal(r.originalExecutionOutcome,'unconfirmed');assert.equal(r.retryPerformed,false);assert.equal(r.awsMutationPerformed,false);
 for(const k of ['recoveryRehearsed','schemaChanged','hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 assert.equal(x.calls.filter(v=>v==='control').length,3);assert.equal(x.calls.filter(v=>v==='download').length,3);
});
test('pending, rollback, partial views, wrong bytes/database/operator and late principal/custody changes remain held',async()=>{
 for(const kind of ['pending','rollback','page','bytes','database','operator','principal','custody','writer','late_control','storage']){
  const x=fixture();
  if(kind==='pending')x.f.after.summary.ExecutionStatus='EXECUTE_IN_PROGRESS';
  if(kind==='rollback')x.f.after.raw.stack.Stacks[0].StackStatus='UPDATE_ROLLBACK_COMPLETE';
  if(kind==='page')x.f.after.summary.NextToken='more';if(kind==='bytes')x.port.download=async()=>Buffer.from('wrong');
  if(kind==='database')x.f.after.database.catalogInspection.dataSha256='f'.repeat(64);
  if(kind==='operator')x.operator.desktop.clean=false;if(kind==='writer')x.port.writerStopped=async()=>false;
  if(kind==='principal'){let reads=0;const identity=x.port.identity;x.port.identity=async()=>{const r=await identity();if(++reads===4)r.Arn+='other';return r;};}
  if(kind==='custody'){let reads=0;x.port.custody=async()=>{const r=x.encode();if(++reads===4)r.journalBytes=Buffer.from('changed');return r;};}
  if(kind==='late_control'){let reads=0;const control=x.port.control;x.port.control=async()=>{const r=await control();if(++reads===3)r.fn.Timeout++;return r;};}
  if(kind==='storage'){let reads=0;const storage=x.port.storage;x.port.storage=async()=>{const r=await storage();if(++reads===4)r.versionId='other';return r;};}
  await assert.rejects(run(x),undefined,kind);
 }
});
test('available is not success unless the original predecessor bytes and full current control really match',async()=>{
 const x=unexecuted();await assert.rejects(run(x),/predecessor_changed/);
});
test('late final storage cannot certify stale completed observations',async()=>{
 const x=fixture(),storage=x.port.storage;let reads=0;
 x.port.storage=async()=>{const r=await storage();if(++reads===4)x.state.now+=120001;return r;};
 await assert.rejects(run(x));
});
