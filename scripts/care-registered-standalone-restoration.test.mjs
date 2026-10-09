import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {compileRegisteredIntentParser} from './care-registered-routing-live.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {sha256} from './synthetic-care-release.mjs';
import {intentRecoveryPermission} from './care-intent-routing.mjs';
import {runRegisteredStandaloneRehearsal} from './care-registered-standalone.mjs';
import {runRegisteredStandaloneRestoration} from './care-registered-standalone-restoration.mjs';
import {verifyRegisteredStandaloneCustody} from './care-registered-standalone-custody.mjs';
import {careRegisteredStandaloneFixture} from './test-fixtures/care-registered-standalone.mjs';
let parse;before(async()=>{parse=await compileRegisteredIntentParser(process.cwd());});
const fresh=()=>careRegisteredStandaloneFixture(parse);
const route=f=>f.after.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId);
const writes=f=>f.calls.filter(v=>['return','remove','grant',R.latestArn,R.latestArn+':2'].includes(v));
function prepare(f,events){
 f.events=events;f.custody=f.encode();f.now+=61000;f.sid='alp-care-intent-recovery-'+f.lock.runId;
 f.port.pid=9999999;f.port.retained=async()=>({...structuredClone(f.retained),policy:structuredClone(f.policy)});
 f.port.returnLatest=async()=>{f.calls.push('return');route(f).IntegrationUri=R.latestArn;
  f.after.raw.stage.DeploymentId='compensated'+ ++f.sequence;
  f.after.raw.stage.LastDeploymentStatusMessage=`Successfully deployed stage with deployment ID '${f.after.raw.stage.DeploymentId}'`;};
 f.port.waitLatest=async previous=>{assert.equal(route(f).IntegrationUri,R.latestArn);assert.notEqual(f.after.raw.stage.DeploymentId,previous);};
 f.port.removePermission=async(sid,revision)=>{assert.equal(sid,f.sid);assert.equal(revision,f.policy.RevisionId);f.calls.push('remove');f.policy=null;};
 f.resume=()=>{f.now+=61000;f.custody=f.encode();};f.calls=[];return f;
}
async function completed(){const f=fresh();await runRegisteredStandaloneRehearsal(f.candidate,f.operator,f.custody,f.sourceText,f.port);return prepare(f,[...f.events]);}
async function stopped(){const f=await completed(),index=f.events.findIndex(e=>e.stage==='registered_recovery_switch_admitted');
 f.events=f.events.slice(0,index+1);f.custody=f.encode();route(f).IntegrationUri=R.latestArn+':2';
 f.policy={RevisionId:'own-permission',Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(f.sid,'2')]})};return f;}
