import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCareIntentResumptionCustody} from './care-intent-resumption-custody.mjs';
import {readCareIntentInterruption} from './care-intent-interruption.mjs';
import {careIntentResumptionFixture} from './test-fixtures/care-intent-resumption.mjs';
import {careIntentResumeArgs} from './resume-synthetic-care-intent.mjs';
import {verifyIntentInterruptedVersionInventory} from './care-intent-live.mjs';
function fixture(){
 const root=mkdtempSync(resolve(tmpdir(),'alp-resume-custody-')),directory=resolve(root,'candidate'),f=careIntentResumptionFixture(),w=f.supplied.deployment;
 const runId='7'.repeat(32),saved={runId,pid:Number(execFileSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8',timeout:10000})),
  purpose:'intent-artifact-upload-proposal',desktop:f.application.desktop,mobile:f.application.mobile};
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
 mkdirSync(resolve(root,'dist/synthetic-care-routing'),{recursive:true});mkdirSync(resolve(directory,'uploads'),{recursive:true});
 const lock=resolve(root,'dist/synthetic-care-routing/operator.lock'),journal=resolve(directory,'uploads',runId+'.events.jsonl');
 writeFileSync(lock,JSON.stringify(saved)+'\n');writeFileSync(journal,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const original=[readFileSync(lock),readFileSync(journal)],observed=readCareIntentInterruption(root,directory,f.application,f.supplied.candidate);
 const create=()=>createCareIntentResumptionCustody(root,directory,observed,f.supplied.candidate,f.application,f.operator);
 return {...f,root,directory,lock,journal,original,observed,create,remove:()=>rmSync(root,{recursive:true,force:true})};
}
test('exclusive secondary custody preserves original admitted bytes; no-write failure closes only its own guard',()=>{
 const f=fixture();try{const c=f.create();
  assert.ok(readFileSync(f.lock).equals(f.original[0]));assert.ok(readFileSync(f.journal).equals(f.original[1]));
  assert.throws(()=>f.create());c.guard();c.close();assert.equal(existsSync(c.lock),false);assert.equal(existsSync(f.lock),true);
 }finally{f.remove();}
});
test('a newly admitted unknown outcome retains both locks; no success or timeout can erase custody',()=>{
 const f=fixture();try{const c=f.create();c.admit({stage:'intent_permission_admitted'});c.close();
  assert.equal(c.admitted,true);assert.equal(existsSync(c.lock),true);assert.equal(existsSync(f.lock),true);assert.throws(()=>f.create());
  assert.throws(()=>c.settle({schemaChanged:false}));assert.ok(readFileSync(f.lock).equals(f.original[0]));
 }finally{f.remove();}
});
test('settlement archives exact original bytes before retiring locks, only after current-operator schema readback',()=>{
 const f=fixture();try{const c=f.create();c.admit({stage:'intent_schema_commit_admitted'});
  const result={contract:'synthetic-care-intent-schema-release/1',schemaChanged:true,preservationVerified:true,compatibleRecoveryVerified:true,
   current:f.application,operatorCurrent:f.operator,after:{alreadyApplied:true},phiAllowed:false,paidMobileBuildStarted:false};
  for(const patch of [{preservationVerified:false},{compatibleRecoveryVerified:false},{after:{alreadyApplied:false}},{phiAllowed:true},
   {operatorCurrent:f.application},{current:f.operator}])assert.throws(()=>c.settle({...result,...patch}));
  c.settle(result);assert.equal(c.settled,true);assert.equal(existsSync(f.lock),false);c.close();assert.equal(existsSync(c.lock),false);
  const rows=readFileSync(c.journal,'utf8').trim().split('\n').map(s=>JSON.parse(s)),archive=rows.find(e=>e.stage==='original_custody_archived').archive;
  assert.ok(readFileSync(resolve(archive,'operator.lock')).equals(f.original[0]));assert.ok(readFileSync(resolve(archive,'events.jsonl')).equals(f.original[1]));
  assert.ok(readFileSync(f.journal).equals(f.original[1]));
 }finally{f.remove();}
});
test('original or secondary custody drift refuses mutation; journal failure prevents admission',()=>{
 for(const mode of ['original','secondary','journal']){const f=fixture();try{const c=f.create();
  if(mode==='original')writeFileSync(f.lock,readFileSync(f.lock,'utf8')+'\n');
  if(mode==='secondary')writeFileSync(c.lock,'foreign\n');
  if(mode==='journal'){rmSync(c.journal);mkdirSync(c.journal);}
  assert.throws(()=>c.admit({stage:'never_sent'}));assert.equal(c.admitted,false);assert.equal(existsSync(f.lock),true);
  if(mode==='secondary')assert.throws(()=>c.close());else c.close();
 }finally{f.remove();}}
});
test('resumption never republishes a missing/replaced version and exposes no report/target/approval shortcuts',()=>{
 verifyIntentInterruptedVersionInventory([{Version:'2'}],'2');
 for(const rows of [[],[{Version:'1'}],[{Version:'3'}],[{Version:'2'},{Version:'2'}]])assert.throws(()=>verifyIntentInterruptedVersionInventory(rows,'2'));
 for(const version of ['1','$LATEST',undefined,'2:other'])assert.throws(()=>verifyIntentInterruptedVersionInventory([{Version:version}],version));
 careIntentResumeArgs(['--v2-root','v2','--candidate','candidate','--resume-interrupted-fictional-intent-with-fresh-recovery']);
 for(const a of [[],['--report','old'],['--unlock'],['--target','production'],['--approve'],['--skip'],
  ['--v2-root','v2','--candidate','candidate','--resume-interrupted-fictional-intent-with-fresh-recovery','--phi']])assert.throws(()=>careIntentResumeArgs(a));
 const code=readFileSync(new URL('./resume-synthetic-care-intent.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(code,/process\.env|PutObjectCommand|execute-change-set|publish-version|update-function-code|--report|--skip|--approve|--unlock/);
 assert.match(code,/interruptedRetainedVersion:interruption.retainedVersion/);assert.match(code,/createCareIntentResumptionCustody\(/);
 assert.equal((code.match(/await observeCareIntentResumption\(/g)??[]).length,2);
 assert.match(code,/releaseResumedCareIntent\(/);assert.match(code,/custody\.settle\(result\)/);
});
