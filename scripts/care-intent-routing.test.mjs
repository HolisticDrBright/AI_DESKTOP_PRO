import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {careIntentContinuationFixture} from './test-fixtures/care-intent-continuation.mjs';
import {rehearseCareIntentRouting,intentRecoveryPermission,verifyIntentRecoveryPolicy,verifyIntentRetainedCode,verifyIntentDenialPhase} from './care-intent-routing.mjs';
const sid='alp-care-intent-recovery-'+'a'.repeat(32),clone=structuredClone;
function fixture(){
 const s=careIntentContinuationFixture().supplied,r=s.recovery,calls=[];
 let time=Date.parse(r.startedAt),state=clone(s.deployment.after.transport),n=0;
 state.stage.DeploymentId='original';state.stage.LastDeploymentStatusMessage="Successfully deployed stage with deployment ID 'original'";
 const d={now:()=>time,current:async()=>clone(s.current),inspect:async()=>clone(s.preparation.database),
  retain:async()=>({configuration:clone(r.retained.configuration),codeBytes:Buffer.from(r.retained.codeBytes)}),
  transport:async()=>clone(state),record:async e=>calls.push(e.stage),admit:async e=>calls.push(e.stage),
  consumerPhase:async name=>{calls.push('consumer_'+name);return clone(r.observations[name].filter(v=>v.case!=='existing_cancelled_receipt'));},
  receiptPhase:async name=>clone(r.observations[name].filter(v=>v.case==='existing_cancelled_receipt')),
  denialPhase:async name=>clone(r.preSchemaDenials.filter(v=>v.phase===name)),
  addPermission:async(id,version)=>{calls.push('add');state.policy={Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(id,version)]}),RevisionId:'permission-revision'};},
  removePermission:async()=>{calls.push('remove');state.policy=null;},
  switchUri:async uri=>{calls.push(uri===R.latestArn?'return':'switch');state.integration.IntegrationUri=uri;},
  waitDeployment:async(_previous,uri)=>{calls.push('deployment');time+=1000;state.integration.IntegrationUri=uri;
   state.stage.DeploymentId='deployment'+(++n);state.stage.LastDeploymentStatusMessage=`Successfully deployed stage with deployment ID '${state.stage.DeploymentId}'`;return clone(state);},
  waitMetric:async(start)=>{calls.push('metric');return {Label:'Invocations',Datapoints:[{Timestamp:new Date(start).toISOString(),Sum:25,Unit:'Count'}]};}};
 const input={candidate:s.candidate,current:s.current,latest:s.deployment.after.fn,baseline:s.preparation.database};
 return {d,input,calls,state};
}
test('separate intent profile uses exact version 2 bytes, all 95 Gateway observations, metric and compensation proof',async()=>{
 const f=fixture(),r=await rehearseCareIntentRouting(f.input,f.d,sid);
 assert.equal(r.retained.configuration.Version,'2');assert.equal(Object.values(r.observations).flat().length,75);
 assert.equal(r.preSchemaDenials.length,20);assert.equal(r.metricWitness.qualifier,'2');
 assert.equal(r.databaseAfter.rowCount,23985);assert.equal(r.phiAllowed,false);assert.equal(r.hostedAcceptance,false);
 assert.equal(f.calls.filter(v=>v==='switch').length,1);assert.equal(f.calls.filter(v=>v==='return').length,1);
 assert.equal(f.state.integration.IntegrationUri,R.latestArn);assert.equal(f.state.policy,null);
});
test('incompatible retained versions and unsigned/wrong-scope policies cannot be admitted',async()=>{
 for(const change of [v=>v.Version='1',v=>v.FunctionArn=R.retainedArn,v=>v.CodeSha256='wrong',
  v=>v.Environment.Variables.PHI_ALLOWED='true',v=>v.Role='wrong',v=>v.RuntimeVersionConfig={RuntimeVersionArn:'wrong'}]){
  const f=fixture(),old=f.d.retain;f.d.retain=async()=>{const value=await old();change(value.configuration);return value;};
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid));assert.equal(f.calls.includes('add'),false);
 }
 const f=fixture(),v=await f.d.retain();assert.equal(verifyIntentRetainedCode(v.configuration,v.codeBytes,f.input.latest,f.input.candidate),'2');
 assert.throws(()=>verifyIntentRetainedCode(v.configuration,Buffer.from('wrong'),f.input.latest,f.input.candidate));
 for(const version of ['1','$LATEST','0','2:bad',''])assert.throws(()=>intentRecoveryPermission(sid,version));
 const policy={Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(sid,'2')]}),RevisionId:'r'};
 verifyIntentRecoveryPolicy(policy,sid,'2',true);assert.throws(()=>verifyIntentRecoveryPolicy(policy,sid,'3',true));
 assert.throws(()=>verifyIntentRecoveryPolicy(policy,sid,'2',false));assert.throws(()=>verifyIntentRecoveryPolicy(null,sid,'2',true));
});
test('missing/invalid baseline denials refuse before granting or switching',async()=>{
 for(const mutate of [v=>v.pop(),v=>v[0].status=200,v=>v[0].verified=false,v=>v[0].persona='real',
  v=>v[1].requestId=v[0].requestId,v=>v[0].action='erase_request',v=>v[0].phase='returned']){
  const f=fixture(),old=f.d.denialPhase;f.d.denialPhase=async name=>{const v=await old(name);mutate(v);return v;};
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid));assert.equal(f.calls.includes('add'),false);
 }
 assert.throws(()=>verifyIntentDenialPhase([], 'baseline'));
});
test('lost add response never causes a grant retry and cleans only a proved actual permission',async()=>{
 for(const granted of [true,false]){
  const f=fixture(),add=f.d.addPermission;f.d.addPermission=async(...args)=>{if(granted)await add(...args);else f.calls.push('add');throw Error('reply lost');};
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid),/reply lost/);
  assert.equal(f.calls.filter(v=>v==='add').length,1);assert.equal(f.calls.includes('switch'),false);
  assert.equal(f.state.policy,null);assert.equal(f.state.integration.IntegrationUri,R.latestArn);
 }
});
test('lost switch, failed retained cases and missing metrics restore via independently observed deployment before cleanup',async()=>{
 for(const mode of ['lost_switch','retained_case','metric']){
  const f=fixture(),switchUri=f.d.switchUri,consumer=f.d.consumerPhase;
  if(mode==='lost_switch')f.d.switchUri=async uri=>{await switchUri(uri);if(uri!==R.latestArn)throw Error('switch reply lost');};
  if(mode==='retained_case')f.d.consumerPhase=async name=>{const v=await consumer(name);if(name==='retained')v.pop();return v;};
  if(mode==='metric')f.d.waitMetric=async()=>({Label:'Invocations',Datapoints:[]});
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid));
  assert.equal(f.calls.filter(v=>v==='switch').length,1);assert.equal(f.calls.filter(v=>v==='return').length,1);
  assert.equal(f.state.integration.IntegrationUri,R.latestArn);assert.equal(f.state.policy,null);
  assert.ok(f.calls.lastIndexOf('deployment')<f.calls.indexOf('remove'));
 }
});
test('unrelated transport drift never gets overwritten or certified as restored',async()=>{
 for(const mode of ['other_uri','role_authority','changed_revision','failed_cleanup']){
  const f=fixture(),consumer=f.d.consumerPhase;
  f.d.consumerPhase=async name=>{const values=await consumer(name);if(name==='retained'){
   if(mode==='other_uri')f.state.integration.IntegrationUri='arn:unrelated';
   if(mode==='role_authority')f.state.routesSha256='f'.repeat(64);
   if(mode==='changed_revision')f.state.revisionId='changed';
   if(mode==='failed_cleanup')f.d.removePermission=async()=>{throw Error('denied');};
  }return values;};
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid),/routing_restoration_unconfirmed/);
  assert.equal(f.calls.includes('intent_compatible_routing_completed'),false);
  if(mode!=='failed_cleanup')assert.equal(f.calls.includes('return'),false);
 }
});
test('database drift, duplicate Gateway evidence and changed receipt contents cannot claim acceptance',async()=>{
 for(const mode of ['database','requests','receipt']){
  const f=fixture();let n=0;
  if(mode==='database')f.d.inspect=async()=>({...clone(f.input.baseline),rowCount:++n===1?23985:23986});
  if(mode==='requests'){const old=f.d.consumerPhase;f.d.consumerPhase=async name=>{const values=await old(name);
   if(name==='returned')values[0].requestId='gateway-request-1';return values;};}
  if(mode==='receipt'){const old=f.d.receiptPhase;f.d.receiptPhase=async name=>{const values=await old(name);
   if(name==='retained')values[0].bodySha256='f'.repeat(64);return values;};}
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid));assert.equal(f.calls.includes('intent_compatible_routing_completed'),false);
 }
});
test('custody admission failure prevents the next corresponding mutation',async()=>{
 for(const stage of ['intent_permission_admitted','intent_retained_switch_admitted','intent_latest_return_admitted']){
  const f=fixture();f.d.admit=async e=>{f.calls.push(e.stage);if(e.stage===stage)throw Error('journal unavailable');};
  await assert.rejects(rehearseCareIntentRouting(f.input,f.d,sid));
  if(stage==='intent_permission_admitted')assert.equal(f.calls.includes('add'),false);
  if(stage==='intent_retained_switch_admitted')assert.equal(f.calls.includes('switch'),false);
  assert.equal(f.state.integration.IntegrationUri,R.latestArn);assert.equal(f.state.policy,null);
 }
});
