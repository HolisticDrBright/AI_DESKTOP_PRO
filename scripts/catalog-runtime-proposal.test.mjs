import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {careRegisteredDatabaseFixture} from './test-fixtures/care-registered-database.mjs';
import {catalogRuntimeProposalFixture as fixture} from './test-fixtures/catalog-runtime-proposal.mjs';
import {runCatalogRuntimeProposal} from './catalog-runtime-proposal.mjs';
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
const propose=x=>runCatalogRuntimeProposal(x.f.candidate,x.f.current,x.f.sourceText,x.f.preflight,x.f.artifact,x.port);

function renewalPort(x){
 let renewals=0;
 x.port.refreshPreflight=async()=>{
  renewals++;
  const r=structuredClone(x.f.preflight),db=careRegisteredDatabaseFixture(x.f.current,x.f.now);
  r.observedAt=new Date(x.f.now).toISOString();
  db.observedAt=r.observedAt;db.operatorSource={sourceCommit:x.f.current.desktop.commit,clean:true};
  r.databaseBefore=structuredClone(db);r.databaseAfter=structuredClone(db);return r;
 };
 return ()=>renewals;
}
test('renewal re-observes the full bound preflight after slow create without replaying create or widening the TTL',async()=>{
 const x=executionFixture(),count=renewalPort(x),create=x.port.create;
 x.port.control=async()=>{x.f.now+=35000;return structuredClone(x.f.raw);};
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
 assert.equal(x.events.at(-1).stage,'catalog_runtime_change_set_verified_unexecuted');
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
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_verified_unexecuted'),false,kind);
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
 assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_verified_unexecuted'),false);
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
   if(kind==='wrong_database')r.databaseAfter.catalogInspection.dataSha256='0'.repeat(64);
   if(kind==='identity')x.caller.Arn+='different';return r;
  };
  await assert.rejects(propose(x),undefined,kind);assert.equal(x.creates(),0,kind);
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_create_admitted'),false,kind);
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
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_verified_unexecuted'),false);
 }
});
test('proposal runner admits exactly once before create, observes both views and repeated complete controls; never executes',async()=>{
 const x=executionFixture(),report=await propose(x);
 assert.equal(x.creates(),1);assert.equal(report.changeSetCreated,true);assert.equal(report.deployed,false);
 assert.equal(report.executionAdmissible,false);assert.equal(report.phiAllowed,false);assert.equal(x.saved.length,1);
 assert(x.events.findIndex(e=>e.stage==='catalog_runtime_change_set_create_admitted')<x.events.findIndex(e=>e.stage==='actual_create'));
 assert.equal(x.events.at(-1).stage,'catalog_runtime_change_set_verified_unexecuted');
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
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_create_admitted'),false);
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
  assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_verified_unexecuted'),false);
 }
});

test('awaited admission failure, drift or expired freshness never reaches create or renews an admitted write',async()=>{
 for(const kind of ['failed_journal','source','principal','control','expiry']){
  const x=executionFixture();renewalPort(x);
  x.port.admit=async e=>{await Promise.resolve();x.events.push(e);
   if(kind==='failed_journal')throw Error('journal unavailable');
   if(kind==='source')x.f.current.desktop.sha256='0'.repeat(64);
   if(kind==='principal')x.caller.Arn+='changed';
   if(kind==='control')x.f.raw.fn.RevisionId+='changed';
   if(kind==='expiry')x.f.now+=120001;
  };
  await assert.rejects(propose(x),undefined,kind);assert.equal(x.creates(),0,kind);assert.equal(x.saved.length,0,kind);
 }
});

test('caller and write-input mutation cannot change the captured code, parameters, artifact or report',async()=>{
 const x=executionFixture(),identity=x.port.identity,initial=structuredClone(x.f.artifact);
 x.port.identity=async()=>{const caller=await identity();x.f.artifact.versionId='caller-changed';x.f.candidate.bundle[0]^=1;return caller;};
 x.port.writeInput=async(fixed,input)=>{fixed.name='caller-changed';input.parameters[0].ParameterValue='changed';input.template.Resources={};};
 const report=await propose(x);assert.deepEqual(report.artifact,initial);assert.equal(x.creates(),1);
});

test('a failed asynchronous verification journal never returns a completed report',async()=>{
 const x=executionFixture();x.port.record=async e=>{await Promise.resolve();
  if(e.stage==='catalog_runtime_change_set_verified_unexecuted')throw Error('verification journal unavailable');x.events.push(e);};
 await assert.rejects(propose(x));assert.equal(x.creates(),1);assert.equal(x.saved.length,1);
 assert.equal(x.events.some(e=>e.stage==='catalog_runtime_change_set_verified_unexecuted'),false);
});
