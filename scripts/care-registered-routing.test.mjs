import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_REGISTERED as C} from './synthetic-care-registered-release.mjs';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from './care-recovery-routing.mjs';
import {PERSONA_EMAILS,CARE_CONSUMER_CASES} from './verify-synthetic-care-consumer.mjs';
import {careRegisteredDeploymentFixture} from './test-fixtures/care-registered-deployment.mjs';
import {verifyCareRegisteredRoutingControl,verifyCareRegisteredSuccessorControl} from './care-registered-preflight.mjs';
import {rehearseCareRegisteredRouting,verifyRegisteredIntentPhase,verifyRegisteredIntentAnswer} from './care-registered-routing.mjs';
import {compileRegisteredIntentParser} from './care-registered-routing-live.mjs';
import {intentRecoveryPermission} from './care-intent-routing.mjs';
let parse;
before(async()=>{parse=await compileRegisteredIntentParser(process.cwd());});
const clone=structuredClone,sid='alp-care-intent-recovery-'+'b'.repeat(32);
function fixture(){
 const f=careRegisteredDeploymentFixture(),state={now:f.completed,raw:clone(f.after.raw),policy:null,writes:[],sequence:0},events=[];
 const configuration=clone(f.before.raw.fn);configuration.Version='2';configuration.FunctionArn=R.latestArn+':2';
 const retained={configuration,sha256:C.predecessorZip,bytes:C.predecessorBytes,policy:null},
  ids=Object.keys(PERSONA_EMAILS).map((_,i)=>`${String(i+1).padStart(8,'0')}-0000-4000-8000-000000000001`);
 const receiptRows=phase=>Object.keys(PERSONA_EMAILS).map((persona,i)=>({persona,case:'existing_cancelled_receipt',erasureRequestId:ids[i],
  requestId:`receipt-${phase}-${i}`,status:200,outcome:'cancelled',verified:true,bodySha256:'e'.repeat(64)}));
 const d={now:()=>state.now,current:async()=>clone(f.current),custody:async()=>{},parseIntent:parse,
  identity:async()=>({Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'}),
  inspect:async()=>({...clone(f.after.database),observedAt:new Date(state.now).toISOString()}),
  record:async e=>events.push(e),admit:async e=>events.push(e),
  transport:async()=>({raw:clone(state.raw),policy:clone(state.policy)}),retained:async()=>clone(retained),
  consumerPhase:async phase=>{state.now+=1000;return Object.keys(PERSONA_EMAILS).flatMap((persona,i)=>CARE_CONSUMER_CASES.map((s,j)=>({
   persona,case:s.name,requestId:`consumer-${phase}-${i}-${j}`,status:s.status,verified:true,bodySha256:'d'.repeat(64)})));},
  receiptPhase:async phase=>receiptRows(phase),
  intentPhase:async phase=>Object.keys(PERSONA_EMAILS).flatMap((persona,i)=>['discover_erasure_requests','prepare_erasure'].map(action=>{
   const value=action==='prepare_erasure'?{error:'request_invalid'}:{data:{action,items:[{requestId:ids[i],scope:'domain',
    outcome:'cancelled',receipt:null,intentRegistered:false,registeredAt:null,completedAt:'2026-10-08T05:00:00Z'}],
    next:null,legacyUncorrelatedErasureCount:0,coverage:'committed_owner_records_not_global_clearance'}};
   return {persona,phase,action,expectedRequestId:ids[i],requestId:`intent-${phase}-${i}-${action}`,
    status:action==='prepare_erasure'?400:200,value,bodySha256:sha256(canonical(value))};})),
  addPermission:async(s,v)=>{state.writes.push('add');state.policy={RevisionId:'fictional-permission',
   Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(s,v)]})};},
  removePermission:async()=>{state.writes.push('remove');state.policy=null;},
  switchUri:async uri=>{state.writes.push(uri);state.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri=uri;
   const stage=state.raw.stage;stage.DeploymentId='stage'+ ++state.sequence;
   stage.LastDeploymentStatusMessage=`Successfully deployed stage with deployment ID '${stage.DeploymentId}'`;},
  waitDeployment:async()=>d.transport(),
  waitMetric:async start=>({Label:'Invocations',Datapoints:[{Timestamp:new Date(start).toISOString(),Sum:35,Unit:'Count'}]}),
 };
 const input={candidate:f.candidate,current:f.current,artifact:f.artifact,sourceText:f.sourceText,latest:clone(f.after.raw.fn)};
 return {f,input,d,state,events,retained,receiptRows};
}
const run=x=>rehearseCareRegisteredRouting(x.input,x.d,sid);
test('current-schema routing visits actual older intent code, verifies105 observations and returns without granting release',async()=>{
 const x=fixture(),r=await run(x);
 assert.equal(r.retainedVersion,'2');assert.equal(r.predecessorZipSha256,C.predecessorZip);
 assert.equal(Object.values(r.observations).flat().length,75);assert.equal(Object.values(r.intents).flat().length,30);
 assert.equal(r.functionalRoutingRecoveryVerified,true);assert.equal(r.temporaryPermissionRemoved,true);
 for(const k of ['schemaChanged','hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 assert.equal(x.state.policy,null);assert.equal(r.reportIsNotAuthority,true);
 assert.deepEqual(x.state.writes,['add',R.latestArn+':2',R.latestArn,'remove']);
 assert(x.events.findIndex(e=>e.stage==='registered_recovery_permission_admitted')<x.events.findIndex(e=>e.stage==='registered_recovery_switch_admitted'));
});
test('temporary URI profile exhausts unmodified raw inventory and admits only exact retained2',()=>{
 const x=fixture(),raw=clone(x.f.after.raw);raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri=R.latestArn+':2';
 const saved=canonical(raw);assert.doesNotThrow(()=>verifyCareRegisteredRoutingControl(raw,x.f.source,x.f.candidate,x.f.current,x.f.artifact,'2'));
 assert.equal(canonical(raw),saved);assert.throws(()=>verifyCareRegisteredSuccessorControl(raw,x.f.source,x.f.candidate,x.f.current,x.f.artifact));
 for(const v of ['1','3','2:alias',null])assert.throws(()=>verifyCareRegisteredRoutingControl(raw,x.f.source,x.f.candidate,x.f.current,x.f.artifact,v));
 for(const mutate of [r=>r.routes.Items.pop(),r=>r.integrations.NextToken='more',r=>r.authorizers.Items[0].JwtConfiguration.Audience=['other'],
  r=>r.fn.Environment.Variables.PHI_ALLOWED='true',r=>r.logGroups.logGroups[0].retentionInDays=1]){
  const r=clone(raw);mutate(r);assert.throws(()=>verifyCareRegisteredRoutingControl(r,x.f.source,x.f.candidate,x.f.current,x.f.artifact,'2'));
 }
});
test('discovery uses the real compiled strict application parser, correlated receipt and exact body digest',async()=>{
 const x=fixture(),receipts=x.receiptRows('baseline'),values=await x.d.intentPhase('baseline');
 assert.doesNotThrow(()=>verifyRegisteredIntentPhase(values,'baseline',receipts,parse));
 for(const change of [v=>v.pop(),v=>v[0].persona='other',v=>v[0].expectedRequestId=v[2].expectedRequestId,
  v=>v[0].bodySha256='f'.repeat(64),v=>v[1].status=200,v=>v[1].value={data:{action:'prepare_erasure'}},
  v=>v[0].value.data.items[0].outcome='erased',v=>v[0].value.data.items[0].unexpected=true,
  v=>v[0].value.data.next=v[0].expectedRequestId,v=>v[0].value.data.items=[],
  v=>v[0].value.verified=true,v=>v[1].requestId=v[0].requestId]){
  const v=clone(values);change(v);assert.throws(()=>verifyRegisteredIntentPhase(v,'baseline',receipts,parse));
 }
 assert.throws(()=>verifyRegisteredIntentAnswer('prepare_erasure',503,{error:'service_unavailable'},values[0].expectedRequestId,parse));
});
test('preexisting permission, wrong predecessor, changed source/custody and invalid database never admit a route write',async()=>{
 for(const kind of ['permission','version','hash','bytes','source','custody','database','principal','root']){
  const x=fixture();
  if(kind==='permission')x.state.policy={Policy:'other'};
  if(kind==='version')x.retained.configuration.Version='1';if(kind==='hash')x.retained.sha256='f'.repeat(64);
  if(kind==='bytes')x.retained.bytes++;if(kind==='source')x.d.current=async()=>({...x.f.current,templateSha256:'0'.repeat(64)});
  if(kind==='custody')x.d.custody=async()=>{throw Error('custody lost');};
  if(kind==='database')x.d.inspect=async()=>({...clone(x.f.after.database),phiAllowed:true});
  if(kind==='root')x.d.identity=async()=>({Account:P.account,Arn:`arn:aws:iam::${P.account}:root`});
  if(kind==='principal'){let count=0;const identity=x.d.identity;x.d.identity=async()=>{const v=await identity();if(++count>1)v.Arn+='changed';return v;};}
  await assert.rejects(run(x));assert.deepEqual(x.state.writes,[]);
 }
});
test('durable admission must finish before each associated mutation; late failures restore or retain custody',async()=>{
 for(const stage of ['registered_recovery_permission_admitted','registered_recovery_switch_admitted','registered_recovery_return_admitted']){
  const x=fixture(),admit=x.d.admit;x.d.admit=async e=>{if(e.stage===stage)throw Error('fsync failed');await admit(e);};
  await assert.rejects(run(x));assert.equal(x.events.some(e=>e.stage==='registered_compatible_routing_completed'),false);
  if(stage==='registered_recovery_permission_admitted')assert.deepEqual(x.state.writes,[]);
  else{assert.equal(x.state.policy,null);assert.equal(x.state.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri,R.latestArn);}
 }
});
test('failed retained answers, lost applied switch and missing version metrics compensate without claiming a pass',async()=>{
 for(const kind of ['answer','lost_switch','metric']){
  const x=fixture();
  if(kind==='answer'){const phase=x.d.intentPhase;x.d.intentPhase=async name=>{const v=await phase(name);if(name==='retained')v[0].status=503;return v;};}
  if(kind==='lost_switch'){const change=x.d.switchUri;x.d.switchUri=async uri=>{await change(uri);if(uri.endsWith(':2'))throw Error('lost switch response');};}
  if(kind==='metric')x.d.waitMetric=async()=>({Label:'Invocations',Datapoints:[]});
  await assert.rejects(run(x));assert.equal(x.state.policy,null);
  assert.equal(x.state.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri,R.latestArn);
  assert.equal(x.events.some(e=>e.stage==='registered_compatible_routing_completed'),false);
 }
});
test('unexpected targets or control drift are never overwritten by recovery cleanup',async()=>{
 for(const kind of ['target','foreign','authority']){
  const x=fixture(),phase=x.d.consumerPhase;
  x.d.consumerPhase=async name=>{const v=await phase(name);if(name==='retained'){
   if(kind==='target')x.state.raw.integrations.Items.find(i=>i.IntegrationId===R.integrationId).IntegrationUri='other';
   if(kind==='foreign')x.state.raw.integrations.Items.push({IntegrationId:'foreign',IntegrationUri:'other'});
   if(kind==='authority')x.state.raw.routes.Items.at(-1).RouteKey='GET /changed';
  }return v;};
  await assert.rejects(run(x),/routing_restoration_unconfirmed/);
  assert.equal(x.state.writes.includes(R.latestArn),false);assert.equal(x.state.policy!==null,true);
 }
});
test('changed receipts, replayed request IDs, changed database and retained bytes cannot certify recovery',async()=>{
 for(const kind of ['receipt','request','database','retained']){
  const x=fixture();
  if(kind==='receipt'){const phase=x.d.receiptPhase;x.d.receiptPhase=async name=>{const v=await phase(name);if(name==='retained')v[0].bodySha256='a'.repeat(64);return v;};}
  if(kind==='request'){const phase=x.d.intentPhase;x.d.intentPhase=async name=>{const v=await phase(name);if(name==='retained')v[0].requestId='intent-baseline-0-discover_erasure_requests';return v;};}
  if(kind==='database'){let count=0;const inspect=x.d.inspect;x.d.inspect=async()=>{const v=await inspect();if(++count===2)v.historicalInspection.rowCount++;return v;};}
  if(kind==='retained'){let count=0;const read=x.d.retained;x.d.retained=async()=>{const v=await read();if(++count===2)v.sha256='f'.repeat(64);return v;};}
  await assert.rejects(run(x));assert.equal(x.events.some(e=>e.stage==='registered_compatible_routing_completed'),false);
 }
});
test('live bindings contain no arbitrary CLI target, report override, code publish/update or admitted erasure',()=>{
 const text=readFileSync(new URL('./care-registered-routing-live.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(text,/process\.argv|--profile.*process\.env|update-function-code|publish-version|randomUUID|action:'erase'|action:'cancel_erasure'/);
 assert.match(text,/compileRegisteredIntentParser/);assert.match(text,/parseCareErasureRecoveryResponse/);
 assert.match(text,/AWS_MAX_ATTEMPTS:'1'/);assert.match(text,/owner_id=cast\(:owner as uuid\)/);
 assert.match(text,/finally\{for\(const row of rows\)/);assert.match(text,/retained:async/);
 assert.equal(P.account,'588966314750');
});
