import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {retireCareIntentPostcommitCustody} from './care-intent-postcommit-settlement.mjs';
import {careIntentPostcommitSettlementArgs} from './settle-synthetic-care-intent-postcommit.mjs';
import {CARE_INTENT_POSTCOMMIT as F} from './care-intent-postcommit.mjs';
const audit=name=>Buffer.from(readFileSync(new URL('../docs/evidence/2026-10-08-care-intent-'+name,import.meta.url),'utf8').replaceAll('\r\n','\n'));
function fixture(t){
 const root=mkdtempSync(resolve(tmpdir(),'alp-postsettlement-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const directory=resolve(root,'candidate');mkdirSync(resolve(root,'dist/synthetic-care-routing'),{recursive:true});
 mkdirSync(resolve(directory,'uploads'),{recursive:true});mkdirSync(resolve(directory,'resumptions'),{recursive:true});
 const r=JSON.parse(audit('successor-reconciliation.json')),now=Date.parse(r.observedAt),current=r.operatorCurrent;
 const paths={originalLock:resolve(root,'dist/synthetic-care-routing/operator.lock'),
  originalJournal:resolve(directory,'uploads',F.parentRunId+'.events.jsonl'),
  secondaryLock:resolve(root,'dist/synthetic-care-routing/operator.resume.lock'),
  secondaryJournal:resolve(directory,'resumptions',F.runId+'.events.jsonl')};
 const originals={originalLock:audit('parent.operator.lock.json'),originalJournal:audit('parent.events.jsonl'),
  secondaryLock:audit('resumption.operator.lock.json'),secondaryJournal:audit('resumption.events.jsonl')};
 for(const key of Object.keys(paths))writeFileSync(paths[key],originals[key]);
 Object.assign(r.interruption,{lock:paths.originalLock,journal:paths.originalJournal});
 Object.assign(r.postcommitCustody,{lock:paths.secondaryLock,journal:paths.secondaryJournal});
 let observed=0,time=now-1;const removed=[];
 const d={now:()=>time,current:async()=>structuredClone(current),observe:async()=>{observed++;time=now+observed;
  return {...structuredClone(r),observedAt:new Date(time).toISOString()};},
  remove:path=>{removed.push(path);unlinkSync(path);}};
 return {root,directory,r,current,paths,originals,d,removed,get observed(){return observed;},advance:ms=>time+=ms};
}
const guard=f=>resolve(f.root,'dist/synthetic-care-routing/operator.postcommit.lock');
const archive=f=>resolve(f.directory,'resumptions',readdirSync(resolve(f.directory,'resumptions')).find(s=>s.endsWith('.postcommit-custody')));
test('two fresh matching observations archive all exact custody before only the two local locks retire',async t=>{
 const f=fixture(t),result=await retireCareIntentPostcommitCustody(f.root,f.directory,f.d);
 assert.equal(f.observed,2);assert.equal(result.originalReleaseAccepted,false);assert.equal(result.erasureAccepted,false);
 assert.equal(result.outcome,'reconciled_committed_successor_not_release_acceptance');assert.equal(result.phiAllowed,false);
 assert.equal(existsSync(f.paths.originalLock),false);assert.equal(existsSync(f.paths.secondaryLock),false);assert.equal(existsSync(guard(f)),false);
 for(const key of Object.keys(f.paths))assert.ok(readFileSync(resolve(result.archive,key)).equals(f.originals[key]));
 assert.ok(readFileSync(f.paths.originalJournal).equals(f.originals.originalJournal));
 assert.ok(readFileSync(f.paths.secondaryJournal).equals(f.originals.secondaryJournal));
 assert.deepEqual(f.removed,[f.paths.secondaryLock,f.paths.originalLock,guard(f)]);
});
test('a stale, incomplete, differently sourced or falsely approved first observation never admits a guard or removal',async t=>{
 for(const change of [r=>r.observedAt='2000-01-01',r=>r.operatorCurrent.desktop.clean=false,r=>r.successorReconciled=false,
  r=>r.custodySettled=true,r=>r.awsMutationPerformed=true,r=>r.compatibleRecoveryVerified=true,r=>r.phiAllowed=true,
  r=>delete r.control,r=>delete r.artifact,r=>r.transport.policy={},r=>r.control.iamVerified=false,
  r=>r.databaseAfter.intentRowCount=1,r=>r.postcommitCustody.previousProcessAbsent=false,r=>r.interruption.lock='elsewhere']){
  const f=fixture(t),observe=f.d.observe;f.d.observe=async()=>{const r=await observe();change(r);return r;};
  await assert.rejects(retireCareIntentPostcommitCustody(f.root,f.directory,f.d));
  assert.equal(f.removed.length,0);assert.equal(existsSync(guard(f)),false);
  assert.ok(readFileSync(f.paths.originalLock).equals(f.originals.originalLock));
 }
});
test('second observation loss or service, schema, authority and custody drift preserve both original locks and the new guard',async t=>{
 for(const change of [r=>r.control.routesSha256='a'.repeat(64),r=>r.transport.revisionId='other',
  r=>r.databaseAfter.originalDataSha256='a'.repeat(64),r=>r.revision='other',r=>r.phiAllowed=true]){
  const f=fixture(t),observe=f.d.observe;let calls=0;f.d.observe=async()=>{const r=await observe();if(++calls===2)change(r);return r;};
  await assert.rejects(retireCareIntentPostcommitCustody(f.root,f.directory,f.d));
  assert.equal(f.removed.length,0);assert.equal(existsSync(guard(f)),true);
  for(const key of Object.keys(f.paths))assert.ok(readFileSync(f.paths[key]).equals(f.originals[key]));
 }
 const f=fixture(t),observe=f.d.observe;let calls=0;f.d.observe=async()=>{if(++calls===2)throw Error('observation_lost');return observe();};
 await assert.rejects(retireCareIntentPostcommitCustody(f.root,f.directory,f.d));assert.equal(f.removed.length,0);assert.equal(existsSync(guard(f)),true);
});
test('changed archive, concurrent source or a preexisting exclusive guard cannot clear original custody',async t=>{
 for(const mode of ['archive','source','exclusive']){
  const f=fixture(t),observe=f.d.observe;let calls=0;
  if(mode==='exclusive')writeFileSync(guard(f),'other');
  f.d.observe=async()=>{const r=await observe();if(++calls===2&&mode==='archive')writeFileSync(resolve(archive(f),'originalLock'),'changed');return r;};
  if(mode==='source'){let reads=0;f.d.current=async()=>{const c=structuredClone(f.current);if(++reads>1)c.desktop.sha256='a'.repeat(64);return c;};}
  await assert.rejects(retireCareIntentPostcommitCustody(f.root,f.directory,f.d));assert.equal(f.removed.length,0);
  assert.ok(readFileSync(f.paths.originalLock).equals(f.originals.originalLock));
 }
});
test('interrupted second removal keeps the remaining lock, guard and recoverable exact archive; no retry is attempted',async t=>{
 const f=fixture(t);f.d.remove=path=>{f.removed.push(path);if(path===f.paths.originalLock)throw Error('remove_denied');unlinkSync(path);};
 await assert.rejects(retireCareIntentPostcommitCustody(f.root,f.directory,f.d));
 assert.equal(existsSync(f.paths.secondaryLock),false);assert.equal(existsSync(f.paths.originalLock),true);assert.equal(existsSync(guard(f)),true);
 assert.equal(f.removed.length,2);
 for(const key of Object.keys(f.paths))assert.ok(readFileSync(resolve(archive(f),key)).equals(f.originals[key]));
 const finding=JSON.parse(readFileSync(resolve(archive(f),'finding.json')));assert.equal(finding.secondaryRetired,true);assert.equal(finding.originalRetired,false);
});
test('settlement CLI accepts only the explicit fictional archival action and cannot import a status report',()=>{
 const a=['--v2-root','v','--candidate','c','--archive-reconciled-fictional-intent-custody-only'];
 careIntentPostcommitSettlementArgs(a);
 for(const extra of ['--report','--force','--approve','--unlock','--target','--phi','--skip','--replay','--upgrade'])
  assert.throws(()=>careIntentPostcommitSettlementArgs([...a,extra]));
 for(const args of [[],a.slice(0,4),['--v2-root','',...a.slice(2)],[...a.slice(0,4),'--settle']])assert.throws(()=>careIntentPostcommitSettlementArgs(args));
 const entry=readFileSync(new URL('./settle-synthetic-care-intent-postcommit.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(entry,/readFileSync|process\.env|JSON\.parse/);
});
