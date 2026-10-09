import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createCatalogRollbackCustody,boundedCatalogFile,verifyCatalogAppliedReadback} from './catalog-forward-rollback-custody.mjs';
import {catalogRollbackArguments,verifyCatalogRollbackBuild,verifyCatalogRollbackControl,verifyCatalogApplyBuild} from './rehearse-catalog-forward-rollback.mjs';
import {catalogApplyArguments} from './apply-catalog-forward.mjs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {sha256,CARE_RELEASE as P} from './synthetic-care-release.mjs';
const source={commit:'a'.repeat(40),clean:true,files:1,sha256:'b'.repeat(64)};
function fixture(){
 const root=mkdtempSync(resolve(tmpdir(),'alp-catalog-rollback-')),shared=resolve(root,'shared'),out=resolve(root,'out');
 mkdirSync(shared);mkdirSync(out);let valid=true;
 const guard={verify:()=>{assert.equal(valid,true,'guard lost');}};
 return {root,shared,out,guard,invalidate:()=>{valid=false;},create:()=>createCatalogRollbackCustody(shared,out,source,guard),
  close:()=>rmSync(root,{recursive:true,force:true})};
}
const observation={contract:'catalog-forward-upgrade/1',command:'inspect',referenceMigrationCount:2,phiAllowed:false};
function report(c){return {contract:'catalog-forward-custodied-rollback/1',runId:c.runId,operatorSource:source,before:observation,after:observation,
 rolledBack:true,repeatedDatabaseReadbackVerified:true,controlUnchanged:true,sourceUnchanged:true,journalSha256:c.journalSha256(),
 lastingApplyPerformed:false,apiDeploymentPerformed:false,canonicalRegistered:false,hostedAcceptance:false,activationApproved:false,phiAllowed:false};}
function ready(c){for(const stage of ['catalog_rollback_admitted','catalog_rollback_readback_verified','catalog_rollback_control_verified'])c.record(stage,{observationSha256:'c'.repeat(64)});}
test('a live or abandoned routing lock is never replaced, even if its PID looks stopped',()=>{
 const f=fixture();try{const bytes=Buffer.from('{"pid":999999999,"purpose":"older-routing"}\n');writeFileSync(resolve(f.shared,'operator.lock'),bytes);
  assert.throws(f.create,/operator_active/);assert.deepEqual(readFileSync(resolve(f.shared,'operator.lock')),bytes);
 }finally{f.close();}
});
test('two admissions cannot run concurrently and terminal settlement archives exact bytes before unlock',()=>{
 const f=fixture();try{const c=f.create(),lock=readFileSync(c.lock);assert.throws(f.create,/operator_active/);
  ready(c);const r=report(c),done=c.settle(r);assert.equal(done.custodySettled,true);assert.equal(existsSync(c.lock),false);
  assert.deepEqual(readFileSync(resolve(f.out,c.runId+'.settled-lock.json')),lock);
  assert.equal(sha256(readFileSync(done.receipt)),done.receiptBytesSha256);assert.deepEqual(JSON.parse(readFileSync(done.receipt)),r);
  assert.throws(c.verify);
 }finally{f.close();}
});
test('changed journal or guard prevents requests and never removes the operator lock',()=>{
 for(const mode of ['journal','guard']){const f=fixture();try{const c=f.create();if(mode==='journal')writeFileSync(c.journal,'changed');else f.invalidate();
   assert.throws(c.verify);assert.equal(existsSync(c.lock),true);
  }finally{f.close();}}
});

