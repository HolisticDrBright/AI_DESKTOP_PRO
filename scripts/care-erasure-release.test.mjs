import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from './care-recovery-routing.mjs';
import {CARE_CONSUMER_CASES,PERSONA_EMAILS} from './verify-synthetic-care-consumer.mjs';
import {releaseCareErasure} from './care-erasure-release.mjs';
import {careErasureReleaseArgs,verifyCareErasureReleaseArtifact} from './release-synthetic-care-erasure.mjs';
import {continueCareRecovery} from './rehearse-synthetic-care-routing.mjs';
const digest='b'.repeat(64),source={commit:'a'.repeat(40),sha256:digest,clean:true,files:100},start=1700000000000;
function fixture(){
 let request=0,time=start+20000,applied=false;const calls=[];
 const transport={integration:{IntegrationId:R.integrationId,IntegrationUri:R.latestArn,IntegrationType:'AWS_PROXY',IntegrationMethod:'POST',
  ConnectionType:'INTERNET',PayloadFormatVersion:'2.0',TimeoutInMillis:30000},
  stage:{StageName:'$default',AutoDeploy:true,DeploymentId:'returned',LastDeploymentStatusMessage:"Successfully deployed stage with deployment ID 'returned'",
   DefaultRouteSettings:{DetailedMetricsEnabled:true,ThrottlingBurstLimit:20,ThrottlingRateLimit:10},
   AccessLogSettings:{DestinationArn:`arn:aws:logs:${P.region}:${P.account}:log-group:/ai-clinical-core/synthetic-staging/api-access`,
    Format:'{"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength"}'}},
  policy:null,revisionId:'latest-revision',routesSha256:digest,authorizersSha256:digest,otherIntegrationsSha256:digest,latestPolicySha256:digest};
 const cases=()=>Object.keys(PERSONA_EMAILS).flatMap(persona=>CARE_CONSUMER_CASES.map(c=>({persona,case:c.name,status:c.status,
  requestId:'request-'+(++request),bodySha256:digest,verified:true})));
 const recovery={contract:'synthetic-care-retained-routing-rehearsal/1',scope:'preupgrade-retained-routing-only',execution:'synthetic-staging',
  account:P.account,retainedVersion:'1',verdict:'pass',harness:structuredClone(source),
  baselineDatabase:{liveCount:46,sourceCount:45,tableCount:87,liveLedger:P.liveBefore,referenceLedger:P.reference,rows:1234,dataSha256:digest},
  observations:{baseline:cases(),retained:cases(),returned:cases()},
  transportWitness:{restored:structuredClone(transport),originalDeployment:'original',retainedDeployment:'retained',returnedDeployment:'returned'},
  metricWitness:{start:Math.floor(start/60000)*60000,end:Math.ceil((start+20000)/60000)*60000,minimum:20,
   response:{Label:'Invocations',Datapoints:[{Timestamp:new Date(Math.floor(start/60000)*60000).toISOString(),Sum:20,Unit:'Count'}]}},
  functionalRoutingRecoveryVerified:true,returnToCandidateVerified:true,temporaryPermissionRemoved:true,originalRoutingRestored:true,
  schemaChanged:false,afterUpgradeVerified:false,terminalReceiptRecoveryVerified:false,upgradeAuthorized:false,fullJourneyAcceptance:false,
  physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false,startedAt:new Date(start).toISOString(),completedAt:new Date(start+20000).toISOString()};
 const d={started:start,now:()=>time,source:async()=>{calls.push('source');return structuredClone(source);},
  transport:async()=>{calls.push('transport');return structuredClone(transport);},
  schema:async command=>{calls.push(command);const wasApplied=applied;if(command==='upgrade')applied=true;
   return {contract:'care-erasure-schema-upgrade/1',command,execution:'synthetic-staging',phiAllowed:false,
    awsAccountId:P.account,foundation:P.foundation,operatorSource:{sourceCommit:source.commit,clean:true},
    observedMigrationCount:applied?47:46,sourceMigrationCount:applied?46:45,tableCount:applied?88:87,rowCount:1234,
    dataSha256:wasApplied?'c'.repeat(64):digest,originalDataSha256:digest,originalRowCount:1234,dataPreserved:true,
    applied:command==='upgrade',alreadyApplied:wasApplied,rolledBack:command==='rehearse',fromLedgerSha256:P.liveBefore,
    toLedgerSha256:P.liveAfter,referenceLedgerSha256:P.reference};}};
 return {d,recovery,calls,transport,advance:ms=>time+=ms};
}
test('release has a fresh actual-observer sequence and independent original-row readback, never PHI evidence',async()=>{
 const f=fixture(),out=await releaseCareErasure(f.recovery,f.d);
 assert.equal(out.schemaChanged,true);assert.equal(out.preservationVerified,true);assert.equal(out.after.alreadyApplied,true);
 for(const k of ['postUpgradeJourneyVerified','terminalReceiptRecoveryVerified','fullJourneyAcceptance','qualificationEvidence','activationEvidence','phiAllowed','paidMobileBuildStarted'])assert.equal(out[k],false);
 assert.deepEqual(f.calls.filter(c=>c!=='source'),['transport','inspect','rehearse','transport','upgrade','inspect','transport']);
});
test('confirmation alone, saved report flags and target/activation overrides have no command path',()=>{
 careErasureReleaseArgs(['--release-fictional-care-erasure-with-fresh-recovery']);
 for(const args of [[],['upgrade'],['--approve'],['--release-fictional-care-erasure-with-fresh-recovery','--report=old.json'],
 ['--release-fictional-care-erasure-with-fresh-recovery','--skip-recovery'],['--release-fictional-care-erasure-with-fresh-recovery','--phi']])assert.throws(()=>careErasureReleaseArgs(args));
});
test('old, absent, claimed-approved, source-mismatched and incomplete recovery never opens the database',async()=>{
 const changes=[r=>delete r.completedAt,r=>r.startedAt=new Date(start-1).toISOString(),r=>r.completedAt=new Date(start+20001).toISOString(),
 r=>r.scope='postupgrade',r=>r.verdict='refused',r=>r.upgradeAuthorized=true,r=>r.phiAllowed=true,r=>r.harness.clean=false,
 r=>r.harness.commit='c'.repeat(40),r=>r.transportWitness.restored.policy={},r=>r.observations.retained.pop(),
 r=>r.observations.returned[0].requestId=r.observations.baseline[0].requestId,r=>r.metricWitness.response.Datapoints=[],
 r=>r.metricWitness.minimum=0,r=>r.baselineDatabase.liveCount=47,r=>r.transportWitness.returnedDeployment='retained'];
 for(const change of changes){const f=fixture();change(f.recovery);await assert.rejects(releaseCareErasure(f.recovery,f.d));assert.equal(f.calls.includes('inspect'),false);}
 const f=fixture();f.advance(300001);await assert.rejects(releaseCareErasure(f.recovery,f.d),/fresh_recovery_required/);assert.equal(f.calls.includes('inspect'),false);
});
test('routing, stage, policy or code revision drift before commit is refused',async()=>{
 for(const change of [t=>t.revisionId='changed',t=>t.latestPolicySha256='c'.repeat(64),t=>t.integration.IntegrationUri=R.retainedArn,
 t=>t.routesSha256='c'.repeat(64),t=>t.stage.DeploymentId='unobserved',t=>t.policy={}]){
  const f=fixture(),schema=f.d.schema;f.d.schema=async c=>{const r=await schema(c);if(c==='rehearse')change(f.transport);return r;};
  await assert.rejects(releaseCareErasure(f.recovery,f.d));assert.equal(f.calls.includes('upgrade'),false);
 }
});
test('source drift or freshness expiry during rehearsal prevents commit',async()=>{
 for(const point of ['source','time']){const f=fixture(),schema=f.d.schema;let altered=false;
  f.d.source=async()=>altered?{...source,sha256:'c'.repeat(64)}:structuredClone(source);
  f.d.schema=async c=>{const r=await schema(c);if(c==='rehearse'){if(point==='source')altered=true;else f.advance(300001);}return r;};
  await assert.rejects(releaseCareErasure(f.recovery,f.d));assert.equal(f.calls.includes('upgrade'),false);}
});
test('rollback, ledger, preserved rows, old source and post-commit readback failures never report completion',async()=>{
 for(const command of ['inspect','rehearse','upgrade','postinspect'])for(const patch of [
  {originalDataSha256:'c'.repeat(64)},{originalRowCount:1235},{rowCount:1235},{dataPreserved:false},
  {referenceLedgerSha256:'c'.repeat(64)},{phiAllowed:true},{sourceMigrationCount:100},{operatorSource:{sourceCommit:'c'.repeat(40),clean:true}}]){
  const f=fixture(),schema=f.d.schema;let inspected=0;
  f.d.schema=async c=>{const r=await schema(c),mode=c==='inspect'&&++inspected===2?'postinspect':c;return mode===command?{...r,...patch}:r;};
  await assert.rejects(releaseCareErasure(f.recovery,f.d));
  if(['inspect','rehearse'].includes(command))assert.equal(f.calls.includes('upgrade'),false);
 }
 const f=fixture(),schema=f.d.schema;f.d.schema=async c=>({...await schema(c),...(c==='rehearse'?{rolledBack:false}:{})});
 await assert.rejects(releaseCareErasure(f.recovery,f.d));assert.equal(f.calls.includes('upgrade'),false);
});
test('recovery result is snapshotted; a dependency cannot mutate the captured witness into passing',async()=>{
 const f=fixture(),schema=f.d.schema;
 f.d.schema=async c=>{const r=await schema(c);if(c==='rehearse'){f.transport.revisionId='changed';f.recovery.transportWitness.restored.revisionId='changed';}return r;};
 await assert.rejects(releaseCareErasure(f.recovery,f.d),/restored_transport_drift/);assert.equal(f.calls.includes('upgrade'),false);
});
test('fresh self-contained database artifact embeds the exact histories and refuses a dirty/stale port',()=>{
 execFileSync(process.execPath,['scripts/build-care-erasure-release.mjs','--historical-source-only'],{encoding:'utf8',timeout:30000});
 const dir='dist/aws-clinical-core/care-erasure-release/',bytes=readFileSync(dir+'index.cjs'),manifest=JSON.parse(readFileSync(dir+'artifact-manifest.json','utf8'));
 assert.equal(manifest.sha256,sha256(bytes));assert.equal(manifest.mandatoryFreshRoutingRecovery,true);assert.match(bytes.toString(),/3890daeb708511a0f651abd95456906048fb9f4a7bc1ef754b731e9d673dab91/);
 const fictional={...manifest,sourceCommit:source.commit,clean:true};verifyCareErasureReleaseArtifact(fictional,bytes,source);
 for(const [key,value] of Object.entries({sourceCommit:'c'.repeat(40),clean:false,sha256:digest,expectedLiveBefore:47,
  phiAllowed:true,targetOverrides:true,mandatoryFreshRoutingRecovery:false,mandatoryRollbackRehearsal:false}))assert.throws(()=>verifyCareErasureReleaseArtifact({...fictional,[key]:value},bytes,source));
});
test('actual entry point runs live recovery in-process without a mutation-killing child timeout or report override',()=>{
 const code=readFileSync(new URL('./release-synthetic-care-erasure.mjs',import.meta.url),'utf8'),runner=readFileSync(new URL('./rehearse-synthetic-care-routing.mjs',import.meta.url),'utf8');
 assert.match(code,/await runCareRecovery\(async\(recovery,transport\)/);assert.match(code,/source:async\(\)=>careSourceSnapshot/);
 assert.doesNotMatch(code,/process\.env|--report|--skip/);assert.match(runner,/!custody.admitted\|\|custody.finished/);
 assert.match(runner,/continuation_admitted/);assert.match(runner,/continuation_completed/);assert.equal(canonical(source),canonical(structuredClone(source)));
});
test('continuation custody is durable and preserves an unsettled lock on unknown schema or report outcomes',async()=>{
 for(const failure of ['admission','schema','completion',null]){
  const custody={admitted:false,finished:false},events=[],report={fictional:true},transport=async()=>null;
  const record=async stage=>{events.push(stage);if(stage===(failure==='admission'?'continuation_admitted':failure==='completion'?'continuation_completed':''))throw Error('journal failure');};
  const action=async(r,t)=>{assert.equal(r,report);assert.equal(t,transport);assert.equal(custody.admitted,true);assert.equal(custody.finished,false);
   events.push('schema');if(failure==='schema')throw Error('unknown commit');return 'readback';};
  if(failure){await assert.rejects(continueCareRecovery(report,transport,action,record,custody));assert.equal(custody.finished,false);
   assert.equal(custody.admitted,failure!=='admission');if(failure==='admission')assert.equal(events.includes('schema'),false);
  }else{assert.deepEqual(await continueCareRecovery(report,transport,action,record,custody),{recovery:report,continuation:'readback'});
   assert.deepEqual(custody,{admitted:true,finished:true});assert.deepEqual(events,['continuation_admitted','schema','continuation_completed']);}
 }
});
