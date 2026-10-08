import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {careRegisteredControlFixture} from './test-fixtures/care-registered-control.mjs';
import {careRegisteredCodeTemplateInputs,careRegisteredChangeSetBinding} from './care-registered-code-change.mjs';
import {acquireRegisteredUploadReconciliationGuard} from './reconcile-synthetic-care-registered-upload.mjs';
import {registeredProposalReconciliationArguments,verifyFailedRegisteredProposalCustody,
 runRegisteredProposalReconciliation,archiveReconciledProposalLock} from './reconcile-synthetic-care-registered-proposal.mjs';
function fixture(){
 const f=careRegisteredControlFixture(),{current,raw,artifact}=f;f.now+=120000;
 f.operator=structuredClone(current);f.operator.desktop.commit='1'.repeat(40);f.operator.desktop.sha256='2'.repeat(64);
 f.input=careRegisteredCodeTemplateInputs(f.sourceText,f.candidate,current,artifact);
 const fixed=careRegisteredChangeSetBinding(f.input,current,artifact);
 f.binding={...fixed,id:`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${fixed.name}/fictional-id`};
 f.lock={purpose:'registered-artifact-upload-proposal',pid:1234567,runId:'3'.repeat(32),desktop:current.desktop,mobile:current.mobile};
 f.events=[{stage:'registered_upload_started',runId:f.lock.runId},
  {stage:'registered_live_preflight_verified',observedAt:'2026-10-08T05:59:00.000Z'},
  {stage:'registered_artifact_put_admitted',key:f.candidate.manifest.key,sha256:f.candidate.manifest.zipSha256},
  {stage:'registered_artifact_exact_version_verified',artifact},
  {stage:'registered_change_set_create_admitted',stackId:fixed.stackId,name:fixed.name,clientToken:fixed.digest},
  {stage:'registered_change_set_observed',id:f.binding.id,name:fixed.name,reused:false},
  {stage:'registered_upload_finding',code:'synthetic_care_registered_release_refused:proposal_property_delta',writeAdmitted:true}]
  .map((e,i)=>({at:new Date(Date.parse('2026-10-08T05:59:00Z')+i*1000).toISOString(),...e}));
 f.encode=()=>({lockBytes:Buffer.from(JSON.stringify(f.lock)+'\n'),journalBytes:Buffer.from(f.events.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 f.custody=f.encode();
 const lambda={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'DirectModification'},
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'}]}};
 const dependency={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,
  ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}};
 const parameters=structuredClone(raw.stack.Stacks[0].Parameters);parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=artifact.key;
 f.summary={StackId:fixed.stackId,StackName:P.stack,ChangeSetName:fixed.name,ChangeSetId:f.binding.id,
  Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',Capabilities:['CAPABILITY_IAM'],NotificationARNs:[],RollbackConfiguration:{},
  DeploymentConfig:{Mode:'STANDARD',DisableRollback:false},Parameters:parameters,Changes:[lambda,dependency],
  Description:`Registered synthetic code ${current.desktop.commit}; PHI off; no schema change`,CreationTime:new Date(f.now-1000).toISOString()};
 f.detailed=structuredClone(f.summary);f.detailed.Changes=[structuredClone(lambda)];
 const fn=raw.fn,before={Properties:{FunctionName:fn.FunctionName,Runtime:fn.Runtime,Architectures:fn.Architectures,Handler:fn.Handler,
  Role:fn.Role,MemorySize:String(fn.MemorySize),Timeout:String(fn.Timeout),LoggingConfig:fn.LoggingConfig,Environment:structuredClone(fn.Environment),
  Code:{S3Bucket:P.bucket,S3Key:f.candidate.release.predecessor.key,S3ObjectVersion:f.candidate.release.predecessor.version}}};
 before.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='****';const after=structuredClone(before);
 after.Properties.Code={S3Bucket:P.bucket,S3Key:artifact.key,S3ObjectVersion:artifact.versionId};
 const change=f.detailed.Changes[0].ResourceChange;change.BeforeContext=JSON.stringify(before);change.AfterContext=JSON.stringify(after);
 const target=key=>({Attribute:'Properties',Name:'Code',RequiresRecreation:'Never',Path:'/Properties/Code/'+key,
  BeforeValue:before.Properties.Code[key],AfterValue:after.Properties.Code[key],AttributeChangeType:'Modify'});
 change.Details=[{Evaluation:'Dynamic',ChangeSource:'DirectModification',Target:target('S3Key')},
  {Evaluation:'Static',ChangeSource:'DirectModification',Target:target('S3ObjectVersion')},
  {Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey',Target:target('S3Key')}];
 // Historical JSON used as FICTIONAL test fixture only, never loaded by CLI.
 f.db=JSON.parse(readFileSync(new URL('../docs/evidence/2026-10-08-care-intent-canonical-registration.json',import.meta.url),'utf8')).inspection;
 f.db.operatorSource={sourceCommit:f.operator.desktop.commit,clean:true};f.db.observedAt=new Date(f.now).toISOString();
 f.caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 f.storage={state:'stored_exact_version',versionId:artifact.versionId,bytesVerified:true,sha256:artifact.sha256,bytes:artifact.bytes,
  originalPutOutcome:'unknown',deletionCertified:false};
 f.listing={Summaries:[{ChangeSetName:fixed.name,ChangeSetId:f.binding.id}]};f.calls=[];
 f.port={now:()=>f.now,current:async()=>structuredClone(f.operator),applicationCurrent:async()=>structuredClone(current),
  identity:async()=>structuredClone(f.caller),writerStopped:async()=>true,custody:async()=>f.encode(),
  rebuild:async()=>{f.calls.push('rebuild');return {byteVerified:true,sourceRebuilt:true,zipSha256:f.candidate.manifest.zipSha256,
   desktopCommit:current.desktop.commit,mobileCommit:current.mobile.source.commit,liveTargetObserved:false,deployed:false,phiAllowed:false};},
  database:async()=>{f.calls.push('database');return structuredClone(f.db);},control:async()=>{f.calls.push('control');return structuredClone(raw);},
  predecessor:async()=>({sha256:f.candidate.release.predecessor.zipSha256,bytes:f.candidate.release.predecessor.bytes,exactBytesVerified:true}),
  storage:async()=>{f.calls.push('storage');return structuredClone(f.storage);},
  proposal:async binding=>{assert.deepEqual(binding,f.binding);f.calls.push('proposal');return {listing:structuredClone(f.listing),
   summary:structuredClone(f.summary),detailed:structuredClone(f.detailed),template:structuredClone(f.input.template)};}};
 return f;
}
const run=f=>runRegisteredProposalReconciliation(f.candidate,f.operator,f.custody,f.sourceText,f.port);
test('stopped combined admission is bound exactly; old upload-only scope is never promoted',()=>{
 const f=fixture(),r=verifyFailedRegisteredProposalCustody(f.custody,f.candidate,f.sourceText,f.now);
 assert.equal(r.lock.runId,f.lock.runId);assert.equal(r.binding.id,f.binding.id);
 for(const mutate of [x=>x.lock.purpose='registered-artifact-upload',x=>x.lock.desktop.commit='0'.repeat(40),
  x=>x.lock.extra=true,x=>x.lock.pid=0,x=>x.events.pop(),x=>x.events.splice(2,1),x=>x.events[2].key='other',
  x=>x.events[2].sha256='0'.repeat(64),x=>x.events[3].artifact.versionId='other',x=>x.events[4].clientToken='other',
  x=>x.events[4].stackId='other',x=>x.events[5].id=x.events[5].id.replace(P.account,'173535830222'),x=>x.events[5].reused=true,x=>x.events[6].writeAdmitted=false,
  x=>x.events[6].code='patient private token',x=>x.events[3].at='2026-10-08T07:00:00Z',
  x=>x.events[1].observedAt='invalid',x=>x.events[4].extra=true]){
  const x=fixture();mutate(x);assert.throws(()=>verifyFailedRegisteredProposalCustody(x.encode(),x.candidate,x.sourceText,x.now));
 }
 assert.throws(()=>verifyFailedRegisteredProposalCustody(f.custody,f.candidate,f.sourceText,Date.parse('2026-10-08T05:59:40Z')));
 const duplicate={...f.custody,lockBytes:Buffer.from(f.custody.lockBytes.toString().replace('"pid":','"pid":1,"pid":'))};
 assert.throws(()=>verifyFailedRegisteredProposalCustody(duplicate,f.candidate,f.sourceText,f.now));
});
test('new operator independently rebuilds frozen application and observes both inventories twice, without converting the failure to a pass',async()=>{
 const f=fixture(),r=await run(f);
 assert.equal(r.applicationSource.desktop.commit,f.current.desktop.commit);assert.equal(r.operatorSource.desktop.commit,f.operator.desktop.commit);
 assert.equal(r.applicationSourceRebuilt,true);assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalFailure,f.events[6].code);
 assert.equal(f.calls.filter(c=>c==='database').length,2);assert.equal(f.calls.filter(c=>c==='proposal').length,2);
 assert.equal(f.calls.filter(c=>c==='storage').length,2);assert.equal(f.calls[0],'rebuild');
 for(const k of ['executionAdmissible','retryPerformed','awsMutationPerformed','deletionCertified','deployed','schemaChanged',
  'hostedAcceptance','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
});
test('bad source, frozen rebuild, credentials, process or custody refuse before archival',async()=>{
 for(const mutate of [f=>f.port.writerStopped=async()=>false,f=>f.port.applicationCurrent=async()=>f.operator,
  f=>f.port.rebuild=async()=>({byteVerified:true,sourceRebuilt:false}),f=>f.port.rebuild=async()=>({sourceRebuilt:true,zipSha256:'0'.repeat(64)}),
  f=>f.port.predecessor=async()=>({sha256:'0'.repeat(64),bytes:f.candidate.release.predecessor.bytes,exactBytesVerified:true}),
  f=>f.port.predecessor=async()=>({sha256:f.candidate.release.predecessor.zipSha256,bytes:1,exactBytesVerified:true}),
  f=>f.operator.templateSha256='0'.repeat(64),f=>f.operator.mobile.source.commit='0'.repeat(40),f=>f.operator.desktop.clean=false,
  f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`,f=>f.port.custody=async()=>({lockBytes:Buffer.from('changed'),journalBytes:f.custody.journalBytes}),
  f=>{let n=0;f.port.identity=async()=>({...f.caller,UserId:String(++n)});},
  f=>f.port.current=async()=>({...f.operator,desktop:{...f.operator.desktop,sha256:'0'.repeat(64)}})]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
});
test('full live database preservation is mandatory twice and stale or operator-mismatched inspection cannot be substituted',async()=>{
 for(const mutate of [f=>f.db.operatorSource.sourceCommit=f.current.desktop.commit,f=>f.db.observedAt='2026-10-08T05:00:00Z',
  f=>f.db.historicalInspection.completeRowCount++,f=>f.db.historicalInspection.completeDataSha256='0'.repeat(64),
  f=>f.db.sourceMigrationCount=46,f=>f.db.phiAllowed=true,
  f=>{let n=0;const db=f.port.database;f.port.database=async()=>{const r=await db();if(++n===2)r.historicalInspection.intentRowCount=1;return r;};},
  f=>{const db=f.port.database;f.port.database=async()=>{f.now+=300001;return db();};}]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
});
test('unknown resources, hidden non-code changes, executed or missing proposals and incomplete listings retain custody',async()=>{
 for(const mutate of [f=>f.summary.Changes.push(structuredClone(f.summary.Changes[0])),f=>f.detailed.NextToken='page',
  f=>f.summary.ExecutionStatus='EXECUTE_COMPLETE',f=>f.detailed.ExecutionStatus='EXECUTE_IN_PROGRESS',
  f=>f.listing.Summaries=[],f=>f.listing.Summaries.push({...f.listing.Summaries[0],ChangeSetId:'other'}),
  f=>f.listing.NextToken='more',f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='other',
  f=>{const c=JSON.parse(f.detailed.Changes[0].ResourceChange.AfterContext);c.Properties.Timeout='30';
   f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(c);},f=>f.raw.fn.CodeSha256='other',
  f=>f.raw.routes.NextToken='more',f=>f.storage.versionId='other',f=>f.storage.bytesVerified=false,f=>f.storage.deletionCertified=true]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
});
test('repeated reads and final boundary refuse late proposal, storage, control, source or process drift',async()=>{
 for(const kind of ['storage','proposal','listing','control','process','source']){
  const f=fixture();let n=0;
  if(kind==='storage'){const old=f.port.storage;f.port.storage=async()=>{const r=await old();if(++n===2)r.versionId='other';return r;};}
  if(kind==='proposal'||kind==='listing'){const old=f.port.proposal;f.port.proposal=async(...a)=>{
   const r=await old(...a);if(++n===2){if(kind==='proposal')r.detailed.Changes[0].ResourceChange.Details.pop();
    else r.listing.Summaries.push({ChangeSetName:'other',ChangeSetId:'other'});}return r;};}
  if(kind==='control'){const old=f.port.control;f.port.control=async()=>{const r=await old();if(++n===4)r.fn.RevisionId+='other';return r;};}
  if(kind==='process')f.port.writerStopped=async()=>++n<5;
  if(kind==='source'){const old=f.port.database;f.port.database=async()=>{const r=await old();if(++n===2)f.current.desktop.sha256='0'.repeat(64);return r;};}
  await assert.rejects(run(f));
 }
});
test('local archival requires recoverable receipt, exact guard and original bytes; leaves journal and artifact intact',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-proposal-settlement-'));
 try{const f=fixture(),report=await run(f),guard=acquireRegisteredUploadReconciliationGuard(root,f.operator),
  custody={...f.custody,lock:resolve(root,'operator.lock'),journal:resolve(root,'original.events.jsonl'),out:root,guard};
  writeFileSync(custody.lock,custody.lockBytes);writeFileSync(custody.journal,custody.journalBytes);
  const result=archiveReconciledProposalLock(custody,report);
  assert.equal(existsSync(custody.lock),false);assert(readFileSync(result.archive).equals(custody.lockBytes));
  assert(readFileSync(custody.journal).equals(custody.journalBytes));assert.equal(JSON.parse(readFileSync(result.receipt)).originalRunOutcome,'failed');
  writeFileSync(custody.lock,custody.lockBytes);writeFileSync(custody.journal,'changed');
  assert.throws(()=>archiveReconciledProposalLock(custody,report));assert.equal(existsSync(custody.lock),true);
  writeFileSync(custody.journal,custody.journalBytes);mkdirSync(resolve(root,'blocked'));
  assert.throws(()=>archiveReconciledProposalLock({...custody,out:resolve(root,'missing')},report));assert.equal(existsSync(custody.lock),true);
  guard.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('public fixed-target reconciliation exposes no write, execution, SQL, saved-report or skipped-rebuild mode',()=>{
 registeredProposalReconciliationArguments(['--v2-root','.','--artifact','.','--application-root','.','--reconcile-fictional-registered-proposal-only']);
 for(const a of [[],['--v2-root','.','--artifact','.','--application-root','.','--execute'],
  ['--v2-root','.','--report','.','--application-root','.','--reconcile-fictional-registered-proposal-only']])assert.throws(()=>registeredProposalReconciliationArguments(a));
 const source=readFileSync(new URL('./reconcile-synthetic-care-registered-proposal.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/new PutObjectCommand|new DeleteObjectCommand|'create-change-set'|'execute-change-set'|'update-stack'|'update-function-code'|--target|--report|--skip/);
 assert.match(source,/inspectCareRegisteredArtifact\(applicationRoot,mobileRoot,artifactDirectory\)/);
 assert.match(source,/buildCareRegisteredDatabaseObserver\(root,operator\)/);assert.match(source,/collectCancellationInventory/);
 assert.match(source,/AWS_ENDPOINT_URL/);assert.match(source,/AWS_MAX_ATTEMPTS:'1'/);
 assert(!source.includes('docs/evidence'));assert(!source.includes('verified:true'));
});
