import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_INTENT_POSTCOMMIT as F,verifyCarePostcommitCustody,verifyCareIntentSuccessorInspector} from './care-intent-postcommit.mjs';
import {careIntentPostcommitArgs} from './reconcile-synthetic-care-intent-postcommit.mjs';
import {careIntentResumptionFixture} from './test-fixtures/care-intent-resumption.mjs';
const lock=readFileSync(new URL('../docs/evidence/2026-10-08-care-intent-resumption.operator.lock.json',import.meta.url));
const journal=readFileSync(new URL('../docs/evidence/2026-10-08-care-intent-resumption.events.jsonl',import.meta.url));
const saved=JSON.parse(lock),application=saved.applicationCurrent;
const original={runId:F.parentRunId,lockSha256:F.parentLockSha256,journalSha256:F.parentJournalSha256};
test('exact admitted journal identifies historical custody but never success, replay or settlement',()=>{
 const r=verifyCarePostcommitCustody(lock,journal,original,application);
 assert.equal(r.runId,F.runId);assert.equal(r.commitAdmitted,true);
 for(const key of ['remoteSuccessProven','replayAuthorized','custodySettled'])assert.equal(r[key],false);
 assert.deepEqual(r.savedOperatorCurrent,saved.operatorCurrent);
});
test('changed, absent, truncated, normalized or appended custody cannot stand in for the admitted bytes',()=>{
 for(const [a,b] of [[undefined,journal],[new Uint8Array(lock),journal],[lock,Buffer.alloc(0)],
  [lock.subarray(0,lock.length-1),journal],[lock,journal.subarray(0,journal.length-1)],
  [Buffer.from(JSON.stringify(saved)),journal],[lock,Buffer.concat([journal,Buffer.from('{}\n')])],
  [lock,Buffer.from(journal.toString().replace('postinspect','inspect'))]])
  assert.throws(()=>verifyCarePostcommitCustody(a,b,original,application),/postcommit_custody_digest/);
 for(const change of [x=>x.runId='a'.repeat(32),x=>x.lockSha256='a'.repeat(64),x=>x.journalSha256='a'.repeat(64)]){
  const x=structuredClone(original);change(x);assert.throws(()=>verifyCarePostcommitCustody(lock,journal,x,application));
 }
 const other=structuredClone(application);other.mobile.easSha256='a'.repeat(64);
 assert.throws(()=>verifyCarePostcommitCustody(lock,journal,original,other));
});
function successor(){
 const f=careIntentResumptionFixture(),r=structuredClone(f.supplied.baseline);
 Object.assign(r,{observedMigrationCount:48,sourceMigrationCount:47,tableCount:89,alreadyApplied:true,
  originalDataSha256:F.originalDataSha256,dataSha256:F.completeDataSha256,completeDataSha256:F.completeDataSha256,
  schemaSha256:F.schemaSha256});
 return {current:f.operator,r};
}
test('successor inspection independently requires complete and original inventories and empty new table',()=>{
 const {current,r}=successor(),copy=structuredClone(r);
 assert.deepEqual(verifyCareIntentSuccessorInspector(r,current),r);assert.deepEqual(r,copy);
 for(const change of [x=>x.command='upgrade',x=>x.alreadyApplied=false,x=>x.applied=true,x=>x.rolledBack=true,
  x=>x.observedMigrationCount=47,x=>x.sourceMigrationCount=46,x=>x.tableCount=88,x=>x.rowCount++,
  x=>x.originalRowCount++,x=>x.completeRowCount++,x=>x.intentRowCount=1,
  x=>x.originalDataSha256=x.completeDataSha256,x=>x.completeDataSha256=x.originalDataSha256,
  x=>x.dataSha256=x.originalDataSha256,x=>x.schemaSha256='a'.repeat(64),
  x=>x.fromLedgerSha256='a'.repeat(64),x=>x.toLedgerSha256='a'.repeat(64),x=>x.referenceLedgerSha256='a'.repeat(64),
  x=>x.operatorSource.clean=false,x=>x.operatorSource.sourceCommit='a'.repeat(40),
  x=>x.awsAccountId='173535830222',x=>x.foundation='other',x=>x.execution='production',x=>x.phiAllowed=true,
  ...['canonicalRegistered','hostedAcceptance','recoveryAcceptance','activationApproved','rollbackReadback',
   'lastingUpgradeAvailable','apiDeploymentPerformed','recoveryDrillPerformed','acceptance','phiActivation'].map(key=>x=>x[key]=true)]){
  const x=structuredClone(r);change(x);assert.throws(()=>verifyCareIntentSuccessorInspector(x,current),change.toString());
 }
 for(const key of Object.keys(r)){const x=structuredClone(r);delete x[key];assert.throws(()=>verifyCareIntentSuccessorInspector(x,current),key);}
});
test('postcommit CLI offers no target, write, report-loading, retry, approval or unlock surface',()=>{
 const a=['--v2-root','mobile','--candidate','candidate','--inspect-admitted-fictional-intent-successor-only'];
 assert.deepEqual(careIntentPostcommitArgs(a),{mobileRoot:resolve('mobile'),directory:resolve('candidate')});
 for(const x of ['--target','--report','--unlock','--settle','--resume','--upgrade','--approve','--phi','--skip','--qualifier','--build'])
  assert.throws(()=>careIntentPostcommitArgs([...a,x]));
 for(const x of [[],a.slice(0,4),[...a.slice(0,4),'--resume'],['--v2-root','--approve',...a.slice(2)],
  ['--v2-root','',...a.slice(2)],['--v2-root','mobile','--candidate','',a[4]]])assert.throws(()=>careIntentPostcommitArgs(x));
 const code=readFileSync(new URL('./care-intent-postcommit.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(code,/writeFileSync|unlinkSync|renameSync|mkdirSync|process\.env|\.send\(/);
 const live=readFileSync(new URL('./reconcile-synthetic-care-intent.mjs',import.meta.url),'utf8');
 assert.match(live,/verifyCareIntentSuccessorInspector\(await schema\('inspect'\),operatorCurrent\)/);
 assert.match(live,/baseline=await inspect\(\)/);assert.match(live,/const after=await inspect\(\)/);
 assert.doesNotMatch(live,/schema\('(?:upgrade|rehearse)'\)|custody\.settle|unlinkSync/);
 assert.match(live,/return \{result\};/);
});
