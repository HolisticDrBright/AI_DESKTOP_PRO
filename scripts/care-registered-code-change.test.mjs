import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {careRegisteredControlFixture} from './test-fixtures/care-registered-control.mjs';
import {careRegisteredCodeChangeInputs,careRegisteredChangeSetBinding,parseRegisteredPropertyContext,
 verifyCareRegisteredProposalViews} from './care-registered-code-change.mjs';
import {careRegisteredProposalArguments,runCareRegisteredProposal} from './prepare-synthetic-care-registered-code-change.mjs';
function fixture(){
 const f=careRegisteredControlFixture(),{raw,artifact}=f;
 f.input=careRegisteredCodeChangeInputs(f.sourceText,f.candidate,f.current,f.preflight,artifact,f.now);
 const fixed=careRegisteredChangeSetBinding(f.input,f.current,artifact);
 f.binding={...fixed,id:`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${fixed.name}/fictional-id`};
 const lambda={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'DirectModification'},
   {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'}]}};
 const dependency={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,
  ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}};
 const params=structuredClone(raw.stack.Stacks[0].Parameters);params.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=artifact.key;
 f.summary={StackId:fixed.stackId,StackName:P.stack,ChangeSetName:fixed.name,ChangeSetId:f.binding.id,
  Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',Capabilities:['CAPABILITY_IAM'],NotificationARNs:[],RollbackConfiguration:{},
  DeploymentConfig:{Mode:'STANDARD',DisableRollback:false},Parameters:params,Changes:[lambda,dependency]};
 f.summary.Description=`Registered synthetic code ${f.current.desktop.commit}; PHI off; no schema change`;
 f.summary.CreationTime=new Date(f.now).toISOString();
 f.detailed=structuredClone(f.summary);f.detailed.Changes=[structuredClone(lambda)];
 const fn=raw.fn;
 f.before={Properties:{FunctionName:fn.FunctionName,Runtime:fn.Runtime,Architectures:fn.Architectures,Handler:fn.Handler,Role:fn.Role,
  MemorySize:String(fn.MemorySize),Timeout:String(fn.Timeout),LoggingConfig:fn.LoggingConfig,Environment:structuredClone(fn.Environment),
  Code:{S3Bucket:P.bucket,S3Key:f.candidate.release.predecessor.key,S3ObjectVersion:f.candidate.release.predecessor.version}}};
 f.before.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='****';
 f.after=structuredClone(f.before);f.after.Properties.Code={S3Bucket:P.bucket,S3Key:artifact.key,S3ObjectVersion:artifact.versionId};
 const change=f.detailed.Changes[0].ResourceChange;
 change.BeforeContext=JSON.stringify(f.before);change.AfterContext=JSON.stringify(f.after);
 change.Details=['S3ObjectVersion','S3Key'].map(key=>({Evaluation:'Static',ChangeSource:'DirectModification',Target:{
  Attribute:'Properties',Name:'Code',RequiresRecreation:'Never',Path:'/Properties/Code/'+key,
  BeforeValue:f.before.Properties.Code[key],AfterValue:f.after.Properties.Code[key],AttributeChangeType:'Modify'}}));
 return f;
}
const inputs=f=>careRegisteredCodeChangeInputs(f.sourceText,f.candidate,f.current,f.preflight,f.artifact,f.now);
const verify=f=>verifyCareRegisteredProposalViews(f.summary,f.detailed,f.input.template,f.input,f.binding,f.raw,
 f.sourceText,f.preflight,f.current,f.candidate,f.artifact,f.now);
const context=f=>{f.detailed.Changes[0].ResourceChange.BeforeContext=JSON.stringify(f.before);
 f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(f.after);};
