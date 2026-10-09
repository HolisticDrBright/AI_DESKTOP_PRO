import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createCatalogRollbackCustody,boundedCatalogFile} from './catalog-forward-rollback-custody.mjs';
import {catalogRollbackArguments,verifyCatalogRollbackBuild,verifyCatalogRollbackControl} from './rehearse-catalog-forward-rollback.mjs';
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
