import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from './care-recovery-routing.mjs';
import {compileRegisteredIntentParser} from './care-registered-routing-live.mjs';
import {verifyRegisteredStandaloneCustody,verifyRegisteredStandaloneLock} from './care-registered-standalone-custody.mjs';
import {runRegisteredStandaloneRehearsal,verifyRegisteredStandaloneRecovery} from './care-registered-standalone.mjs';
import {careRegisteredStandaloneFixture} from './test-fixtures/care-registered-standalone.mjs';
let parse;before(async()=>{parse=await compileRegisteredIntentParser(process.cwd());});
const fixture=()=>careRegisteredStandaloneFixture(parse),run=f=>runRegisteredStandaloneRehearsal(f.candidate,f.operator,f.custody,f.sourceText,f.port),
 writes=f=>f.calls.filter(v=>['grant','remove',R.latestArn,R.latestArn+':2'].includes(v));
const checkCustody=(f,settled=true)=>verifyRegisteredStandaloneCustody(f.encode(),f.current,f.operator,f.origin,f.now+61000,f.port.evidence,{settled});
test('fresh rehearsal visits both versions and verifies 105 cases without replaying the failed release',async()=>{
 const f=fixture(),original=Buffer.from(f.original.journalBytes),r=await run(f);
 assert.equal(r.recoveryRehearsed,true);assert.equal(r.originalRunOutcome,'failed');assert.equal(r.originalResultPreserved,true);
 assert(f.original.journalBytes.equals(original));assert.equal(r.originalFailure,f.originalEvents.at(-1).code);
 assert.deepEqual(writes(f),['grant',R.latestArn+':2',R.latestArn,'remove']);
 assert.equal(Object.values(r.recovery.observations).flat().length+Object.values(r.recovery.intents).flat().length,105);
 for(const key of ['proposalExecuted','codeUpdated','schemaChanged','hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[key],false);
 assert.equal(r.journalSha256,sha256(f.encode().journalBytes));const saved=await checkCustody(f);assert.equal(saved.originalRunOutcome,'completed');
 assert.equal(saved.completed.runId,r.runId);assert.equal(saved.sid,'alp-care-intent-recovery-'+f.lock.runId);
});
test('fresh custody is not permission to resume a stopped writer or reuse a completed rehearsal',async()=>{
 const f=fixture();await run(f);f.custody=f.encode();await assert.rejects(run(f),/fresh_custody_required/);assert.equal(writes(f).filter(v=>v==='grant').length,1);
});
test('a deployed release that failed before its permission admission still gets a separately admitted fresh rehearsal',async()=>{
 const f=fixture(),finding=f.originalEvents.at(-1);f.originalEvents=f.originalEvents.slice(0,11);f.originalEvents.push(finding);
 f.original.journalBytes=Buffer.from(f.originalEvents.map(e=>JSON.stringify(e)).join('\n')+'\n');
 f.origin.journalSha256=sha256(f.original.journalBytes);f.lock.original=structuredClone(f.origin);f.custody=f.encode();
 const r=await run(f);assert.equal(r.recoveryRehearsed,true);assert.equal(r.originalRunOutcome,'failed');
 assert.equal(f.originalEvents.some(e=>e.stage==='registered_recovery_permission_admitted'),false);assert.equal(writes(f).filter(v=>v==='grant').length,1);
});
test('every hard-crash prefix remains parsed and carries only its actual admitted mutation',async()=>{
 const f=fixture();await run(f);const events=[...f.events];
 for(let n=1;n<=events.length;n++){
  f.events=events.slice(0,n);const saved=await checkCustody(f);
  assert.equal(saved.writeAdmitted,f.events.some(e=>e.stage==='registered_recovery_permission_admitted'));
  assert.equal(saved.originalRunOutcome,n===events.length?'completed':'interrupted');
 }
});
test('original authority, application source, exact candidate and live inventory drift refuse before new writes',async()=>{
 for(const mutate of [f=>f.port.writerStopped=async()=>false,f=>f.port.applicationCurrent=async()=>f.operator,
  f=>f.port.current=async()=>({...f.operator,templateSha256:'0'.repeat(64)}),f=>f.port.rebuild=async()=>({byteVerified:true,sourceRebuilt:false}),
  f=>f.port.latest=async()=>Buffer.from('not the deployed bytes'),f=>f.after.raw.fn.RevisionId+='changed',
  f=>f.after.raw.routes.Items.pop(),f=>f.after.summary.ExecutionStatus='EXECUTE_IN_PROGRESS',
  f=>f.after.raw.integrations.Items[0].IntegrationUri=R.latestArn+':2',f=>f.policy={Policy:'{}'},
  f=>f.retained.policy={Policy:'{}'},f=>f.retained.sha256='0'.repeat(64),f=>f.retained.configuration.Timeout++,
  f=>f.port.storage=async()=>({state:'absent_at_observation'}),f=>f.port.apiDeployment=async id=>({DeploymentId:id,DeploymentStatus:'PENDING'}),
  f=>f.after.database.historicalInspection.rowCount++,f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`]){
  const f=fixture();mutate(f);await assert.rejects(run(f));assert.deepEqual(writes(f),[]);
 }
});
test('original journal and evidence are rechecked, not trusted from a once-valid parsed prefix',async()=>{
 for(const kind of ['journal','evidence','principal']){
  const f=fixture(),rebuild=f.port.rebuild;f.port.rebuild=async()=>{const result=await rebuild();
   if(kind==='journal')f.original.journalBytes=Buffer.from('{}\n');if(kind==='evidence')f.originalFiles.set('before',Buffer.from('{}'));
   if(kind==='principal')f.caller.UserId+='changed';return result;};
  await assert.rejects(run(f));assert.deepEqual(writes(f),[]);
 }
});
test('lock and original binding reject unknown fields, aliasing, dirty operator and unsupported purpose',()=>{
 for(const mutate of [f=>f.lock.runId=f.origin.runId,f=>f.lock.purpose='registered-artifact-upload-release',
  f=>f.lock.pid=0,f=>f.lock.other=true,f=>f.lock.original.journalSha256='0'.repeat(64),
  f=>f.operator.desktop.clean=false,f=>f.operator.templateSha256='0'.repeat(64)]){
  const f=fixture();mutate(f);assert.throws(()=>verifyRegisteredStandaloneLock(f.encode().lockBytes,f.current,f.operator,f.origin));
 }
 const f=fixture();assert.throws(()=>verifyRegisteredStandaloneLock(Buffer.from(f.encode().lockBytes.toString().replace('"pid":7654321','"pid":7654321,"pid":7654321')),f.current,f.operator,f.origin));
});
test('archive and admission must be durably read back before the new permission grant',async()=>{
 for(const kind of ['before_save','before_read','rehearsal_admission','permission_admission']){
  const f=fixture(),save=f.port.save,record=f.port.record,evidence=f.port.evidence;
  if(kind==='before_save')f.port.save=async()=>{throw Error('disk unavailable');};
  if(kind==='before_read')f.port.evidence=async(...args)=>args[1]==='standalone-before'?Buffer.from('bad'):evidence(...args);
  if(kind.endsWith('admission'))f.port.record=async e=>{if(e.stage===(kind==='permission_admission'?'registered_recovery_permission_admitted':'registered_standalone_rehearsal_admitted'))throw Error('fsync failed');return record(e);};
  else f.port.save=kind==='before_save'?f.port.save:save;
  await assert.rejects(run(f));assert(!writes(f).includes('grant'));
 }
});
test('newly archived observations remain guarded after admission and before every routing write',async()=>{
 const f=fixture(),recovery=f.port.recovery;f.port.recovery=async(...args)=>{
  const file=f.events.find(e=>e.stage==='registered_standalone_before_archived').file;f.files.set(file,Buffer.from('{}\n'));return recovery(...args);};
 await assert.rejects(run(f),/own_evidence_changed/);assert.deepEqual(writes(f),[]);
});
test('bad retained answers and missing qualified invocation metrics preserve a failed run after compensation',async()=>{
 for(const kind of ['answer','metric']){
  const f=fixture();if(kind==='metric')f.routing.waitMetric=async()=>({Label:'Invocations',Datapoints:[]});
  else{const phase=f.routing.intentPhase;f.routing.intentPhase=async name=>{const rows=await phase(name);if(name==='retained')rows[0].status=503;return rows;};}
  await assert.rejects(run(f));const saved=await checkCustody(f);assert.equal(saved.originalRunOutcome,'failed');
  assert.equal(saved.completed,undefined);assert.equal(f.policy,null);assert.equal(f.after.raw.integrations.Items[0].IntegrationUri,R.latestArn);
 }
});
test('hard-crash admission is recorded even when the permission reply is lost',async()=>{
 const f=fixture();f.routing.addPermission=async()=>{f.calls.push('grant');throw Error('lost reply');};
 await assert.rejects(run(f));const saved=await checkCustody(f);assert.equal(saved.writeAdmitted,true);assert.equal(saved.originalRunOutcome,'failed');
 assert.equal(saved.sid,'alp-care-intent-recovery-'+f.lock.runId);assert.equal(saved.completed,undefined);
});
test('final candidate, database or authority drift cannot be hidden by a successful functional report',async()=>{
 for(const kind of ['database','revision','route','projection','permission']){
  const f=fixture(),recovery=f.port.recovery;f.port.recovery=async(...args)=>{const r=await recovery(...args);
   if(kind==='database')f.after.database.historicalInspection.completeDataSha256='0'.repeat(64);if(kind==='revision')f.after.raw.fn.RevisionId+='changed';
   if(kind==='route')f.after.raw.routes.Items.pop();if(kind==='projection')f.after.summary.Description='changed';if(kind==='permission')f.policy={Policy:'{}'};return r;};
  await assert.rejects(run(f));assert(!f.events.some(e=>e.stage==='registered_standalone_completed'));assert.equal((await checkCustody(f)).originalRunOutcome,'failed');
 }
});
test('completion independently revalidates actual answers, identities, phases, database and metric rather than booleans',async()=>{
 const f=fixture(),r=await run(f),input={candidate:f.candidate,current:f.current};
 for(const mutate of [v=>v.observations.retained.pop(),v=>v.intents.returned[0].status=503,v=>v.intents.retained[0].requestId=v.intents.baseline[0].requestId,
  v=>v.intents.retained[0].value.data.items[0].requestId='00000000-0000-4000-8000-000000000001',v=>v.metricWitness.response.Datapoints=[],
  v=>v.metricWitness.minimum=0,v=>v.observations.extra=[],v=>v.databaseAfter.historicalInspection.intentRowCount++,
  v=>v.current.desktop.commit='0'.repeat(40),v=>v.phiAllowed=true,v=>v.events=[]]){
  const v=structuredClone(r.recovery);mutate(v);assert.throws(()=>verifyRegisteredStandaloneRecovery(v,input,f.operator,Date.parse(r.recovery.startedAt),f.now,parse));
 }
});
test('journal grammar refuses premature success, wrong count/version/sid, reordered admissions and false attribution',async()=>{
 const f=fixture();await run(f);const complete=[...f.events];
 for(const mutate of [v=>v[0].originalJournalSha256='0'.repeat(64),v=>v[1].sha256='0'.repeat(64),v=>v[2].beforeSha256='0'.repeat(64),
  v=>v[3].sid='alp-care-intent-recovery-'+'a'.repeat(32),v=>v[4].version='1',
  v=>v.find(e=>e.stage==='registered_recovery_cases_verified').caseCount=104,
  v=>{[v[2],v[3]]=[v[3],v[2]];},v=>v[0].other=true,v=>v.splice(4,1),v=>v[1].at='2020-01-01T00:00:00Z']){
  f.events=structuredClone(complete);mutate(f.events);await assert.rejects(checkCustody(f));
 }
 f.events=complete.slice(0,4);f.events.push({at:new Date(f.now).toISOString(),stage:'registered_standalone_finding',code:'synthetic_care_registered_release_refused:fictional',writeAdmitted:false});
 await assert.rejects(checkCustody(f),/finding/);
 f.events=[complete[0],complete.at(-1)];await assert.rejects(checkCustody(f),/transition/);
});
test('truncation, duplicate JSON keys, unverified evidence and unsettled writers never become completion',async()=>{
 const f=fixture();await run(f);const bytes=f.encode();
 for(const journalBytes of [bytes.journalBytes.subarray(0,-1),Buffer.from(bytes.journalBytes.toString().replace('"runId":"'+f.lock.runId+'"','"runId":"'+f.lock.runId+'","runId":"'+f.lock.runId+'"'))]){
  await assert.rejects(verifyRegisteredStandaloneCustody({...bytes,journalBytes},f.current,f.operator,f.origin,f.now+61000,f.port.evidence));
 }
 await assert.rejects(verifyRegisteredStandaloneCustody(bytes,f.current,f.operator,f.origin,f.now,f.port.evidence),/writer_settlement/);
 const file=f.events.at(-1).file;f.files.set(file,Buffer.from('{}\n'));await assert.rejects(checkCustody(f),/archive_bytes/);
});
test('orchestrator has no deployment, clinical write, provider activation, paid-build or public report-loading port',()=>{
 const text=readFileSync(new URL('./care-registered-standalone.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(text,/process\.argv|execute-change-set|update-function-code|publish-version|create-persona|action:'erase'|action:'cancel_erasure'/);
 assert.match(text,/fresh_custody_required/);assert.match(text,/registered_standalone_rehearsal_admitted/);assert.match(text,/verifyRegisteredStandaloneRecovery/);
 assert.notEqual(canonical({a:1}),canonical({a:2}));
});
