import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {catalogRuntimeProposalFixture} from './test-fixtures/catalog-runtime-proposal.mjs';
import {catalogRuntimeProposalArguments,verifyCatalogRuntimeProposalCustody,runCatalogRuntimeProposalReconciliation,verifyCatalogRuntimeProposalPublication} from './catalog-runtime-proposal-live.mjs';
import {verifyCatalogRuntimeProposalViews} from './catalog-runtime-code-change.mjs';
import {verifyCatalogRuntimeSuccessorControl,verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';

function fixture(){
 const f=catalogRuntimeProposalFixture(),lock={runId:'1'.repeat(32),pid:12345,purpose:'catalog-runtime-artifact-proposal',
  desktop:f.current.desktop,mobile:f.current.mobile};
 const at=offset=>new Date(f.now-offset).toISOString();
 const events=[{at:at(100000),stage:'catalog_runtime_proposal_started',runId:lock.runId,operatorSource:structuredClone(f.current)},
  {at:at(90000),stage:'catalog_runtime_change_set_create_admitted',stackId:f.binding.stackId,name:f.binding.name,clientToken:f.binding.digest}];
 const custody=()=>({lockBytes:Buffer.from(JSON.stringify(lock)+'\n'),journalBytes:Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 const original=custody(),caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'},calls=[];
 const port={now:()=>f.now,identity:async()=>{calls.push('identity');return structuredClone(caller);},
  unchanged:async()=>{calls.push('unchanged');},writerStopped:async()=>true,custody:async()=>custody(),
  preflight:async()=>structuredClone(f.preflight),storage:async()=>{calls.push('storage');return structuredClone(f.artifact);},
  control:async()=>{calls.push('control');return structuredClone(f.raw);},list:async()=>({Summaries:[{ChangeSetName:f.binding.name,ChangeSetId:f.binding.id}]}),
  views:async()=>({summary:structuredClone(f.summary),detailed:structuredClone(f.detailed),template:structuredClone(f.input.template)})};
 return {f,lock,events,original,custody,caller,calls,port,at};
}
const verify=x=>verifyCatalogRuntimeProposalCustody(x.custody(),x.f.candidate,x.f.artifact,x.f.sourceText,x.f.now);
const run=x=>runCatalogRuntimeProposalReconciliation(x.f.candidate,x.f.artifact,x.f.sourceText,x.original,x.port);

test('abrupt admitted crash and a complete ordered journal bind original source and exact create, without certifying its outcome',()=>{
 const x=fixture();assert.equal(verify(x).fixed.name,x.f.binding.name);
 x.events.push({at:x.at(85000),stage:'catalog_runtime_change_set_observed',id:x.f.binding.id,name:x.f.binding.name,reused:false},
  {at:x.at(80000),stage:'catalog_runtime_change_set_verified_unexecuted',id:x.f.binding.id,summarySha256:'a'.repeat(64),propertyValuesSha256:'b'.repeat(64)},
  {at:x.at(75000),stage:'catalog_runtime_proposal_completed',receipt:'fictional-local-receipt'});
 assert.equal(verify(x).events.length,5);
 x.events.push({at:x.at(70000),stage:'catalog_runtime_proposal_finding',writeAdmitted:true,code:'synthetic_care_registered_release_refused:fictional'});
 assert.equal(verify(x).events.length,6);
});

test('journal refuses skipped verification, changed admitted target, unsigned source, live writer deadline and malformed encoding',()=>{
 for(const mutate of [x=>x.events.splice(1,1),x=>x.events[1].name+='other',x=>x.events[1].clientToken='0'.repeat(64),
  x=>x.events[1].stackId+='other',x=>x.lock.pid=0,x=>x.lock.purpose='registered-artifact-upload-proposal',
  x=>x.lock.desktop.commit='f'.repeat(40),x=>delete x.events[0].operatorSource,x=>x.events[0].operatorSource.desktop.clean=false,
  x=>x.events[0].operatorSource.mobile.source.commit='f'.repeat(40),x=>x.events[0].operatorSource.templateSha256='0'.repeat(64),
  x=>x.events[1].at=x.at(59999),x=>x.events[1].at=x.at(-1),x=>x.events[1].at='invalid',
  x=>x.events.push({at:x.at(80000),stage:'catalog_runtime_proposal_completed'}),
  x=>x.events.push({at:x.at(80000),stage:'catalog_runtime_change_set_verified_unexecuted'}),
  x=>x.events.push({at:x.at(80000),stage:'catalog_runtime_proposal_finding',writeAdmitted:false}),
  x=>x.events.push({...x.events[1],at:x.at(80000)})]){
  const x=fixture();mutate(x);assert.throws(()=>verify(x));
 }
 const x=fixture(),c=x.custody();c.lockBytes=Buffer.from(JSON.stringify(x.lock,null,2)+'\n');
 assert.throws(()=>verifyCatalogRuntimeProposalCustody(c,x.f.candidate,x.f.artifact,x.f.sourceText,x.f.now));
});

test('observed and verified journal identity cannot be replaced by a reused or unrelated proposal',()=>{
 for(const kind of ['reused','name','id','hash','verification_id']){
  const x=fixture(),observed={at:x.at(85000),stage:'catalog_runtime_change_set_observed',id:x.f.binding.id,name:x.f.binding.name,reused:false},
   verified={at:x.at(80000),stage:'catalog_runtime_change_set_verified_unexecuted',id:x.f.binding.id,summarySha256:'a'.repeat(64),propertyValuesSha256:'b'.repeat(64)};
  if(kind==='reused')observed.reused=true;if(kind==='name')observed.name+='other';if(kind==='id')observed.id='unrelated';
  if(kind==='hash')verified.summarySha256='invalid';if(kind==='verification_id')verified.id+='other';
  x.events.push(observed,verified);assert.throws(()=>verify(x),undefined,kind);
 }
});

test('stopped-writer reconciliation repeats actual proposal, target, storage and identity reads; never executes or retries',async()=>{
 const x=fixture(),result=await run(x);
 assert.equal(result.observation.state,'verified_unexecuted');assert.equal(result.originalCreateOutcome,'unknown');
 assert.deepEqual(result.originalOperatorSource,x.f.current);assert.equal(x.calls.filter(c=>c==='control').length,3);
 assert.equal(x.calls.filter(c=>c==='storage').length,3);assert(x.calls.filter(c=>c==='identity').length>=5);
 for(const key of ['retryPerformed','awsMutationPerformed','deployed','schemaChanged','recoveryRehearsed','hostedAcceptance','erasureAccepted','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(result[key],false);
});

test('absence is only a repeated observation, never certification of original create failure',async()=>{
 const x=fixture();x.port.list=async()=>({Summaries:[]});x.port.views=async()=>{throw Error('must not query an absent proposal');};
 const result=await run(x);assert.equal(result.observation.state,'absent_at_observation');assert.equal(result.originalCreateOutcome,'unknown');
});

test('reconciliation refuses identity, source, custody, executed view, partial listing, storage or final control drift',async()=>{
 for(const kind of ['principal','root','source','journal','active_writer','executed','storage','control','final_control','second_view','page','duplicate','expiry','preflight']){
  const x=fixture();let count=0;
  if(kind==='principal'||kind==='root')x.port.identity=async()=>{count++;return count<2?structuredClone(x.caller):
   {...x.caller,Arn:kind==='root'?`arn:aws:iam::${P.account}:root`:x.caller.Arn+'other'};};
  if(kind==='source')x.port.unchanged=async()=>{throw Error('source changed');};
  if(kind==='journal')x.port.custody=async()=>({...x.original,journalBytes:Buffer.from('changed\n')});
  if(kind==='active_writer')x.port.writerStopped=async()=>false;
  if(kind==='executed'){x.f.summary.ExecutionStatus='EXECUTE_COMPLETE';x.f.detailed.ExecutionStatus='EXECUTE_COMPLETE';}
  if(kind==='storage')x.port.storage=async()=>({...x.f.artifact,versionId:'other'});
  if(kind==='control')x.f.raw.fn.RevisionId+='other';
  if(kind==='final_control')x.port.control=async()=>{const raw=structuredClone(x.f.raw);if(++count===3)raw.fn.RevisionId+='other';return raw;};
  if(kind==='second_view')x.port.views=async()=>{if(++count===2)x.f.detailed.ExecutionStatus='EXECUTE_COMPLETE';
   return {summary:x.f.summary,detailed:x.f.detailed,template:x.f.input.template};};
  if(kind==='page')x.port.list=async()=>({Summaries:[],NextToken:'more'});
  if(kind==='duplicate')x.port.list=async()=>({Summaries:[{ChangeSetName:x.f.binding.name,ChangeSetId:x.f.binding.id},{ChangeSetName:'other',ChangeSetId:x.f.binding.id}]});
  if(kind==='expiry')x.port.views=async()=>{x.f.now+=120001;return {summary:x.f.summary,detailed:x.f.detailed,template:x.f.input.template};};
  if(kind==='preflight')x.port.preflight=async()=>({...x.f.preflight,phiAllowed:true});
  await assert.rejects(run(x),undefined,kind);
 }
});

test('capture before first await prevents caller replacement of candidate, artifact and custody witnesses',async()=>{
 const x=fixture(),identity=x.port.identity,artifact=structuredClone(x.f.artifact),custody=x.custody();
 x.port.identity=async()=>{const result=await identity();x.f.candidate.bundle[0]^=1;x.f.artifact.versionId='mutated';
  x.original.lockBytes.fill(0);x.original.journalBytes.fill(0);return result;};
 x.port.storage=async()=>structuredClone(artifact);x.port.custody=async()=>custody;
 const result=await run(x);assert.deepEqual(result.artifact,artifact);assert.equal(result.observation.state,'verified_unexecuted');
});

test('public constructor accepts only exact path inputs, fixed proposal or read-only reconciliation, and no target or report override',()=>{
 const args=['--v2-root','.','--artifact','.','--custody-root','.','--deployed-desktop-root','.','--deployed-v2-root','.',
  '--application-root','.','--prepare-fictional-catalog-runtime-code-change-only'];
 assert(catalogRuntimeProposalArguments(args).applicationRoot);
 const reconcile=[...args];reconcile[12]='--reconcile-fictional-catalog-runtime-proposal-only';assert(catalogRuntimeProposalArguments(reconcile,true).applicationRoot);
 for(const a of [[...args,'--profile','prod'],[...args,'--target','other'],[...args,'--report','saved'],[...args,'--execute'],reconcile,
  args.map((s,i)=>i===11?'--saved-report':s),args.slice(0,12)])assert.throws(()=>catalogRuntimeProposalArguments(a));
 const live=readFileSync(new URL('./catalog-runtime-proposal-live.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(live,/'execute-change-set'|'update-stack'|'update-function-code'|'delete-change-set'|test-fixtures/);
 assert.match(live,/AWS_MAX_ATTEMPTS:'1'/);assert.match(live,/buildCareIdentityBundle\(options.applicationRoot\)/);
});

test('successor full-control check requires exact candidate code and separate retained routing, with no raw-response patch',()=>{
 const x=fixture(),raw=structuredClone(x.f.raw),{candidate,current,artifact,source}=x.f;
 raw.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=artifact.versionId;
 raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=artifact.key;
 raw.fn.CodeSha256=Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64');raw.fn.CodeSize=candidate.zip.length;
 const before=JSON.stringify(raw);assert(verifyCatalogRuntimeSuccessorControl(raw,source,candidate,current,artifact));assert.equal(JSON.stringify(raw),before);
 assert.throws(()=>verifyCatalogRuntimePredecessorControl(raw,source));
 raw.integrations.Items.find(i=>i.IntegrationId===R.integrationId).IntegrationUri=R.latestArn+':2';assert(verifyCatalogRuntimeSuccessorControl(raw,source,candidate,current,artifact,'2'));
 assert.throws(()=>verifyCatalogRuntimeSuccessorControl(raw,source,candidate,current,artifact));
 for(const mutate of [r=>r.fn.Environment.Variables.EXTRA='changed',r=>r.fn.CodeSize++,r=>r.routes.Items.pop(),
  r=>r.integrations.Items.find(i=>i.IntegrationId===R.integrationId).IntegrationUri=R.latestArn+':3',r=>r.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue+='other']){
  const changed=structuredClone(raw);mutate(changed);assert.throws(()=>verifyCatalogRuntimeSuccessorControl(changed,source,candidate,current,artifact,'2'));
 }
 assert.throws(()=>verifyCatalogRuntimeSuccessorControl(raw,source,candidate,current,artifact,'3'));
});

test('final publication after storage I/O refuses expired, executed or changed proposal, source, object and live controls',()=>{
 const make=()=>{const {f}=fixture(),projection=verifyCatalogRuntimeProposalViews(f.summary,f.detailed,f.input.template,f.input,f.binding,f.raw,
  f.sourceText,f.preflight,f.current,f.candidate,f.artifact,f.now);
  return {f,result:{preflightObservedAt:f.preflight.observedAt,stackId:f.binding.stackId,changeSetName:f.binding.name,
   current:structuredClone(f.current),artifact:structuredClone(f.artifact),projection,executionAdmissible:false,deployed:false,phiAllowed:false},
   view:{summary:structuredClone(f.summary),detailed:structuredClone(f.detailed),template:structuredClone(f.input.template)}};};
 const run=x=>verifyCatalogRuntimeProposalPublication(x.result,x.view,x.f.raw,x.f.sourceText,x.f.candidate,x.f.current,x.f.artifact,x.f.now);
 assert.doesNotThrow(()=>run(make()));
 for(const mutate of [x=>x.f.now+=120001,x=>x.result.preflightObservedAt=new Date(x.f.now+1).toISOString(),
  x=>x.view.summary.ExecutionStatus='EXECUTE_COMPLETE',x=>x.view.detailed.Changes=[],x=>x.view.template.Resources={},
  x=>x.f.raw.fn.RevisionId+='changed',x=>x.result.current.desktop.commit='f'.repeat(40),x=>x.result.artifact.versionId='other',
  x=>x.result.stackId='other',x=>x.result.phiAllowed=true]){const x=make();mutate(x);assert.throws(()=>run(x));}
});
