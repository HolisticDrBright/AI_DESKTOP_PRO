import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {careRegisteredDeploymentFixture} from './test-fixtures/care-registered-deployment.mjs';
import {verifyCareRegisteredReconciledDeployment} from './care-registered-deployment.mjs';
import {acquireRegisteredUploadReconciliationGuard} from './reconcile-synthetic-care-registered-upload.mjs';
import {registeredReleaseReconciliationArguments,verifyInterruptedRegisteredReleaseCustody,
 runRegisteredReleaseReconciliation,archiveReconciledReleaseLock,readRegisteredReleaseEvidence,
 registeredReconciliationAwsDiagnostic} from './reconcile-synthetic-care-registered-release.mjs';
test('reconciliation AWS diagnostics name finite phases and reasons without retaining provider content',()=>{
 for(const [args,phase] of [[['lambda','get-policy'],'retained_policy'],[['lambda','get-function-configuration'],'retained_configuration'],
  [['apigatewayv2','get-deployment'],'api_deployment'],[['cloudformation','list-change-sets'],'proposal_listing'],
  [['cloudformation','get-template'],'proposal_template'],[['cloudformation','describe-change-set'],'proposal_projection'],[[],'unknown']]){
  const result=registeredReconciliationAwsDiagnostic(args,{code:'ETIMEDOUT',stderr:'Bearer private-token email@example.test'});
  assert.equal(result,'release_reconciliation_aws_'+phase+'_timeout_unconfirmed');
  assert.doesNotMatch(result,/Bearer|private-token|email@/);
 }
 for(const [error,reason] of [[{code:'ENOBUFS'},'output_limit'],[{code:'ENOBUFS',signal:'SIGTERM'},'output_limit'],
  [{signal:'SIGTERM'},'terminated'],[{name:'SyntaxError'},'json'],
  [{stderr:'aws: [ERROR]: An error occurred (AccessDeniedException) when calling the GetPolicy operation: private'},'access_denied'],
  [{stderr:'aws: [ERROR]: An error occurred (AccessDeniedException) when calling the GetPolicy operation (reached max retries: 0): private'},'access_denied'],
  [{stderr:'aws: [ERROR]: An error occurred (AccessDeniedException) when calling the GetPolicy operation (reached max retries: 1): private'},'unknown'],
  [{stderr:'ResourceNotFoundException private'},'unknown'],[{stderr:'x'.repeat(65537)},'unknown'],[{},'unknown']])
  assert.equal(registeredReconciliationAwsDiagnostic(['lambda','get-policy'],error),'release_reconciliation_aws_retained_policy_'+reason+'_unconfirmed');
});
function fixture(){
 const f=careRegisteredDeploymentFixture();f.operator=structuredClone(f.current);f.operator.desktop.commit='1'.repeat(40);f.operator.desktop.sha256='2'.repeat(64);
 f.now=f.completed+600000;f.before2=structuredClone(f.before);
 f.after.observedAt=new Date(f.now).toISOString();f.after.database.observedAt=f.after.observedAt;
 f.after.database.operatorSource={sourceCommit:f.operator.desktop.commit,clean:true};
 const {binding}=f.before,token=sha256(canonical({contract:'care-registered-execution-input/1',binding,current:f.current,artifact:f.artifact}));
 f.lock={purpose:'registered-artifact-upload-release',pid:1234567,runId:'3'.repeat(32),desktop:f.current.desktop,mobile:f.current.mobile};
 const event=(stage,detail={},time=f.now-600000)=>({at:new Date(time).toISOString(),stage,...detail});
 f.admission={at:f.witness.executionAdmittedAt,stage:'registered_change_execute_admitted',stackId:binding.stackId,
  changeSetId:binding.id,clientToken:token,beforeSha256:sha256(canonical(f.before2)),artifact:f.artifact,current:f.current};
 f.files=new Map([['before1',Buffer.from(JSON.stringify(f.before,null,2)+'\n')],
  ['before2',Buffer.from(JSON.stringify(f.before2,null,2)+'\n')],['admission',Buffer.from(JSON.stringify(f.admission,null,2)+'\n')]]);
 f.events=[event('registered_upload_started',{runId:f.lock.runId},f.started),
  event('registered_live_preflight_verified',{observedAt:new Date(f.started).toISOString()},f.started),
  event('registered_artifact_put_admitted',{key:f.candidate.manifest.key,sha256:f.candidate.manifest.zipSha256},f.started),
  event('registered_artifact_exact_version_verified',{artifact:f.artifact},f.started),
  event('registered_change_set_create_admitted',{stackId:binding.stackId,name:binding.name,clientToken:binding.digest},f.started),
  event('registered_change_set_observed',{id:binding.id,name:binding.name,reused:false},f.started),
  event('registered_change_set_verified_unexecuted',{id:binding.id,summarySha256:sha256(canonical(f.before.summary)),propertyValuesSha256:sha256(canonical(f.before.detailed))},f.started),
  event('registered_execution_before_archived',{file:'before1',sha256:sha256(f.files.get('before1'))},f.now-600000-30000),
  event('registered_execution_before_archived',{file:'before2',sha256:sha256(f.files.get('before2'))},f.now-600000-30000),
  {...f.admission,admissionFile:'admission',admissionSha256:sha256(canonical(f.admission))}];
 // Admission event does not contain the separately archived extra fields.
 for(const k of ['beforeSha256','artifact','current'])delete f.events.at(-1)[k];
 f.encode=()=>({lockBytes:Buffer.from(JSON.stringify(f.lock)+'\n'),journalBytes:Buffer.from(f.events.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 f.custody=f.encode();f.calls=[];
 f.retained={configuration:{...structuredClone(f.before.raw.fn),Version:'2',FunctionArn:f.before.raw.fn.FunctionArn+':2'},sha256:f.candidate.release.predecessor.zipSha256,
  bytes:f.candidate.release.predecessor.bytes,policy:null};
 f.caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 f.port={now:()=>f.now,evidence:async file=>f.files.get(file),identity:async()=>structuredClone(f.caller),
  current:async()=>structuredClone(f.operator),applicationCurrent:async()=>structuredClone(f.current),writerStopped:async()=>true,custody:async()=>f.encode(),
  rebuild:async()=>({byteVerified:true,sourceRebuilt:true,zipSha256:f.candidate.manifest.zipSha256,
   desktopCommit:f.current.desktop.commit,mobileCommit:f.current.mobile.source.commit,liveTargetObserved:false,deployed:false,phiAllowed:false}),
  database:async()=>{f.calls.push('database');return structuredClone(f.after.database);},control:async()=>{f.calls.push('control');return structuredClone(f.after.raw);},
  proposal:async b=>{assert.deepEqual(b,binding);f.calls.push('proposal');return {summary:structuredClone(f.after.summary),detailed:structuredClone(f.after.detailed),template:structuredClone(f.after.template)};},
  latest:async()=>{f.calls.push('download');return Buffer.from(f.candidate.zip);},retainedPolicy:async()=>null,retained:async()=>structuredClone(f.retained),
  apiDeployment:async id=>({DeploymentId:id,DeploymentStatus:'DEPLOYED'}),
  storage:async()=>{f.calls.push('storage');return {state:'stored_exact_version',bytesVerified:true,versionId:f.artifact.versionId,
   sha256:f.candidate.manifest.zipSha256,bytes:f.candidate.manifest.zipBytes,deletionCertified:false};}};
 return f;
}
const run=f=>runRegisteredReleaseReconciliation(f.candidate,f.operator,f.custody,f.sourceText,f.port);
function unexecuted(length=9){
 const f=fixture();f.events=f.events.slice(0,length);f.custody=f.encode();f.after.raw=structuredClone(f.before.raw);
 f.after.summary=structuredClone(f.before.summary);f.after.detailed=structuredClone(f.before.detailed);f.after.template=structuredClone(f.before.template);
 f.port.predecessor=async()=>({sha256:f.candidate.release.predecessor.zipSha256,bytes:f.candidate.release.predecessor.bytes,exactBytesVerified:true});
 f.port.list=async()=>({Summaries:[{ChangeSetName:f.before.binding.name,ChangeSetId:f.before.binding.id}]});
 return f;
}
test('every interrupted pre-execution prefix is independently observed without relabeling it as execution',async()=>{
 for(let n=1;n<=9;n++){
  const f=unexecuted(n),r=await run(f);assert.equal(r.scope,'before_execution');assert.equal(r.deployed,false);
  assert.equal(r.originalPutOutcome,'unknown');assert.equal(r.recoveryRehearsed,false);
  assert.equal(f.calls.filter(v=>v==='database').length,2);assert.equal(f.calls.filter(v=>v==='storage').length,2);
 }
});
test('admitted creation without a reply must be located as the exact available proposal; absence or execution stays held',async()=>{
 for(const mutate of [f=>f.port.list=async()=>({Summaries:[]}),f=>f.port.list=async()=>({Summaries:[],NextToken:'more'}),
  f=>f.port.list=async()=>({Summaries:[{ChangeSetName:f.before.binding.name,ChangeSetId:'foreign'}]}),
  f=>f.after.summary.ExecutionStatus='EXECUTE_COMPLETE',f=>f.after.detailed.Status='CREATE_IN_PROGRESS',
  f=>f.port.predecessor=async()=>({sha256:'0'.repeat(64),bytes:f.candidate.release.predecessor.bytes,exactBytesVerified:true}),
  f=>f.port.storage=async()=>({state:'absent_at_observation',deletionCertified:false})]){
  const f=unexecuted(5);mutate(f);await assert.rejects(run(f));
 }
});
test('an unconfirmed early PUT may remain absent or become exact, never a deletion or original-response certificate',async()=>{
 const f=unexecuted(3);f.port.storage=async()=>({state:'absent_at_observation',versionId:null,bytesVerified:false,
  originalPutOutcome:'unknown',deletionCertified:false});const r=await run(f);
 assert.equal(r.storage.state,'absent_at_observation');assert.equal(r.originalPutOutcome,'unknown');assert.equal(r.deletionCertified,false);
 const x=unexecuted(4);x.port.storage=f.port.storage;await assert.rejects(run(x));
});
test('early failure admission attribution and unsupported suffixes cannot be hidden by a valid prefix',async()=>{
 const f=unexecuted(3);f.events.push({at:new Date(f.completed).toISOString(),stage:'registered_upload_finding',
  code:'synthetic_care_registered_release_refused:upload_transport_put_timeout',writeAdmitted:true});f.custody=f.encode();
 const r=await run(f);assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalFailure,f.events.at(-1).code);
 f.events.at(-1).writeAdmitted=false;f.custody=f.encode();await assert.rejects(run(f));
 for(const stage of ['registered_recovery_cases_verified','registered_code_recovery_completed','registered_upload_completed']){
  const x=unexecuted(7);x.events.push({at:new Date(x.completed).toISOString(),stage,...(stage==='registered_recovery_cases_verified'
   ?{caseCount:105,version:'2'}:stage==='registered_code_recovery_completed'?{file:'saved'}:{receipt:'saved'})});x.custody=x.encode();await assert.rejects(run(x));
 }
});
test('a lost execution reply and stopped writer require two actual complete readbacks, not a replay',async()=>{
 const f=fixture(),r=await run(f);
 assert.equal(r.originalRunOutcome,'interrupted');assert.equal(r.originalFailure,null);assert.equal(r.deployed,true);
 assert.equal(r.operatorSource.desktop.commit,f.operator.desktop.commit);assert.equal(r.applicationSource.desktop.commit,f.current.desktop.commit);
 assert.equal(f.calls.filter(v=>v==='download').length,2);assert.equal(f.calls.filter(v=>v==='database').length,2);
 assert.equal(f.calls.filter(v=>v==='proposal').length,2);assert.equal(f.calls.filter(v=>v==='storage').length,2);
 for(const key of ['retryPerformed','awsMutationPerformed','deletionCertified','executionAdmissible','recoveryRehearsed',
  'hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[key],false);
});
test('the original failed result stays failed even after AWS independently shows a restored successor',async()=>{
 const f=fixture();f.events.push({at:new Date(f.completed).toISOString(),stage:'registered_upload_finding',
  code:'synthetic_care_registered_release_refused:routing_restoration_unconfirmed',writeAdmitted:true});f.custody=f.encode();
 const r=await run(f);assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalFailure,f.events.at(-1).code);
 assert.equal(r.routeRestoredAtObservation,true);assert.equal(r.recoveryRehearsed,false);
});

test('a recorded finite principal refusal can be reconciled only through fresh identity and complete observations',async()=>{
 const f=fixture();f.events.push({at:new Date(f.completed).toISOString(),stage:'registered_upload_finding',
  code:'synthetic_member_principal_refused',writeAdmitted:true});f.custody=f.encode();
 const original=Buffer.from(f.custody.journalBytes),r=await run(f);
 assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalFailure,'synthetic_member_principal_refused');
 assert.equal(r.deployed,true);assert.equal(r.recoveryRehearsed,false);assert.equal(r.awsMutationPerformed,false);
 assert.equal(f.custody.journalBytes.equals(original),true);
 const foreign=fixture();foreign.events=structuredClone(f.events);foreign.custody=foreign.encode();
 foreign.port.identity=async()=>({Account:'173535830222',Arn:'arn:aws:iam::173535830222:root'});
 await assert.rejects(run(foreign),/synthetic_member_principal_refused/);
 for(const code of ['synthetic_member_principal_refused_extra','synthetic_member_principal_refused:detail',
  'Bearer private-value','synthetic_care_intent_release_refused:foreign']){
  const x=fixture();x.events=structuredClone(f.events);x.events.at(-1).code=code;x.custody=x.encode();
  await assert.rejects(run(x),/release_reconciliation_failure/);
 }
});

test('historical database read may precede its enclosing snapshot without losing the original freshness bounds',async()=>{
 const prepare=()=>{
  const f=fixture();for(const [name,b] of [['before1',f.before],['before2',f.before2]]){
   b.database.observedAt=new Date(Date.parse(b.observedAt)-1000).toISOString();
   f.files.set(name,Buffer.from(JSON.stringify(b,null,2)+'\n'));
  }
  f.admission.beforeSha256=sha256(canonical(f.before2));
  f.files.set('admission',Buffer.from(JSON.stringify(f.admission,null,2)+'\n'));
  f.events.find(e=>e.file==='before1').sha256=sha256(f.files.get('before1'));
  f.events.find(e=>e.file==='before2').sha256=sha256(f.files.get('before2'));
  f.events.at(-1).admissionSha256=sha256(canonical(f.admission));f.custody=f.encode();return f;
 };
 const f=prepare(),r=await run(f);assert.equal(r.deployed,true);assert.equal(r.recoveryRehearsed,false);
 for(const offset of [1,-300001]){
  const x=prepare();x.before.database.observedAt=new Date(Date.parse(x.before.observedAt)+offset).toISOString();
  x.files.set('before1',Buffer.from(JSON.stringify(x.before,null,2)+'\n'));
  x.events.find(e=>e.file==='before1').sha256=sha256(x.files.get('before1'));x.custody=x.encode();
  await assert.rejects(run(x),/database_freshness/);
 }
});
test('a failed recovery suffix is checked in order but never becomes successful recovery evidence',async()=>{
 const f=fixture(),id=f.before.binding.id,at=new Date(f.completed).toISOString();
 f.events.push(...[
  {stage:'registered_change_execute_reply_unconfirmed',changeSetId:id},
  {stage:'registered_change_execute_terminal',changeSetId:id,replyLost:true},
  {stage:'registered_deployed_bytes_control_verified',changeSetId:id,revision:f.after.raw.fn.RevisionId,zipSha256:f.candidate.manifest.zipSha256},
  {stage:'registered_deployment_readback_archived',file:'deployment'},
  {stage:'registered_recovery_permission_admitted',version:'2',sid:'alp-care-intent-recovery-'+'a'.repeat(32)},
  {stage:'registered_recovery_switch_admitted',version:'2'},
  {stage:'registered_recovery_compensating_return_admitted',version:'2'},
  {stage:'registered_recovery_permission_cleanup_admitted',version:'2'},
  {stage:'registered_recovery_route_permission_restored'},
  {stage:'registered_upload_finding',code:'synthetic_care_registered_release_refused:routing_live_metric_unconfirmed',writeAdmitted:true},
 ].map(e=>({at,...e})));f.custody=f.encode();
 const r=await run(f);assert.equal(r.originalRunOutcome,'failed');assert.equal(r.recoveryRehearsed,false);
 for(const mutate of [rows=>rows[14].version='1',rows=>rows[14].sid='foreign',rows=>rows[12].zipSha256='0'.repeat(64),
  rows=>rows.splice(15,1),rows=>rows.splice(18,0,{at,stage:'registered_recovery_cases_verified',caseCount:105,version:'2'})]){
  const x=fixture();x.events=structuredClone(f.events);mutate(x.events);x.custody=x.encode();await assert.rejects(run(x));
 }
});
test('an archived before or admission changing after its initial parse prevents settlement',async()=>{
 for(const file of ['before1','before2','admission']){
  const f=fixture(),old=f.port.rebuild;f.port.rebuild=async()=>{const r=await old();f.files.set(file,Buffer.from('{}\n'));return r;};
  await assert.rejects(run(f),/archived_evidence_changed/);
 }
});
test('evidence files stay in the exact operations directory and bind their digest-bearing names',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-release-evidence-'));try{
  const f=fixture(),bytes=f.files.get('before1'),file=resolve(root,f.candidate.manifest.zipSha256+'.before-'+sha256(canonical(f.before))+'.json');
  writeFileSync(file,bytes);assert(readRegisteredReleaseEvidence(root,f.candidate,file,'before').equals(bytes));
  for(const [path,kind] of [[file,'admission'],[file,'other'],[resolve(root,'../'+file.split(/[\\/]/).at(-1)),'before']])
   assert.throws(()=>readRegisteredReleaseEvidence(root,f.candidate,path,kind));
  writeFileSync(file,'{}\n');assert.throws(()=>readRegisteredReleaseEvidence(root,f.candidate,file,'before'),/evidence_digest_name/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('new operator attribution is verified separately without editing the historical or actual observation',()=>{
 const f=fixture(),w={...f.witness,after:f.after},before=canonical(w);
 const r=verifyCareRegisteredReconciledDeployment(w,f.candidate,f.current,f.sourceText,f.artifact,f.operator,f.now,f.now);
 assert.equal(r.operatorSource.desktop.commit,f.operator.desktop.commit);assert.equal(canonical(w),before);
 for(const kind of ['migration','mobile','template','old_observation','operator']){
  const x=fixture();if(kind==='migration')x.operator.migrations.sha256='0'.repeat(64);
  if(kind==='mobile')x.operator.mobile.source.commit='0'.repeat(40);if(kind==='template')x.operator.templateSha256='0'.repeat(64);
  if(kind==='old_observation')x.after.observedAt=new Date(x.now-1).toISOString();
  if(kind==='operator')x.after.database.operatorSource.sourceCommit=x.current.desktop.commit;
  assert.throws(()=>verifyCareRegisteredReconciledDeployment({...x.witness,after:x.after},x.candidate,x.current,x.sourceText,x.artifact,x.operator,x.now,x.now));
 }
});
test('custody grammar refuses duplicate keys, unknown stages, changed digests and reordered or stale admissions',async()=>{
 for(const mutate of [f=>f.lock.purpose='registered-artifact-upload-proposal',f=>f.lock.mobile.source.commit='0'.repeat(40),
  f=>f.lock.extra=true,f=>f.events.splice(6,1),f=>f.events[7].sha256='0'.repeat(64),f=>f.events.at(-1).clientToken='0'.repeat(64),
  f=>f.events.at(-1).admissionSha256='0'.repeat(64),f=>f.events.at(-1).extra=true,f=>f.events.push({at:new Date(f.completed).toISOString(),stage:'something_verified'}),
  f=>f.events.reverse(),f=>f.files.set('admission',Buffer.from('{}\n')),f=>f.files.set('before2',Buffer.from('{}\n')),
  f=>f.events[6].summarySha256='0'.repeat(64),f=>f.events.at(-1).at=new Date(f.now+1).toISOString(),
  f=>f.now=Date.parse(f.events.at(-1).at)+59000]){
  const f=fixture();mutate(f);await assert.rejects(verifyInterruptedRegisteredReleaseCustody(f.encode(),f.candidate,f.sourceText,f.now,f.port.evidence));
 }
 const f=fixture(),c=f.encode();c.lockBytes=Buffer.from(c.lockBytes.toString().replace('"pid":','"pid":1,"pid":'));
 await assert.rejects(verifyInterruptedRegisteredReleaseCustody(c,f.candidate,f.sourceText,f.now,f.port.evidence));
});
test('active writers, changed custody or principals, root credentials and unrebuilt sources never settle',async()=>{
 for(const mutate of [f=>f.port.writerStopped=async()=>false,f=>f.port.custody=async()=>({lockBytes:Buffer.from('{}'),journalBytes:f.custody.journalBytes}),
  f=>f.port.rebuild=async()=>({byteVerified:true,sourceRebuilt:false}),f=>f.port.applicationCurrent=async()=>f.operator,
  f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`,f=>{let i=0;f.port.identity=async()=>({...f.caller,UserId:String(++i)});},
  f=>f.port.current=async()=>({...f.operator,desktop:{...f.operator.desktop,clean:false}})]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
});
test('unfinished execution, retained routing, temporary permission, byte drift or foreign authority leave custody held',async()=>{
 for(const mutate of [f=>f.after.raw.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',f=>f.after.summary.ExecutionStatus='EXECUTE_IN_PROGRESS',
  f=>f.after.detailed.ExecutionStatus='AVAILABLE',f=>f.port.retainedPolicy=async()=>({Policy:'permission still installed'}),
  f=>f.retained.policy={Policy:'other permission'},f=>f.retained.sha256='0'.repeat(64),f=>f.retained.configuration.Timeout++,
  f=>f.port.latest=async()=>Buffer.from('not candidate'),f=>f.after.raw.integrations.Items[0].IntegrationUri+=':2',
  f=>f.after.raw.routes.Items.pop(),f=>f.after.raw.fn.Environment.Variables.PHI_ALLOWED='true',
  f=>f.port.apiDeployment=async id=>({DeploymentId:id,DeploymentStatus:'PENDING'}),
  f=>f.after.database.catalogInspection.referenceMigrationCount++,f=>f.port.storage=async()=>({state:'absent_at_observation'})]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
});
test('late storage, function, stage or database changes fail the second complete observation',async()=>{
 for(const kind of ['storage','function','stage','database']){
  const f=fixture();let n=0;
  if(kind==='storage'){const old=f.port.storage;f.port.storage=async()=>{const r=await old();if(++n===2)r.versionId='changed';return r;};}
  if(kind==='function'||kind==='stage'){const old=f.port.control;f.port.control=async()=>{const r=await old();if(++n===2){
   if(kind==='function')r.fn.RevisionId+='changed';else {r.stage.DeploymentId='changed';r.stage.LastDeploymentStatusMessage="Successfully deployed stage with deployment ID 'changed'";}}return r;};}
  if(kind==='database'){const old=f.port.database;f.port.database=async()=>{const r=await old();if(++n===2)r.catalogInspection.dataSha256='0'.repeat(64);return r;};}
  await assert.rejects(run(f));
 }
});
test('archive durability precedes retirement of the local lock; original journal and failure remain unchanged',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-release-reconciliation-'));try{
  const f=fixture(),report=await run(f),guard=acquireRegisteredUploadReconciliationGuard(root,f.operator),
   c={...f.custody,lock:resolve(root,'operator.lock'),journal:resolve(root,'original.events.jsonl'),out:root,guard};
  writeFileSync(c.lock,c.lockBytes);writeFileSync(c.journal,c.journalBytes);const r=archiveReconciledReleaseLock(c,report);
  assert.equal(existsSync(c.lock),false);assert(readFileSync(r.archive).equals(c.lockBytes));assert(readFileSync(c.journal).equals(c.journalBytes));
  assert.equal(JSON.parse(readFileSync(r.receipt)).recoveryRehearsed,false);
  writeFileSync(c.lock,c.lockBytes);writeFileSync(c.journal,'changed');assert.throws(()=>archiveReconciledReleaseLock(c,report));assert.equal(existsSync(c.lock),true);
  writeFileSync(c.journal,c.journalBytes);assert.throws(()=>archiveReconciledReleaseLock({...c,out:resolve(root,'missing')},report));assert.equal(existsSync(c.lock),true);
  assert.throws(()=>archiveReconciledReleaseLock(c,{...report,recoveryRehearsed:true}));guard.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('public entry point constructs actual fixed read-only clients and cannot load a target, report or perform a write',()=>{
 const flag='--reconcile-fictional-registered-execution-only',a=['--v2-root','.','--artifact','.','--application-root','.',flag];
 registeredReleaseReconciliationArguments(a);
 for(const value of [[],[...a,'--execute'],[...a,'--report','fake'],[...a,'--phi'],[...a,'--profile','prod']])assert.throws(()=>registeredReleaseReconciliationArguments(value));
 const text=readFileSync(new URL('./reconcile-synthetic-care-registered-release.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(text,/'execute-change-set'|'update-integration'|'add-permission'|'remove-permission'|'update-function-code'|new PutObjectCommand|new DeleteObjectCommand/);
 assert.match(text,/inspectCareRegisteredArtifact\(applicationRoot,mobileRoot,artifactDirectory\)/);
 assert.match(text,/downloadIntentFunction\(fn,candidate\)/);assert.match(text,/buildCareRegisteredDatabaseObserver\(root,operator\)/);
 assert.match(text,/AWS_ENDPOINT_URL/);assert.match(text,/AWS_MAX_ATTEMPTS:'1'/);
});