const run=f=>runRegisteredStandaloneRestoration(f.candidate,f.operator,f.custody,f.sourceText,f.port);
const verify=f=>verifyRegisteredStandaloneCustody(f.encode(),f.current,f.lock.operatorSource,f.origin,f.now+61000,f.port.evidence,{restorationOperator:f.operator});
test('stopped standalone compensates its own SID and preserves original release and test prefix',async()=>{
 const f=await stopped(),prefix=Buffer.from(f.custody.journalBytes),original=Buffer.from(f.original.journalBytes),r=await run(f);
 assert.deepEqual(writes(f),['return','remove']);assert.equal(r.restorationMode,'compensating-stopped-test');
 assert.equal(r.originalReleaseOutcome,'failed');assert.equal(r.originalRunOutcome,'interrupted');
 assert.equal(r.originalReleaseResultPreserved,true);assert.equal(r.standaloneOutcomePreserved,true);
 assert(f.encode().journalBytes.subarray(0,prefix.length).equals(prefix));assert(f.original.journalBytes.equals(original));
 assert.equal(r.journalSha256,sha256(f.encode().journalBytes));assert.equal((await verify(f)).restoration.observed,true);
 for(const k of ['retryPerformed','executionAdmissible','recoveryRehearsed','schemaChanged','deletionCertified','hostedAcceptance',
  'erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
});
test('every pre-grant crash prefix settles read-only without granting or replaying a release',async()=>{
 const complete=await completed(),events=[...complete.events],grant=events.findIndex(e=>e.stage==='registered_recovery_permission_admitted');
 for(let n=1;n<=grant;n++){const f=await completed();prepare(f,events.slice(0,n));
  assert.equal((await run(f)).restorationVerified,true);assert.deepEqual(writes(f),[]);assert.equal((await verify(f)).restoration.observed,true);}
});
test('failed pre-grant test remains failed after read-only settlement',async()=>{
 const f=fresh();f.port.recovery=async()=>{throw Error('fictional read failed');};
 await assert.rejects(runRegisteredStandaloneRehearsal(f.candidate,f.operator,f.custody,f.sourceText,f.port));prepare(f,[...f.events]);
 const r=await run(f);assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalFailure,f.events.find(e=>e.stage==='registered_standalone_finding').code);
 assert.deepEqual(writes(f),[]);assert.equal(r.recoveryRehearsed,false);
});
test('completed test receives read-only settlement, not a new functional qualification',async()=>{
 const f=await completed(),r=await run(f);assert.deepEqual(writes(f),[]);assert.equal(r.restorationMode,'read-only-completion');
 assert.equal(r.completedTestResultNotRequalified,true);assert.equal(r.originalRunOutcome,'completed');assert.equal(r.recoveryRehearsed,false);
 assert.equal((await verify(f)).restoration.observed,true);f.resume();await run(f);assert.deepEqual(writes(f),[]);
});
test('completed route or permission drift refuses before poisoning its read-only journal',async()=>{
 for(const kind of ['route','permission']){const f=await completed(),prefix=Buffer.from(f.custody.journalBytes);
  if(kind==='route')route(f).IntegrationUri=R.latestArn+':2';
  f.policy={RevisionId:'own-permission',Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(f.sid,'2')]})};
  await assert.rejects(run(f),/completed_readonly_drift/);assert.deepEqual(writes(f),[]);assert(f.encode().journalBytes.equals(prefix));}
});
test('durable admissions precede every compensating write',async()=>{
 for(const stage of ['registered_stopped_return_admitted','registered_stopped_permission_remove_admitted']){
  const f=await stopped(),record=f.port.record;f.port.record=async e=>{if(e.stage===stage)throw Error('disk failed');return record(e);};
  await assert.rejects(run(f));assert(!writes(f).includes(stage==='registered_stopped_return_admitted'?'return':'remove'));}
});
test('lost successful replies are observed once, never reissued',async()=>{
 const f=await stopped(),ret=f.port.returnLatest,rem=f.port.removePermission;
 f.port.returnLatest=async()=>{await ret();throw Error('lost');};f.port.removePermission=async(...a)=>{await rem(...a);throw Error('lost');};
 assert.equal((await run(f)).restorationVerified,true);assert.deepEqual(writes(f),['return','remove']);
});
test('uncertain writes stay held; late success is observed without a second write',async()=>{
 for(const kind of ['return','remove']){const f=await stopped(),key=kind==='return'?'returnLatest':'removePermission',original=f.port[key];
  f.port[key]=async()=>{f.calls.push(kind);throw Error('lost');};await assert.rejects(run(f));f.resume();
  const count=writes(f).filter(v=>v===kind).length;await assert.rejects(run(f));assert.equal(writes(f).filter(v=>v===kind).length,count);
  if(kind==='return')await original();else await original(f.sid,f.policy.RevisionId);
  f.resume();const lateCount=writes(f).filter(v=>v===kind).length;assert.equal((await run(f)).restorationVerified,true);
  assert.equal(writes(f).filter(v=>v===kind).length,lateCount);}
});
test('updated clean compensator is attributed separately from the stopped operator',async()=>{
 const f=await stopped(),historical=structuredClone(f.operator);f.operator=structuredClone(f.operator);f.operator.desktop.commit='7'.repeat(40);
 f.operator.desktop.sha256='8'.repeat(64);f.after.database.operatorSource.sourceCommit=f.operator.desktop.commit;
 const r=await run(f);assert.deepEqual(r.standaloneSource,historical);assert.deepEqual(r.operatorSource,f.operator);await verify(f);
});
test('writers, foreign authority, bytes, database and storage drift fail closed',async()=>{
 for(const mutate of [f=>f.port.writerStopped=async()=>false,f=>f.port.applicationCurrent=async()=>f.operator,
  f=>f.port.current=async()=>({...f.operator,templateSha256:'0'.repeat(64)}),f=>f.port.latest=async()=>Buffer.from('wrong'),
  f=>f.after.raw.fn.RevisionId+='changed',f=>f.after.raw.routes.Items.pop(),f=>route(f).IntegrationUri=R.latestArn+':3',
  f=>f.policy.Policy=JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission('alp-care-intent-recovery-'+'a'.repeat(32),'2')]}),
  f=>f.port.storage=async()=>({state:'absent'}),f=>f.after.database.historicalInspection.rowCount++,
  f=>f.port.apiDeployment=async id=>({DeploymentId:id,DeploymentStatus:'PENDING'}),f=>f.original.journalBytes=Buffer.from('{}\n')]){
  const f=await stopped();mutate(f);await assert.rejects(run(f));assert.deepEqual(writes(f),[]);}
});
test('original and newly archived evidence remain guarded during compensation',async()=>{
 for(const target of ['origin','own']){const f=await stopped(),rebuild=f.port.rebuild;f.port.rebuild=async()=>{const r=await rebuild();
  if(target==='origin')f.originalFiles.set('before',Buffer.from('{}'));else f.files.set([...f.files.keys()][0],Buffer.from('{}'));return r;};
  await assert.rejects(run(f));assert.deepEqual(writes(f),[]);}
});
test('active or unsettled prior compensator cannot resume',async()=>{
 const f=await stopped();await run(f);f.custody=f.encode();await assert.rejects(run(f),/restoration_writer_active/);
 f.resume();f.port.writerStopped=async pid=>pid!==9999999;await assert.rejects(run(f),/restoration_writer_active/);
});
