import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync,utimesSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from './care-recovery-routing.mjs';
import {intentRecoveryPermission} from './care-intent-routing.mjs';
import {careRegisteredDeploymentFixture} from './test-fixtures/care-registered-deployment.mjs';
import {verifyCareRegisteredRestorationDeployment} from './care-registered-deployment.mjs';
import {verifyInterruptedRegisteredReleaseCustody,runRegisteredReleaseReconciliation} from './reconcile-synthetic-care-registered-release.mjs';
import {splitRegisteredRestorationJournal} from './care-registered-restoration-custody.mjs';
import {acquireRegisteredUploadReconciliationGuard} from './reconcile-synthetic-care-registered-upload.mjs';
import {registeredRoutingRestorationArguments,runRegisteredRoutingRestoration,archiveRegisteredRestoredLock} from './restore-synthetic-care-registered-routing.mjs';
import {verifyStoppedRegisteredInspectionGuard,acquireRegisteredRestorationMutex,acquireRecoverableRegisteredInspectionGuard} from './care-registered-restoration-guard.mjs';
function fixture(){
 const f=careRegisteredDeploymentFixture();f.now=f.completed+600000;f.operator=structuredClone(f.current);
 f.operator.desktop.commit='1'.repeat(40);f.operator.desktop.sha256='2'.repeat(64);
 f.after.database.operatorSource={sourceCommit:f.operator.desktop.commit,clean:true};
 f.after.observedAt=new Date(f.now).toISOString();f.after.database.observedAt=f.after.observedAt;
 f.sid='alp-care-intent-recovery-'+'a'.repeat(32);f.policy={RevisionId:'fictional-permission-revision',
  Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(f.sid,'2')]})};
 f.lock={purpose:'registered-artifact-upload-release',pid:1234567,runId:'3'.repeat(32),desktop:f.current.desktop,mobile:f.current.mobile};
 const {binding}=f.before,token=sha256(canonical({contract:'care-registered-execution-input/1',binding,current:f.current,artifact:f.artifact}));
 f.admission={at:f.witness.executionAdmittedAt,stage:'registered_change_execute_admitted',stackId:binding.stackId,
  changeSetId:binding.id,clientToken:token,beforeSha256:sha256(canonical(f.before)),artifact:f.artifact,current:f.current};
 f.files=new Map([['before',Buffer.from(JSON.stringify(f.before,null,2)+'\n')],['admission',Buffer.from(JSON.stringify(f.admission,null,2)+'\n')]]);
 const e=(stage,detail={},at=f.completed)=>({at:new Date(at).toISOString(),stage,...detail});
 f.events=[e('registered_upload_started',{runId:f.lock.runId},f.started),e('registered_live_preflight_verified',{observedAt:new Date(f.started).toISOString()},f.started),
  e('registered_artifact_exact_version_verified',{artifact:f.artifact},f.started),
  e('registered_change_set_observed',{id:binding.id,name:binding.name,reused:true},f.started),
  e('registered_change_set_verified_unexecuted',{id:binding.id,summarySha256:sha256(canonical(f.before.summary)),propertyValuesSha256:sha256(canonical(f.before.detailed))},f.started),
  e('registered_execution_before_archived',{file:'before',sha256:sha256(f.files.get('before'))},Date.parse(f.before.observedAt)),
  e('registered_execution_before_archived',{file:'before',sha256:sha256(f.files.get('before'))},Date.parse(f.before.observedAt)),
  e('registered_change_execute_admitted',{stackId:binding.stackId,changeSetId:binding.id,clientToken:token,
   admissionFile:'admission',admissionSha256:sha256(canonical(f.admission))},Date.parse(f.admission.at)),
  e('registered_change_execute_terminal',{changeSetId:binding.id,replyLost:false}),
  e('registered_deployed_bytes_control_verified',{changeSetId:binding.id,revision:f.after.raw.fn.RevisionId,zipSha256:f.candidate.manifest.zipSha256}),
  e('registered_deployment_readback_archived',{file:'deployment'}),e('registered_recovery_permission_admitted',{version:'2',sid:f.sid}),
  e('registered_recovery_switch_admitted',{version:'2'}),
  e('registered_upload_finding',{code:'synthetic_care_registered_release_refused:routing_restoration_unconfirmed',writeAdmitted:true})];
 f.encode=()=>({lockBytes:Buffer.from(JSON.stringify(f.lock)+'\n'),journalBytes:Buffer.from(f.events.map(v=>JSON.stringify(v)).join('\n')+'\n')});
 f.original=f.encode();f.custody=structuredClone(f.original);f.custody.lockBytes=Buffer.from(f.original.lockBytes);f.custody.journalBytes=Buffer.from(f.original.journalBytes);
 f.after.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri=R.latestArn+':2';
 f.retained={configuration:{...structuredClone(f.before.raw.fn),Version:'2',FunctionArn:R.latestArn+':2'},
  sha256:f.candidate.release.predecessor.zipSha256,bytes:f.candidate.release.predecessor.bytes,policy:f.policy};
 f.calls=[];f.records=[];f.caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 f.port={now:()=>f.now,pid:7654321,evidence:async file=>f.files.get(file),identity:async()=>structuredClone(f.caller),
  current:async()=>structuredClone(f.operator),applicationCurrent:async()=>structuredClone(f.current),writerStopped:async()=>true,custody:async()=>f.encode(),
  rebuild:async()=>({byteVerified:true,sourceRebuilt:true,zipSha256:f.candidate.manifest.zipSha256,desktopCommit:f.current.desktop.commit,
   mobileCommit:f.current.mobile.source.commit,liveTargetObserved:false,deployed:false,phiAllowed:false}),
  database:async()=>{f.calls.push('database');return structuredClone(f.after.database);},control:async()=>{f.calls.push('control');return structuredClone(f.after.raw);},
  proposal:async()=>({summary:structuredClone(f.after.summary),detailed:structuredClone(f.after.detailed),template:structuredClone(f.after.template)}),
  latest:async()=>Buffer.from(f.candidate.zip),retained:async()=>({...structuredClone(f.retained),policy:structuredClone(f.policy)}),retainedPolicy:async()=>structuredClone(f.policy),
  apiDeployment:async id=>({DeploymentId:id,DeploymentStatus:'DEPLOYED'}),
  storage:async()=>({state:'stored_exact_version',bytesVerified:true,versionId:f.artifact.versionId,sha256:f.candidate.manifest.zipSha256,
   bytes:f.candidate.manifest.zipBytes,deletionCertified:false}),
  record:async event=>{f.records.push(event.stage);f.events.push(event);return f.encode().journalBytes;},
  returnLatest:async()=>{f.calls.push('return');f.after.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri=R.latestArn;
   f.after.raw.stage.DeploymentId='returned';f.after.raw.stage.LastDeploymentStatusMessage="Successfully deployed stage with deployment ID 'returned'";},
  waitLatest:async previous=>{f.calls.push('wait');assert.notEqual(f.after.raw.stage.DeploymentId,previous);
   assert.equal(f.after.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri,R.latestArn);},
  removePermission:async(sid,revision)=>{assert.equal(sid,f.sid);assert.equal(revision,f.policy.RevisionId);f.calls.push('remove');f.policy=null;},
 };
 f.resume=()=>{f.now+=61000;f.after.observedAt=new Date(f.now).toISOString();f.after.database.observedAt=f.after.observedAt;f.custody=f.encode();};
 return f;
}
const run=f=>runRegisteredRoutingRestoration(f.candidate,f.operator,f.custody,f.sourceText,f.port);
test('restores only the admitted route and exact permission; preserves original failure and never certifies rehearsal',async()=>{
 const f=fixture(),r=await run(f);assert.equal(r.restorationVerified,true);assert.equal(r.awsMutationPerformed,true);
 assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalFailure,f.events[13].code);
 assert(f.encode().journalBytes.subarray(0,f.original.journalBytes.length).equals(f.original.journalBytes));
 assert.equal(f.calls.filter(v=>v==='return').length,1);assert.equal(f.calls.filter(v=>v==='remove').length,1);
 assert.deepEqual(f.records,['registered_stopped_restoration_started','registered_stopped_return_admitted',
  'registered_stopped_permission_remove_admitted','registered_stopped_restoration_observed']);
 for(const k of ['retryPerformed','executionAdmissible','recoveryRehearsed','schemaChanged','deletionCertified','hostedAcceptance',
  'erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
});
test('durability is mandatory before either compensating write',async()=>{
 for(const stage of ['registered_stopped_return_admitted','registered_stopped_permission_remove_admitted']){
  const f=fixture(),old=f.port.record;f.port.record=async e=>{if(e.stage===stage)throw Error('disk unavailable');return old(e);};
  await assert.rejects(run(f));assert(!f.calls.includes(stage==='registered_stopped_return_admitted'?'return':'remove'));
 }
 const f=fixture();f.port.record=async()=>Buffer.from('not durable');await assert.rejects(run(f),/admission_durability/);assert(!f.calls.includes('return'));
});
test('lost successful replies are observed exactly once, never retried',async()=>{
 const f=fixture(),ret=f.port.returnLatest,rem=f.port.removePermission;
 f.port.returnLatest=async()=>{await ret();throw Error('lost reply');};f.port.removePermission=async(...a)=>{await rem(...a);throw Error('lost reply');};
 const r=await run(f);assert.equal(r.restorationVerified,true);assert.equal(f.calls.filter(v=>v==='return').length,1);assert.equal(f.calls.filter(v=>v==='remove').length,1);
});
test('lost unsuccessful replies stay held; a resumed observer does not reissue either uncertain mutation',async()=>{
 for(const kind of ['return','remove']){
  const f=fixture();if(kind==='return')f.port.returnLatest=async()=>{f.calls.push('return');throw Error('lost');};
  else f.port.removePermission=async()=>{f.calls.push('remove');throw Error('lost');};
  await assert.rejects(run(f));f.resume();const count=f.calls.filter(v=>v===kind).length;
  await assert.rejects(run(f));assert.equal(f.calls.filter(v=>v===kind).length,count);
 }
});
test('late successful return or removal can be observed on resumption without replaying writes',async()=>{
 for(const kind of ['return','remove']){
  const f=fixture(),ret=f.port.returnLatest,rem=f.port.removePermission;
  if(kind==='return')f.port.returnLatest=async()=>{throw Error('lost');};else f.port.removePermission=async()=>{throw Error('lost');};
  await assert.rejects(run(f));if(kind==='return')await ret();else await rem(f.sid,f.policy.RevisionId);
  f.resume();const before=f.calls.filter(v=>v===kind).length;const r=await run(f);
  assert.equal(r.restorationVerified,true);assert.equal(f.calls.filter(v=>v===kind).length,before);
 }
});
test('completed suffix still needs fresh real observations and retires no original failure',async()=>{
 const f=fixture();await run(f);f.resume();const writes=f.calls.filter(v=>['return','remove'].includes(v)).length;
 const r=await run(f);assert.equal(r.awsMutationPerformed,false);assert.equal(r.originalRunOutcome,'failed');
 assert.equal(f.calls.filter(v=>['return','remove'].includes(v)).length,writes);
 const parsed=await verifyInterruptedRegisteredReleaseCustody(f.encode(),f.candidate,f.sourceText,f.now,f.port.evidence);
 assert.equal(parsed.restoration.observed,true);assert.equal(parsed.originalFailure,f.events[13].code);
 const reconciled=await runRegisteredReleaseReconciliation(f.candidate,f.operator,f.encode(),f.sourceText,f.port);
 assert.equal(reconciled.awsMutationPerformed,false);assert.equal(reconciled.recoveryRehearsed,false);
});
test('complete authority is checked without rewriting a retained-route observation',()=>{
 const f=fixture(),w={...f.witness,after:f.after},bytes=canonical(w);
 const r=verifyCareRegisteredRestorationDeployment(w,f.candidate,f.current,f.sourceText,f.artifact,f.operator,f.now,f.now,'2');
 assert.equal(r.observedRoutingVersion,'2');assert.equal(canonical(w),bytes);
 assert.throws(()=>verifyCareRegisteredRestorationDeployment(w,f.candidate,f.current,f.sourceText,f.artifact,f.operator,f.now,f.now,'1'));
});
test('foreign routing, permission, code, database, execution or partial observations cannot admit writes',async()=>{
 for(const mutate of [f=>f.after.raw.integrations.Items[0].IntegrationUri=R.latestArn+':1',
  f=>f.policy.Policy=JSON.stringify({Version:'2012-10-17',Statement:[{Sid:'foreign'}]}),
  f=>f.policy=null,f=>f.after.raw.fn.RevisionId+='changed',f=>f.after.raw.fn.Timeout++,
  f=>f.retained.configuration.Timeout++,f=>f.retained.sha256='0'.repeat(64),
  f=>f.after.raw.routes.Items.pop(),f=>f.after.raw.role.Role.AssumeRolePolicyDocument.Statement.push({Effect:'Allow'}),
  f=>f.after.summary.ExecutionStatus='EXECUTE_IN_PROGRESS',f=>f.after.raw.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',
  f=>f.port.latest=async()=>Buffer.from('foreign'),f=>f.after.database.catalogInspection.referenceMigrationCount++,
  f=>f.port.storage=async()=>({state:'absent_at_observation'}),f=>f.port.apiDeployment=async id=>({DeploymentId:id,DeploymentStatus:'PENDING'})]){
  const f=fixture();mutate(f);await assert.rejects(run(f));assert(!f.calls.includes('return'));assert(!f.calls.includes('remove'));
 }
});
test('source, custody, rebuilt bytes, active writers and identity changes refuse before restoration',async()=>{
 for(const mutate of [f=>f.port.writerStopped=async()=>false,f=>f.port.rebuild=async()=>({byteVerified:true,sourceRebuilt:false}),
  f=>f.port.applicationCurrent=async()=>f.operator,f=>f.port.custody=async()=>({...f.encode(),journalBytes:Buffer.from('{}\n')}),
  f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`,f=>{let i=0;f.port.identity=async()=>({...f.caller,UserId:String(++i)});}]){
  const f=fixture();mutate(f);await assert.rejects(run(f));assert(!f.calls.includes('return'));
 }
 const f=fixture();await run(f);f.resume();f.port.writerStopped=async pid=>pid!==f.port.pid;await assert.rejects(run(f),/restoration_writer_active/);
});
test('drift during final readback cannot turn cleanup into a successful restoration receipt',async()=>{
 for(const kind of ['database','function','permission','stage']){
  const f=fixture(),old=f.port.control;f.port.control=async()=>{if(f.calls.includes('remove')){
   if(kind==='database')f.after.database.catalogInspection.dataSha256='0'.repeat(64);
   if(kind==='function')f.after.raw.fn.RevisionId+='changed';if(kind==='permission')f.policy={RevisionId:'foreign',Policy:'{}'};
   if(kind==='stage')f.after.raw.stage.DeploymentId='foreign';}return old();};
  await assert.rejects(run(f));assert(!f.records.includes('registered_stopped_restoration_observed'));
 }
});
test('suffix integrity refuses duplicate, reordered, forged or stale source admissions',async()=>{
 const f=fixture();await run(f);f.resume();const original=structuredClone(f.events);
 for(const mutate of [rows=>rows[14].originalJournalSha256='0'.repeat(64),rows=>rows[14].operatorSource.mobile.source.commit='0'.repeat(40),
  rows=>rows[14].extra=true,rows=>rows[15].previousDeployment='',rows=>rows[16].revision='',
  rows=>rows.push(rows[15]),rows=>rows.splice(15,0,rows[16]),rows=>rows[17].databaseSha256='wrong']){
  const rows=structuredClone(original);mutate(rows);const bytes=Buffer.from(rows.map(v=>JSON.stringify(v)).join('\n')+'\n');
  assert.throws(()=>splitRegisteredRestorationJournal(bytes,f.current,f.now));
 }
});
test('durable receipt and original lock archive precede local custody retirement',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-restoration-'));try{
  const f=fixture(),r=await run(f),guard=acquireRegisteredUploadReconciliationGuard(root,f.operator),
   c={...f.encode(),out:root,lock:resolve(root,'operator.lock'),journal:resolve(root,'original.events.jsonl'),guard};
  writeFileSync(c.lock,c.lockBytes);writeFileSync(c.journal,c.journalBytes);
  assert.throws(()=>archiveRegisteredRestoredLock(c,{...r,recoveryRehearsed:true}));assert(existsSync(c.lock));
  const result=archiveRegisteredRestoredLock(c,r);assert(!existsSync(c.lock));assert(readFileSync(result.archive).equals(c.lockBytes));
  assert(readFileSync(c.journal).subarray(0,f.original.journalBytes.length).equals(f.original.journalBytes));
  assert.equal(JSON.parse(readFileSync(result.receipt)).hostedAcceptance,false);guard.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('public operator has only the fixed compensating mutations, not a deployment, permission grant, schema or build port',()=>{
 const a=['--v2-root','.','--artifact','.','--application-root','.','--restore-fictional-registered-routing-only'];registeredRoutingRestorationArguments(a);
 for(const b of [[],[...a,'--execute'],[...a,'--profile','prod'],[...a,'--report','approved'],[...a,'--phi']])assert.throws(()=>registeredRoutingRestorationArguments(b));
 const source=readFileSync(new URL('./restore-synthetic-care-registered-routing.mjs',import.meta.url),'utf8');
 assert.match(source,/'update-integration'/);assert.match(source,/'remove-permission'/);assert.match(source,/'--revision-id',revision/);
 assert.doesNotMatch(source,/'execute-change-set'|'update-function-code'|'add-permission'|'publish-version'|new ExecuteStatementCommand|new PutObjectCommand|new DeleteObjectCommand/);
 assert.match(source,/AWS_MAX_ATTEMPTS:'1'/);assert.match(source,/AWS_ENDPOINT_URL/);
});
test('dead inspection guards require exact encoding, a stopped process and settlement; they are never deployment authority',()=>{
 const row={purpose:'registered-upload-reconciliation',pid:2000000000,runId:'4'.repeat(32),operator:'5'.repeat(40)},
  bytes=Buffer.from(JSON.stringify(row)+'\n');verifyStoppedRegisteredInspectionGuard(bytes,1000,61000,()=>true);
 for(const mutate of [r=>r.extra=true,r=>r.purpose='registered-artifact-upload-release',r=>r.pid=0,r=>r.runId='foreign',r=>r.operator='foreign']){
  const r=structuredClone(row);mutate(r);assert.throws(()=>verifyStoppedRegisteredInspectionGuard(Buffer.from(JSON.stringify(r)+'\n'),1000,61000,()=>true));
 }
 assert.throws(()=>verifyStoppedRegisteredInspectionGuard(bytes,1000,60999,()=>true));
 assert.throws(()=>verifyStoppedRegisteredInspectionGuard(bytes,1000,61000,()=>false));
 assert.throws(()=>verifyStoppedRegisteredInspectionGuard(Buffer.from(bytes.toString().replace('"pid":','"pid":1,"pid":')),1000,61000,()=>true));
});
test('Windows kernel mutex excludes a second operator and permits a fresh owner after release',{skip:process.platform!=='win32'},async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-restoration-mutex-'));let first,second;try{
  first=await acquireRegisteredRestorationMutex(root);first.verify();
  await assert.rejects(acquireRegisteredRestorationMutex(root),/mutex_busy/);await first.close();first=undefined;
  second=await acquireRegisteredRestorationMutex(root);second.verify();await second.close();second=undefined;
 }finally{await first?.close();await second?.close();rmSync(root,{recursive:true,force:true});}
});
test('Windows stale inspection recovery archives only the dead helper guard, never the admitted original lock',{skip:process.platform!=='win32'},async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-inspection-recovery-'));let guard;try{
  const f=fixture(),file=resolve(root,'registered-upload-reconciliation.lock'),original=resolve(root,'operator.lock'),
   row={purpose:'registered-upload-reconciliation',pid:2000000000,runId:'4'.repeat(32),operator:f.operator.desktop.commit},bytes=Buffer.from(JSON.stringify(row)+'\n');
  writeFileSync(file,bytes);writeFileSync(original,f.original.lockBytes);const old=new Date(Date.now()-61000);utimesSync(file,old,old);
  guard=await acquireRecoverableRegisteredInspectionGuard(root,f.operator);guard.verify();
  assert(readFileSync(original).equals(f.original.lockBytes));assert(readFileSync(resolve(root,'registered-inspection-abandoned-'+sha256(bytes)+'.json')).equals(bytes));
  assert.notDeepEqual(readFileSync(file),bytes);await guard.close();guard=undefined;
  assert(!existsSync(file));assert(readFileSync(original).equals(f.original.lockBytes));
 }finally{await guard?.close();rmSync(root,{recursive:true,force:true});}
});
test('Windows mutex is relinquished after the actual parent process is killed, without a file-unlock claim',{skip:process.platform!=='win32'},async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-restoration-process-loss-'));let parent,mutex;try{
  const moduleUrl=new URL('./care-registered-restoration-guard.mjs',import.meta.url).href,
   code=`const {acquireRegisteredRestorationMutex}=await import(${JSON.stringify(moduleUrl)}); const mutex=await acquireRegisteredRestorationMutex(${JSON.stringify(root)}); mutex.verify(); console.log('parent-owned'); await new Promise(()=>{});`;
  parent=spawn(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(done=>parent.once('exit',done));parent.stderr.resume();
  await new Promise((done,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('parent timeout')),10000);
   parent.once('error',e=>{clearTimeout(timer);reject(e);});parent.stdout.on('data',bytes=>{text+=bytes.toString();
    if(text.includes('parent-owned')){clearTimeout(timer);done();}});});
  await assert.rejects(acquireRegisteredRestorationMutex(root),/mutex_busy/);parent.kill();await exited;parent=undefined;
  for(let n=0;n<5;n++){try{mutex=await acquireRegisteredRestorationMutex(root);break;}catch(e){
   if(!e.message.endsWith(':restoration_guard_mutex_busy'))throw e;await new Promise(done=>setTimeout(done,200));}}
  assert(mutex,'kernel mutex still owned after parent loss');mutex.verify();await mutex.close();mutex=undefined;
 }finally{parent?.kill();await mutex?.close();rmSync(root,{recursive:true,force:true});}
});