test('registered proposal binds exact current history, source, artifact and both exhaustive views without admitting execution',()=>{
 const f=fixture(),prior=JSON.stringify(f),result=verify(f);
 assert.equal(result.summaryResourceCount,2);assert.equal(result.propertyValuesResourceCount,1);
 assert.equal(result.integrationDependencyClassified,true);assert.equal(result.integrationNoOpProven,false);
 for(const k of ['executionAdmissible','deployed','schemaChanged','hostedAcceptance','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(result[k],false);
 assert.equal(JSON.stringify(f),prior);
 assert.deepEqual(f.input.template.Resources.IdentityApiFunction.Properties.Code,
  {...f.raw.template.Resources.IdentityApiFunction.Properties.Code,S3ObjectVersion:f.artifact.versionId});
 assert.equal(f.input.parameters.filter(p=>p.UsePreviousValue===true).length,10);
});
test('input refuses stale preflight, wrong source, unknown artifact flags, version, key, bytes and unverifiable upload',()=>{
 for(const mutate of [f=>f.now+=120001,f=>f.sourceText+=' ',f=>f.preflight.control.templateSha256='0'.repeat(64),
  f=>f.artifact.key+='other',f=>f.artifact.bucket='other',f=>f.artifact.sha256='0'.repeat(64),f=>f.artifact.bytes++,
  f=>f.artifact.versionId='null',f=>f.artifact.versionId='new\nversion',f=>f.artifact.versionId='',f=>f.artifact.reused='true',
  f=>f.artifact.exactVersionReadbackVerified=false,f=>f.artifact.kmsKeyArn='other',f=>f.artifact.phiAllowed=true,
  f=>f.current.migrations.liveMigrationCount=47,f=>f.candidate.bundle[0]^=1]){
  const f=fixture();mutate(f);assert.throws(()=>inputs(f));
 }
});
test('proposal refuses stale or changed full controls and any candidate/input identity drift',()=>{
 for(const mutate of [f=>f.raw.fn.RevisionId+='changed',f=>f.raw.fn.Environment.Variables.EXTRA='value',
  f=>f.raw.routes.Items.pop(),f=>f.raw.routes.NextToken='page',f=>f.raw.resources.NextToken='page',
  f=>f.raw.role.Role.AssumeRolePolicyDocument.Statement[0].Principal.Service='other',
  f=>f.raw.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',f=>f.raw.template.Resources.IdentityApiFunction.Properties.Timeout=30,
  f=>f.input.parameters[0].ParameterValue='changed',f=>f.binding.stackId+='changed',f=>f.binding.name+='changed',
  f=>f.binding.id+='/',f=>f.binding.id=f.binding.id.replace(P.account,'173535830222')]){
  const f=fixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('both raw inventories reject unknown resources, pages, metadata, nested/import/drift/rollback authority',()=>{
 for(const mutate of [f=>f.summary.Changes.push(structuredClone(f.summary.Changes[0])),f=>f.summary.Changes.reverse(),
  f=>f.summary.Changes[1].ResourceChange.Details[0].CausingEntity='Other.Arn',
  f=>f.summary.Changes[1].ResourceChange.Details[0].Target.RequiresRecreation='Always',
  f=>f.summary.Changes[1].ResourceChange.Replacement='True',f=>f.detailed.Changes.push(structuredClone(f.summary.Changes[1])),
  f=>f.summary.NextToken='more',f=>f.detailed.NextToken='more',f=>f.summary.ExecutionStatus='EXECUTE_COMPLETE',
  f=>f.summary.DeploymentConfig.DisableRollback=true,f=>f.summary.RootChangeSetId='parent',
  f=>f.summary.NotificationARNs.push('other'),f=>f.summary.Tags=[{Key:'PhiAllowed',Value:'true'}],
  f=>f.summary.ImportExistingResources=true,f=>f.summary.IncludeNestedStacks=true,
  f=>f.summary.DeploymentMode='REVERT_DRIFT',f=>f.summary.NewUnknownScope='unsafe',
  f=>f.summary.Changes[0].ResourceChange.ModuleInfo={},f=>f.detailed.Parameters.pop(),
  f=>{f.summary.Description='different release';f.detailed.Description='different release';},
  f=>{f.summary.CreationTime='invalid';f.detailed.CreationTime='invalid';}]){
  const f=fixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('full property context refuses hidden non-code differences or incorrect current predecessor',()=>{
 for(const mutate of [f=>f.before.Properties.Code.S3ObjectVersion='old-parent-version',
  f=>f.before.Properties.Code.S3Key=f.before.Properties.Code.S3Key.replace('care-intent-release','care-release'),
  f=>f.before.Properties.Role+='changed',f=>f.after.Properties.Environment.Variables.PHI_ALLOWED='true',
  f=>f.after.Properties.MemorySize='512',f=>f.after.Properties.Timeout='30',f=>f.after.Properties.Code.S3Bucket='other',
  f=>f.after.Properties.Code.S3ObjectVersion='wrong',f=>f.after.Properties.NewUnknownFeature=true,
  f=>f.after.Metadata={unsafe:true},f=>f.before.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN=P.secret]){
  const f=fixture();mutate(f);context(f);assert.throws(()=>verify(f));
 }
});
test('two leaf deltas must exactly match contexts and explain key and version once, with no mutation-capable extra fields',()=>{
 const params=fixture();const key=params.detailed.Changes[0].ResourceChange.Details[1];
 key.ChangeSource='ParameterReference';key.CausingEntity='LambdaCodeKey';assert.doesNotThrow(()=>verify(params));
 for(const mutate of [f=>f.detailed.Changes[0].ResourceChange.Details.pop(),
  f=>f.detailed.Changes[0].ResourceChange.Details.push(structuredClone(f.detailed.Changes[0].ResourceChange.Details[0])),
  f=>f.detailed.Changes[0].ResourceChange.Details[1]=structuredClone(f.detailed.Changes[0].ResourceChange.Details[0]),
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.Path='/Properties/Role',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.BeforeValue='wrong',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='wrong',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Evaluation='Dynamic',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].ChangeSource='ParameterReference',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].HiddenMutation=true,
  f=>f.detailed.Changes[0].ResourceChange.BeforeContext='{}',f=>f.detailed.Changes[0].ResourceChange.SomeExtra=true]){
  const f=fixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('actual AWS dual evaluation of a parameter key admits only the complete exact three-detail projection',()=>{
 const observed=()=>{
  const f=fixture(),details=f.detailed.Changes[0].ResourceChange.Details,
   version=structuredClone(details[0]),key=structuredClone(details[1]);
  key.Evaluation='Dynamic';
  const parameter={...structuredClone(key),Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'};
  f.detailed.Changes[0].ResourceChange.Details=[key,version,parameter];return f;
 };
 for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
  const f=observed(),details=f.detailed.Changes[0].ResourceChange.Details;
  f.detailed.Changes[0].ResourceChange.Details=order.map(i=>details[i]);
  const result=verify(f);assert.equal(result.executionAdmissible,false);assert.equal(result.deployed,false);
 }
 for(const mutate of [f=>f.detailed.Changes[0].ResourceChange.Details.pop(),
  f=>f.detailed.Changes[0].ResourceChange.Details.push(structuredClone(f.detailed.Changes[0].ResourceChange.Details[0])),
  f=>f.detailed.Changes[0].ResourceChange.Details[2]=structuredClone(f.detailed.Changes[0].ResourceChange.Details[0]),
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='different-key',
  f=>f.detailed.Changes[0].ResourceChange.Details[2].Target.BeforeValue='different-predecessor',
  f=>f.detailed.Changes[0].ResourceChange.Details[2].CausingEntity='OtherKey',
  f=>f.detailed.Changes[0].ResourceChange.Details[2].Evaluation='Dynamic',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.Path='/Properties/Role',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].HiddenMutation=true,
  f=>f.detailed.Changes[0].ResourceChange.Details[1].Evaluation='Dynamic',
  f=>{f.after.Properties.Timeout='30';context(f);}]){
  const f=observed();mutate(f);assert.throws(()=>verify(f));
 }
});
test('bounded context parser detects duplicate decoded keys at any depth without rejecting whitespace or escapes',()=>{
 assert.deepEqual(parseRegisteredPropertyContext(' { "a": [1, true, null, "x,}:\\\""], "b":{} } '),{a:[1,true,null,'x,}:"'],b:{}});
 for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":1}','{"Properties":{"Code":{},"Code":{}}}',
  '{"a":[{"x":1,"x":2}]}','[1,]','{"a":1} trailing',' '.repeat(65537), '['.repeat(34)+'0'+']'.repeat(34)]){
  assert.throws(()=>parseRegisteredPropertyContext(text));
 }
 const f=fixture();f.detailed.Changes[0].ResourceChange.AfterContext=f.detailed.Changes[0].ResourceChange.AfterContext
  .replace('"Timeout":"29"','"Timeout":"99","Timeout":"29"');assert.throws(()=>verify(f),/duplicate_property_context/);
});
test('qualification module has no AWS call, execution, ledger replay or mobile build surface',()=>{
 const source=readFileSync(new URL('./care-registered-code-change.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/execFile|client\.send|execute-change-set|update-stack|update-function-code|process\.env|process\.argv/);
 assert.match(source,/executionAdmissible:false/);assert.match(source,/verifyCareRegisteredPredecessorControl\(raw,source\)/);
});
function executionFixture(){
 const f=fixture(),events=[],saved=[],initial=JSON.stringify(f.current),caller={Account:P.account,
  Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 let creates=0;
 const port={now:()=>f.now,identity:async()=>structuredClone(caller),
  unchanged:async()=>assert.equal(JSON.stringify(f.current),initial),control:async()=>structuredClone(f.raw),
  list:async()=>({Summaries:[]}),writeInput:async()=>{},admit:e=>events.push(e),record:e=>events.push(e),
  create:async fixed=>{creates++;events.push({stage:'actual_create'});assert.equal(fixed.name,f.binding.name);
   return {StackId:fixed.stackId,Id:f.binding.id};},
  describe:async(binding,detail)=>{assert.equal(binding.id,f.binding.id);return structuredClone(detail?f.detailed:f.summary);},
  template:async()=>structuredClone(f.input.template),wait:async ms=>{f.now+=ms;},saveReport:async(_fixed,r)=>saved.push(r)};
 return {f,events,saved,caller,port,creates:()=>creates};
}
const propose=x=>runCareRegisteredProposal(x.f.candidate,x.f.current,x.f.sourceText,x.f.preflight,x.f.artifact,x.port);

function renewalPort(x){
 let renewals=0;
 x.port.refreshPreflight=async()=>{
  renewals++;
  const r=structuredClone(x.f.preflight),db=structuredClone(JSON.parse(readFileSync(
   new URL('../docs/evidence/2026-10-08-care-intent-canonical-registration.json',import.meta.url),'utf8')).inspection);
  r.observedAt=new Date(x.f.now).toISOString();
  db.observedAt=r.observedAt;db.operatorSource={sourceCommit:x.f.current.desktop.commit,clean:true};
  r.databaseBefore=structuredClone(db);r.databaseAfter=structuredClone(db);return r;
 };
 return ()=>renewals;
}
test('renewal re-observes the full bound preflight after slow create without replaying create or widening the TTL',async()=>{
 const x=executionFixture(),count=renewalPort(x),create=x.port.create;
 x.port.control=async()=>{x.f.now+=50000;return structuredClone(x.f.raw);};
 x.port.create=async fixed=>{const result=await create(fixed);x.f.now+=55000;return result;};
 const original=x.f.preflight.observedAt,report=await propose(x);
 assert.equal(count(),1);assert.equal(x.creates(),1);assert.equal(report.deployed,false);
 assert.equal(x.f.preflight.observedAt,original);assert.equal(x.saved.length,1);
});
test('renewal admits a delayed local preparation only after a new complete preflight',async()=>{
 const x=executionFixture(),count=renewalPort(x);
 x.port.writeInput=async()=>{x.f.now+=120001;};
 await propose(x);assert.equal(count(),1);assert.equal(x.creates(),1);
});
test('publication renews before saving a nearly expired report; a bounded save cannot spend an old preflight window',async()=>{
 const x=executionFixture(),count=renewalPort(x),create=x.port.create,save=x.port.saveReport;
 x.port.control=async()=>{x.f.now+=35000;return structuredClone(x.f.raw);};
 x.port.create=async fixed=>{const result=await create(fixed);x.f.now+=10000;return result;};
 x.port.saveReport=async(...args)=>{await save(...args);x.f.now+=6000;};
 const original=x.f.preflight.observedAt,report=await propose(x);
 assert.equal(count(),1);assert.equal(x.creates(),1);assert.equal(x.saved.length,1);
 assert.equal(report.preflightRenewals,1);assert.notEqual(report.preflightObservedAt,original);
 assert.equal(x.f.preflight.observedAt,original);
 assert.equal(x.events.at(-1).stage,'registered_change_set_verified_unexecuted');
 assert.equal(report.deployed,false);assert.equal(report.executionAdmissible,false);
});
test('publication refresh cannot bless a changed, stale, partial or unconfirmed observer after create',async()=>{
 for(const kind of ['stale','future','control','missing_database','identity','unknown']){
  const x=executionFixture();renewalPort(x);const refresh=x.port.refreshPreflight,create=x.port.create;
  x.port.create=async fixed=>{const result=await create(fixed);x.f.now+=10000;return result;};
  x.port.refreshPreflight=async()=>{
   if(kind==='unknown')throw Error('unconfirmed read');
   const r=await refresh();
   if(kind==='stale')r.observedAt=new Date(x.f.now-120001).toISOString();
   if(kind==='future')r.observedAt=new Date(x.f.now+1).toISOString();
   if(kind==='control')r.control.revision+='changed';
   if(kind==='missing_database')delete r.databaseAfter;
   if(kind==='identity')x.caller.Arn+='different';return r;
  };
  await assert.rejects(propose(x),undefined,kind);assert.equal(x.creates(),1,kind);
  assert.equal(x.saved.length,0,kind);
  assert.equal(x.events.some(e=>e.stage==='registered_change_set_verified_unexecuted'),false,kind);
 }
});
test('publication re-observes both proposal views after its potentially slow preflight refresh',async()=>{
 const x=executionFixture();renewalPort(x);const refresh=x.port.refreshPreflight,create=x.port.create;
 x.port.create=async fixed=>{const result=await create(fixed);x.f.now+=10000;return result;};
 x.port.refreshPreflight=async()=>{
  const result=await refresh();
  x.f.summary.ExecutionStatus='EXECUTE_COMPLETE';x.f.detailed.ExecutionStatus='EXECUTE_COMPLETE';
  return result;
 };
 await assert.rejects(propose(x));assert.equal(x.creates(),1);assert.equal(x.saved.length,0);
 assert.equal(x.events.some(e=>e.stage==='registered_change_set_verified_unexecuted'),false);
});
test('renewal refuses stale/future/changed/partial observations before create admission',async()=>{
 for(const kind of ['stale','future','control','source','phi','missing_database','wrong_database','identity','unknown']){
  const x=executionFixture();renewalPort(x);const refresh=x.port.refreshPreflight;
  x.port.writeInput=async()=>{x.f.now+=120001;};
  x.port.refreshPreflight=async()=>{
   if(kind==='unknown')throw Error('unconfirmed read');
   const r=await refresh();
   if(kind==='stale')r.observedAt=new Date(x.f.now-120001).toISOString();
   if(kind==='future')r.observedAt=new Date(x.f.now+1).toISOString();
   if(kind==='control')r.control.revision+='changed';
   if(kind==='source')r.current.desktop.sha256='0'.repeat(64);
   if(kind==='phi')r.phiAllowed=true;
   if(kind==='missing_database')delete r.databaseAfter;
   if(kind==='wrong_database')r.databaseAfter.historicalInspection.completeDataSha256='0'.repeat(64);
   if(kind==='identity')x.caller.Arn+='different';return r;
  };
  await assert.rejects(propose(x),undefined,kind);assert.equal(x.creates(),0,kind);
  assert.equal(x.events.some(e=>e.stage==='registered_change_set_create_admitted'),false,kind);
 }
});
test('renewal never hides a slow control read, failed post-create renewal or source drift',async()=>{
 for(const kind of ['slow_control','post_create_failed','source','late_save']){
  const x=executionFixture();renewalPort(x);const create=x.port.create;
  if(kind==='slow_control')x.port.control=async()=>{x.f.now+=120001;return structuredClone(x.f.raw);};
  if(kind==='post_create_failed')x.port.create=async fixed=>{const r=await create(fixed);x.f.now+=120001;
   x.port.refreshPreflight=async()=>{throw Error('unconfirmed read');};return r;};
  if(kind==='source')x.port.writeInput=async()=>{x.f.now+=120001;x.f.current.desktop.sha256='0'.repeat(64);};
  if(kind==='late_save'){const save=x.port.saveReport;x.port.saveReport=async(...args)=>{await save(...args);x.f.now+=120001;};}
  await assert.rejects(propose(x));assert.equal(x.creates(),['post_create_failed','late_save'].includes(kind)?1:0);
  assert.equal(x.events.some(e=>e.stage==='registered_change_set_verified_unexecuted'),false);
 }
});
test('proposal runner admits exactly once before create, observes both views and repeated complete controls; never executes',async()=>{
 const x=executionFixture(),report=await propose(x);
 assert.equal(x.creates(),1);assert.equal(report.changeSetCreated,true);assert.equal(report.deployed,false);
 assert.equal(report.executionAdmissible,false);assert.equal(report.phiAllowed,false);assert.equal(x.saved.length,1);
 assert(x.events.findIndex(e=>e.stage==='registered_change_set_create_admitted')<x.events.findIndex(e=>e.stage==='actual_create'));
 assert.equal(x.events.at(-1).stage,'registered_change_set_verified_unexecuted');
});
test('complete existing proposal is verified without create; ambiguous or paginated listing refuses',async()=>{
 const reused=executionFixture();reused.port.list=async()=>({Summaries:[{ChangeSetName:reused.f.binding.name,ChangeSetId:reused.f.binding.id}]});
 assert.equal((await propose(reused)).reused,true);assert.equal(reused.creates(),0);
 for(const kind of ['duplicate','page','malformed','id_duplicate']){
  const x=executionFixture();x.port.list=async()=>{
   const row={ChangeSetName:x.f.binding.name,ChangeSetId:x.f.binding.id};
   return kind==='page'?{Summaries:[],NextToken:'more'}:kind==='malformed'?{Summaries:[{}]}
    :{Summaries:[row,kind==='id_duplicate'?{...row,ChangeSetName:'other'}:{...row,ChangeSetId:row.ChangeSetId+'other'}]};
  };
  await assert.rejects(propose(x));assert.equal(x.creates(),0);assert.equal(x.saved.length,0);
 }
});
test('source/principal/control drift or slow local preparation refuses before create admission',async()=>{
 for(const kind of ['source','principal','control','expiry','root']){
  const x=executionFixture();x.port.writeInput=async()=>{
   if(kind==='source')x.f.current.desktop.sha256='0'.repeat(64);
   if(kind==='principal')x.caller.Arn+='other';
   if(kind==='control')x.f.raw.fn.RevisionId+='other';
   if(kind==='expiry')x.f.now+=120001;
   if(kind==='root')x.caller.Arn=`arn:aws:iam::${P.account}:root`;
  };
  await assert.rejects(propose(x));assert.equal(x.creates(),0);
  assert.equal(x.events.some(e=>e.stage==='registered_change_set_create_admitted'),false);
 }
});
test('unknown create and post-create observation failures cannot retry or report success',async()=>{
 for(const kind of ['unknown','wrong_response','bad_projection','never_ready','late_control','after_report']){
  const x=executionFixture(),create=x.port.create;
  x.port.create=async fixed=>{const reply=await create(fixed);if(kind==='unknown')throw Error('lost create response');
   if(kind==='wrong_response')reply.StackId='other';
   if(kind==='bad_projection')x.f.summary.Changes.push(structuredClone(x.f.summary.Changes[0]));
   if(kind==='never_ready')x.f.detailed.Status='CREATE_IN_PROGRESS';
   if(kind==='late_control')x.f.raw.fn.RevisionId+='changed';return reply;};
  if(kind==='after_report'){const save=x.port.saveReport;x.port.saveReport=async(...args)=>{await save(...args);x.f.raw.fn.RevisionId+='changed';};}
  await assert.rejects(propose(x));assert.equal(x.creates(),1);
  assert.equal(x.events.some(e=>e.stage==='registered_change_set_verified_unexecuted'),false);
 }
});
test('public proposal command is fixed synthetic target, has no execution or saved-report override and disables write retries',()=>{
 careRegisteredProposalArguments(['--v2-root','.','--artifact','.','--prepare-fictional-registered-code-change-only']);
 for(const a of [[],['--v2-root','.','--artifact','.','--execute'],['--v2-root','.','--report','pass.json','--prepare-fictional-registered-code-change-only'],
  ['--v2-root','.','--artifact','.','--prepare-fictional-registered-code-change-only','--profile','prod']])assert.throws(()=>careRegisteredProposalArguments(a));
 const source=readFileSync(new URL('./prepare-synthetic-care-registered-code-change.mjs',import.meta.url),'utf8'),
  upload=readFileSync(new URL('./upload-synthetic-care-registered-release.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/'execute-change-set'|'update-stack'|'update-function-code'|--report|--target|--skip/);
 assert.match(source,/AWS_MAX_ATTEMPTS:'1'/);assert.match(source,/collectCancellationInventory/);
 assert.match(upload,/registered-artifact-upload-proposal/);assert.match(upload,/fresh=await observeCareRegisteredPreflight/);
});
