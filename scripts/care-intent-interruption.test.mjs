import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyCareIntentInterruption,readCareIntentInterruption,careIntentProcessAbsent} from './care-intent-interruption.mjs';
import {careIntentResumptionFixture} from './test-fixtures/care-intent-resumption.mjs';
import {careIntentReconcileArgs} from './reconcile-synthetic-care-intent.mjs';
const clone=structuredClone;
function fixture(){
 const f=careIntentResumptionFixture(),w=f.supplied.deployment,runId='7'.repeat(32),saved={runId,pid:process.pid,
  purpose:'intent-artifact-upload-proposal',desktop:clone(f.application.desktop),mobile:clone(f.application.mobile)};
 const events=[{stage:'started',runId},{stage:'live_preparation_verified'},
  {stage:'artifact_put_admitted',key:f.supplied.candidate.manifest.key,sha256:f.supplied.candidate.manifest.zipSha256},
  {stage:'artifact_exact_version_verified',artifact:w.artifact},{stage:'intent_live_release_started',desktop:f.application.desktop.commit,mobile:f.application.mobile.source.commit},
  {stage:'change_set_create_admitted',stackId:w.binding.stackId,name:w.binding.name,clientToken:w.binding.name.slice(12)+'0'.repeat(32)},
  {stage:'change_set_observed',...w.binding},{stage:'change_set_projection_readback'},
  {stage:'dependency_live_readback_unchanged'},{stage:'change_set_verified_unexecuted'},
  {stage:'intent_change_execute_admitted',stackId:w.binding.stackId,changeSetId:w.binding.id},
  {stage:'intent_change_execute_terminal',changeSetId:w.binding.id},{stage:'intent_deployed_bytes_control_verified'},
  {stage:'intent_version_publish_admitted',zipSha256:f.supplied.candidate.manifest.zipSha256},
  {stage:'intent_retained_bytes_verified',version:'2',sha256:f.supplied.candidate.manifest.zipSha256},
  {stage:'finding',writeAdmitted:true,code:'synthetic_care_intent_release_refused:runner_transport_revision'}]
  .map((e,i)=>({...e,at:new Date(1700000000000+i).toISOString()}));
 return {...f,saved,events};
}
const verify=f=>verifyCareIntentInterruption(f.saved,f.events,f.application,f.supplied.candidate);
test('journal locates exact admitted identities but proves no success and permits no replay',()=>{
 const f=fixture(),before=clone({saved:f.saved,events:f.events,application:f.application});
 const r=verify(f);assert.equal(r.remoteSuccessProven,false);assert.equal(r.replayAuthorized,false);
 assert.equal(r.binding.id,f.supplied.deployment.binding.id);assert.deepEqual(clone({saved:f.saved,events:f.events,application:f.application}),before);
 for(const mutate of [f=>f.saved.runId='../other',f=>f.saved.pid=0,f=>f.saved.purpose='other',f=>f.saved.desktop.clean=false,
  f=>f.saved.mobile.source.commit='8'.repeat(40),f=>f.events.pop(),f=>f.events.push({...f.events.at(-1),stage:'intent_schema_commit_admitted'}),
  f=>f.events[1].at='invalid',f=>f.events[2].at='2000-01-01',f=>f.events[2].key='other',f=>f.events[3].artifact.versionId='null',
  f=>f.events[5].clientToken='wrong',f=>f.events[6].stackId='other',f=>f.events[10].changeSetId='other',
  f=>f.events[14].version='1',f=>f.events[15].writeAdmitted=false,f=>f.events[15].code='other']){
  const x=fixture();mutate(x);assert.throws(()=>verify(x));
 }
});
test('dead process readback retains original bytes and refuses a live or unknown writer',()=>{
 assert.throws(()=>careIntentProcessAbsent(process.pid));
 const root=mkdtempSync(resolve(tmpdir(),'alp-interruption-')),directory=resolve(root,'candidate'),f=fixture();
 try{
  mkdirSync(resolve(root,'dist/synthetic-care-routing'),{recursive:true});mkdirSync(resolve(directory,'uploads'),{recursive:true});
  const lock=resolve(root,'dist/synthetic-care-routing/operator.lock'),journal=resolve(directory,'uploads',f.saved.runId+'.events.jsonl');
  const save=()=>{writeFileSync(lock,JSON.stringify(f.saved)+'\n');writeFileSync(journal,f.events.map(e=>JSON.stringify(e)).join('\n')+'\n');};
  save();assert.throws(()=>readCareIntentInterruption(root,directory,f.application,f.supplied.candidate));
  // The child has actually exited; a timeout or lock alone is not proof.
  f.saved.pid=Number(execFileSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8',timeout:10000}));save();
  const original=[readFileSync(lock),readFileSync(journal)],r=readCareIntentInterruption(root,directory,f.application,f.supplied.candidate);
  assert.equal(r.previousProcessAbsent,true);assert.equal(r.originalCustodyRetained,true);
  assert.ok(readFileSync(lock).equals(original[0]));assert.ok(readFileSync(journal).equals(original[1]));
  writeFileSync(journal,original[1].subarray(0,-1));assert.throws(()=>readCareIntentInterruption(root,directory,f.application,f.supplied.candidate));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('reconciliation CLI cannot load reports, unlock, choose a target, mutate AWS, upgrade or activate',()=>{
 careIntentReconcileArgs(['--v2-root','v2','--candidate','candidate','--reconcile-interrupted-fictional-intent-only']);
 for(const args of [[],['--report','old'],['--target','production'],['--unlock'],['--approve'],
  ['--v2-root','a','--candidate','b','--resume'],
  ['--v2-root','a','--candidate','b','--reconcile-interrupted-fictional-intent-only','--phi']])assert.throws(()=>careIntentReconcileArgs(args));
 const code=readFileSync(new URL('./reconcile-synthetic-care-intent.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(code,/process\.env|writeFileSync|unlinkSync|renameSync|PutObjectCommand|execute-change-set|publish-version|update-integration|add-permission|schema\('upgrade'\)/);
 assert.match(code,/qualifyCareIntentResumptionSource\(/);assert.match(code,/verifyCareIntentHistoricalDownload\(await downloadIntentFunction/);
 assert.match(code,/verifyCareStoredArtifact\(/);assert.match(code,/readCareArtifact\(/);
 assert.match(code,/verifyCareIntentResumedDeployment\(/);assert.match(code,/verifyCareIntentInspector\(await schema\('inspect'\),operatorCurrent\)/);
 assert.match(code,/canonical\(returnedViews\)===canonical\(projection\)/);
});
