import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {digest,normalized,sourceMapping,CARE_ERASURE_RECOVERY_PARENT} from './build-care-erasure-recovery-source.mjs';
const directory='infra/aws-clinical-core/migrations/';
const canonical=JSON.parse(readFileSync(directory+'historical-care-parent-46.json','utf8')).migrations.map(m=>{
 const sql=normalized(readFileSync(directory+m.file,'utf8'));
 return {version:m.version,name:m.file.slice(15,-4),sql,sha256:digest(sql)};
});
const overlay=normalized(readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8'));
const commit='a'.repeat(40);
test('exact normalized predecessor and blocked metadata; no code hash is an approval',()=>{
 const m=sourceMapping(canonical,overlay,commit,false);
 assert.equal(m.predecessor,CARE_ERASURE_RECOVERY_PARENT);
 assert.equal(m.handlerIntegrated,true);
 assert.equal(m.preservingOperatorLibrary,true);
 assert.equal(m.inspectionRehearsalExecutable,true);
 assert.equal(m.lastingUpgradeExecutable,false);
 assert.equal(m.candidateLedgerMapping.sourceAfterCount,47);
 assert.equal(m.candidateLedgerMapping.liveBeforeCount,47);
 assert.equal(m.candidateLedgerMapping.liveAfterCount,48);
 assert.equal(m.candidateLedgerMapping.historicalAliasPreserved,true);
 assert.equal(m.candidateLedgerMapping.canonicalRegistered,false);
 assert.equal(m.clientIntegration,'requires_matched_v2_source_evidence');
 for(const key of ['deployable','canonicalRegistered','operatorExists','matchedMobileRelease',
  'hostedVerified','deviceVerified','productionApproved','phiAllowed'])assert.equal(m[key],false,key);
 assert.equal(m.retention.reviewedPolicy,false);assert.equal(m.recoverySemantics.wholeScanIsAtomic,false);
 assert.equal(m.overlay.sha256,digest(overlay));assert.equal(m.futureTarget.account,'588966314750');
 assert.equal(m.futureTarget.qualificationDatabaseRefused,'clinical_core_qualification');
});
test('changed SQL, omitted predecessor, reordered history, and extra migration refuse',()=>{
 for(const rows of [canonical.slice(0,-1),[...canonical].reverse(),[...canonical,canonical[0]],
  canonical.map((r,i)=>i? r:{...r,sql:r.sql+'-- drift\n'}),
  canonical.map((r,i)=>i? r:{...r,sql:r.sql+'-- drift\n',sha256:digest(r.sql+'-- drift\n')})]){
  assert.throws(()=>sourceMapping(rows,overlay,commit,false),/parent_refused/);
 }
});
test('missing guard, publicly callable predecessor, newline drift and invalid source binding refuse',()=>{
 for(const sql of [overlay+'-- drift\n',overlay.replace('BLOCKED SYNTHETIC SOURCE CANDIDATE.','READY'),
  overlay.replace('care_data_erasure_request_v1_terminal(jsonb) from public,clinical_core_api;',
   'care_data_erasure_request_v1_terminal(jsonb) from public;'),overlay.replaceAll('\n','\r\n')]){
  assert.throws(()=>sourceMapping(canonical,sql,commit,false),/overlay_refused/);
 }
 assert.throws(()=>sourceMapping(canonical,overlay,'main',false),/parent_refused/);
 assert.throws(()=>sourceMapping(canonical,overlay,commit,'false'),/parent_refused/);
});
test('Windows normalized bytes produce the same digest and uncommitted build is labeled dirty',()=>{
 assert.equal(digest(normalized(overlay.replaceAll('\n','\r\n'))),digest(overlay));
 assert.equal(sourceMapping(canonical,overlay,commit,true).sourceDirty,true);
});