test('diagnostic details cannot overwrite any authoritative event metadata',()=>{
 const f=fixture();try{const c=f.create(),before=readFileSync(c.journal);
  for(const key of ['stage','runId','at','source']){
   assert.throws(()=>c.record('catalog_rollback_admitted',{[key]:'replacement'}),/reserved_event_metadata/);
   assert.deepEqual(readFileSync(c.journal),before);assert.equal(existsSync(c.lock),true);
  }
  ready(c);const done=c.settle(report(c));
  const events=readFileSync(c.journal,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(events.map(event=>event.stage),['catalog_rollback_started','catalog_rollback_admitted','catalog_rollback_readback_verified','catalog_rollback_control_verified']);
  assert.ok(events.every(event=>event.runId===c.runId));assert.equal(done.custodySettled,true);
 }finally{f.close();}
});
test('incomplete, failed, out-of-order and falsely activated results cannot settle',()=>{
 const f=fixture();try{const c=f.create();assert.throws(()=>c.settle(report(c)),/settlement/);
  assert.throws(()=>c.record('catalog_rollback_control_verified',{}),/stage/);ready(c);
  for(const patch of [{rolledBack:false},{sourceUnchanged:false},{journalSha256:'d'.repeat(64)},{phiAllowed:true},
   {hostedAcceptance:true},{canonicalRegistered:true},{lastingApplyPerformed:true},{after:{...observation,referenceMigrationCount:3}},
   {operatorSource:{...source,commit:'d'.repeat(40)}}])assert.throws(()=>c.settle({...report(c),...patch}),/settlement/);
  c.record('catalog_rollback_finding',{outcome:'unsettled'});assert.throws(()=>c.settle(report(c)),/settlement/);
  assert.equal(existsSync(c.lock),true);
 }finally{f.close();}
});
test('exact read refuses truncation and no caller flag unlocks a lasting upgrade',()=>{
 for(const args of [[],['upgrade'],['inspect'],['--rehearse-fictional-catalog-rollback-only','--approve'],['--database','production']])
  assert.throws(()=>catalogRollbackArguments(args),/arguments/);
catalogRollbackArguments(['--rehearse-fictional-catalog-rollback-only']);
 assert.equal(catalogRollbackArguments(['--qualify-fictional-catalog-lock-admission-only']),'lock-admission');
 const f=fixture();try{writeFileSync(resolve(f.out,'empty'),'');assert.throws(()=>boundedCatalogFile(resolve(f.out,'empty')),/file/);
  writeFileSync(resolve(f.out,'large'),'12345');assert.throws(()=>boundedCatalogFile(resolve(f.out,'large'),4),/file/);
 }finally{f.close();}
});

test('lock admission needs every observed proof and the separate complete sequence before settlement',()=>{
 const f=fixture();try{
  const c=createCatalogRollbackCustody(f.shared,f.out,source,f.guard,Date.now(),process.pid,'lock-admission');
  const r=()=>({...report(c),contract:'catalog-forward-custodied-lock-admission/1',
   realLockWaitObserved:true,competingCommitVerified:true,changedWitnessRefused:true,workersSettled:true,fixtureRemoved:true});
  assert.throws(()=>c.settle(r()),/settlement/);
  for(const stage of ['catalog_lock_fixture_admitted','catalog_lock_writer_admitted','catalog_lock_wait_observed',
   'catalog_lock_refusal_verified','catalog_lock_cleanup_admitted','catalog_lock_cleanup_verified','catalog_rollback_control_verified'])c.record(stage,{});
  for(const key of ['realLockWaitObserved','competingCommitVerified','changedWitnessRefused','workersSettled','fixtureRemoved'])
   assert.throws(()=>c.settle({...r(),[key]:false}),/settlement/);
  assert.throws(()=>c.settle({...r(),contract:'catalog-forward-custodied-rollback/1'}),/settlement/);
  assert.equal(c.settle(r()).custodySettled,true);
 }finally{f.close();}
});
test('a failed lock test may admit exact fixture cleanup but cannot settle the shorter sequence',()=>{
 const f=fixture();try{
  const c=createCatalogRollbackCustody(f.shared,f.out,source,f.guard,Date.now(),process.pid,'lock-admission');
  c.record('catalog_lock_fixture_admitted',{});c.record('catalog_lock_cleanup_admitted',{});
  assert.throws(()=>c.settle({...report(c),contract:'catalog-forward-custodied-lock-admission/1',
   realLockWaitObserved:true,competingCommitVerified:true,changedWitnessRefused:true,workersSettled:true,fixtureRemoved:true}),/settlement/);
  assert.equal(existsSync(c.lock),true);
 }finally{f.close();}
});
test('artifact source, bytes, exact histories and false activation are mandatory',()=>{
 const bytes=Buffer.from('fictional local module'),m={contract:'catalog-forward-rollback-build/1',sourceCommit:source.commit,clean:true,sha256:sha256(bytes),
  execution:'synthetic-staging',phiAllowed:false,coreSourceCount:47,coreLiveCount:48,referenceBeforeCount:2,referenceCandidateCount:3,
  referenceBeforeSha256:'83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',
  referenceCandidateSha256:'80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a',
  candidateSqlSha256:'3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117',
  rollbackRehearsalAvailable:true,readOnly:false,lastingApplyAvailable:false,canonicalRegistered:false,databaseMutationPerformed:false,hostedAcceptance:false,activationApproved:false};
 verifyCatalogRollbackBuild(m,bytes,source);
 for(const patch of [{clean:false},{sourceCommit:'d'.repeat(40)},{sha256:'d'.repeat(64)},{execution:'production-clinical'},
  {phiAllowed:true},{referenceBeforeCount:3},{referenceBeforeSha256:'d'.repeat(64)},{lastingApplyAvailable:true},
  {canonicalRegistered:true},{hostedAcceptance:true},{activationApproved:true}])assert.throws(()=>verifyCatalogRollbackBuild({...m,...patch},bytes,source),/build_binding/);
});
test('control must be the observed current code, route and exact database, never a retained version',()=>{
 const raw={retainedPermissionAbsent:true,permission:{Policy:'fictional'},fn:{FunctionName:P.functionName,Version:'$LATEST',State:'Active',LastUpdateStatus:'Successful',
  CodeSha256:'KF8z0MAz0mazT+u/UzNuHxhThz0xwpE48/yS5SlBsPw=',RevisionId:'531d8866-f650-4751-a89d-dceef74fc153',
  Environment:{Variables:{CLINICAL_DATABASE_NAME:P.database,CLINICAL_DATABASE_CLUSTER_ARN:P.cluster,CLINICAL_DATABASE_SECRET_ARN:P.secret}}},
  integration:{IntegrationId:'2k0pka6',IntegrationUri:`arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`}};
 assert.equal(verifyCatalogRollbackControl(raw).retainedPermissionAbsent,true);
 for(const patch of [{retainedPermissionAbsent:false},{fn:{...raw.fn,Version:'2'}},{fn:{...raw.fn,State:'Pending'}},
  {fn:{...raw.fn,CodeSha256:'unrelated'}},{fn:{...raw.fn,Environment:{Variables:{...raw.fn.Environment.Variables,CLINICAL_DATABASE_NAME:'clinical_core_qualification'}}}},
  {integration:{...raw.integration,IntegrationUri:raw.integration.IntegrationUri+':2'}}])assert.throws(()=>verifyCatalogRollbackControl({...raw,...patch}),/control_binding/);
});

function applyObservations(){
 const before={contract:'catalog-forward-upgrade/1',command:'inspect',execution:'synthetic-staging',phiAllowed:false,
  coreLedgerSha256:'447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50',
  referenceLedgerSha256:'83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',referenceMigrationCount:2,
  candidateSqlSha256:'3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117',tableCount:89,rowCount:51,
  dataSha256:'c'.repeat(64),preservedSchemaSha256:'d'.repeat(64),observationSha256:'',
  dataPreserved:true,schemaPreserved:true,historicalLedgerPreserved:true,applied:false,alreadyApplied:false,rolledBack:false,
  canonicalRegistered:false,hostedAcceptance:false,activationApproved:false,operatorSource:{sourceCommit:source.commit,clean:true,lastingApplyAvailable:true},
  awsAccountId:P.account,foundation:P.foundation,databaseMutationPerformed:false,apiDeploymentPerformed:false,phiActivation:false};
 const witness=referenceLedgerSha256=>sha256(JSON.stringify({contract:'catalog-forward-upgrade-observation/1',account:P.account,region:P.region,
  clusterArn:P.cluster,secretArn:P.secret,databaseName:P.database,coreLedgerSha256:before.coreLedgerSha256,
  referenceLedgerSha256,candidateSqlSha256:before.candidateSqlSha256,dataSha256:before.dataSha256,schemaSha256:before.preservedSchemaSha256}));
 before.observationSha256=witness(before.referenceLedgerSha256);
 const after={...before,referenceLedgerSha256:'80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a',
  referenceMigrationCount:3,alreadyApplied:true,observationSha256:witness('80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a')};
 return {before,after};
}
const applySequence=['catalog_rollback_admitted','catalog_rollback_readback_verified','catalog_lock_fixture_admitted',
 'catalog_lock_writer_admitted','catalog_lock_wait_observed','catalog_lock_refusal_verified','catalog_lock_cleanup_admitted',
 'catalog_lock_cleanup_verified','catalog_apply_admitted','catalog_apply_committed','catalog_apply_readback_verified','catalog_rollback_control_verified'];
test('apply cannot bypass the fresh rollback and real race sequence, and only exact successor readback can release custody',()=>{
 const f=fixture();try{
  const c=createCatalogRollbackCustody(f.shared,f.out,source,f.guard,Date.now(),process.pid,'apply');
  const r=()=>({...report(c),...applyObservations(),contract:'catalog-forward-custodied-apply/1',rolledBack:true,
   realLockWaitObserved:true,competingCommitVerified:true,changedWitnessRefused:true,workersSettled:true,fixtureRemoved:true,
   independentReadbackVerified:true,lastingApplyPerformed:true});
  assert.throws(()=>c.record('catalog_apply_admitted',{}),/stage/);assert.throws(()=>c.settle(r()),/settlement/);
  for(const stage of applySequence)c.record(stage,{});
  for(const key of ['rolledBack','realLockWaitObserved','competingCommitVerified','changedWitnessRefused','workersSettled','fixtureRemoved',
   'independentReadbackVerified','lastingApplyPerformed','repeatedDatabaseReadbackVerified','controlUnchanged','sourceUnchanged'])
   assert.throws(()=>c.settle({...r(),[key]:false}),/settlement/);
  for(const patch of [{after:r().before},{after:{...r().after,dataSha256:'e'.repeat(64)}},{after:{...r().after,rowCount:52}},
   {after:{...r().after,preservedSchemaSha256:'e'.repeat(64)}},{after:{...r().after,operatorSource:{sourceCommit:'e'.repeat(40),clean:true}}}])
   assert.throws(()=>c.settle({...r(),...patch}),/apply_readback/);
  for(const key of ['canonicalRegistered','hostedAcceptance','activationApproved','phiAllowed','apiDeploymentPerformed'])
   assert.throws(()=>c.settle({...r(),[key]:true}),/settlement/);
  const completed=r(),done=c.settle(completed);assert.equal(done.custodySettled,true);assert.equal(existsSync(c.lock),false);
  assert.deepEqual(JSON.parse(readFileSync(done.receipt)),completed);
 }finally{f.close();}
});
test('apply readback requires all preserved evidence and cannot replace historical identities or production controls',()=>{
 const {before,after}=applyObservations();verifyCatalogAppliedReadback(before,after,source);
 for(const patch of [{coreLedgerSha256:'e'.repeat(64)},{referenceMigrationCount:3},{observationSha256:'e'.repeat(64)},
  {phiAllowed:true},{dataPreserved:false},{tableCount:88},{rowCount:-1},{operatorSource:{sourceCommit:'e'.repeat(40),clean:true}},
  {execution:'production-clinical'},{awsAccountId:'173535830222'}])
  assert.throws(()=>verifyCatalogAppliedReadback({...before,...patch},after,source),/apply_readback/);
});
test('apply requires its separate exact argument and separate byte-bound build; rollback commands never acquire that capability',()=>{
 for(const args of [[],['upgrade'],['--apply-reviewed-synthetic-catalog-forward','--approve'],['--apply-reviewed-synthetic-catalog-forward','--database','production']])
  assert.throws(()=>catalogApplyArguments(args),/arguments/);
 assert.equal(catalogApplyArguments(['--apply-reviewed-synthetic-catalog-forward']),'apply');
 assert.throws(()=>catalogRollbackArguments(['--apply-reviewed-synthetic-catalog-forward']),/arguments/);
 const bytes=Buffer.from('fictional apply module'),m={contract:'catalog-forward-apply-build/1',sourceCommit:source.commit,clean:true,sha256:sha256(bytes),
  execution:'synthetic-staging',phiAllowed:false,coreSourceCount:47,coreLiveCount:48,referenceBeforeCount:2,referenceCandidateCount:3,
  referenceBeforeSha256:'83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',
  referenceCandidateSha256:'80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a',
  candidateSqlSha256:'3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117',rollbackRehearsalAvailable:true,
  lockAdmissionQualificationAvailable:true,readOnly:false,lastingApplyAvailable:true,canonicalRegistered:false,databaseMutationPerformed:false,hostedAcceptance:false,activationApproved:false};
 verifyCatalogApplyBuild(m,bytes,source);assert.throws(()=>verifyCatalogRollbackBuild(m,bytes,source),/build_binding/);
 for(const patch of [{contract:'catalog-forward-rollback-build/1'},{clean:false},{lastingApplyAvailable:false},{readOnly:true},
  {lockAdmissionQualificationAvailable:false},{referenceCandidateSha256:'e'.repeat(64)},{phiAllowed:true},{canonicalRegistered:true},
  {hostedAcceptance:true},{activationApproved:true},{sourceCommit:'e'.repeat(40)},{sha256:'e'.repeat(64)}])
  assert.throws(()=>verifyCatalogApplyBuild({...m,...patch},bytes,source));
});
test('the actual rollback bundle refuses its guarded apply export before any AWS observation',()=>{
 execFileSync(process.execPath,['scripts/build-catalog-forward-inspector.mjs','--rollback-rehearsal'],
  {timeout:30000,stdio:['ignore','pipe','pipe'],windowsHide:true});
 const directory=resolve('dist/aws-clinical-core/catalog-forward-rollback');
 const m=JSON.parse(readFileSync(resolve(directory,'artifact-manifest.json'),'utf8'));
 const port=createRequire(import.meta.url)(resolve(directory,'index.cjs'));
 let custodyCalls=0;
 assert.equal(m.lastingApplyAvailable,false);
 assert.throws(()=>port.applyCatalogForwardDatabase(m.sourceCommit,{verify:()=>{custodyCalls++;},record:()=>{custodyCalls++;}}),/apply_bundle_required/);
 assert.equal(custodyCalls,0);
});
