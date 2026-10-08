import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './synthetic-care-release.mjs';
import {canonical,CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {compileRegisteredIntentParser} from './care-registered-routing-live.mjs';
import {verifyRegisteredStandaloneCustody} from './care-registered-standalone-custody.mjs';
import {runRegisteredStandaloneRehearsal} from './care-registered-standalone.mjs';
import {careRegisteredStandaloneFixture} from './test-fixtures/care-registered-standalone.mjs';
import {createStandaloneCustody,settleStandaloneCustody,readStandaloneEvidence,registeredStandaloneArguments,rehearseRegisteredStandaloneLive} from './rehearse-synthetic-care-registered-standalone.mjs';
let parse;before(async()=>{parse=await compileRegisteredIntentParser(process.cwd());});
const fixture=()=>careRegisteredStandaloneFixture(parse);
const run=f=>runRegisteredStandaloneRehearsal(f.candidate,f.operator,f.custody,f.sourceText,f.port);
function seeded(){const f=fixture();f.port.pid=f.lock.pid;const e={at:new Date(f.now).toISOString(),stage:'registered_standalone_started',runId:f.lock.runId,
 originalRunId:f.origin.runId,originalLockSha256:f.origin.lockSha256,originalJournalSha256:f.origin.journalSha256};
 f.events=[e];f.custody={...f.encode(),initialEvent:e};f.port.verifyCreatedCustody=()=>{};return f;}
function local(){const root=mkdtempSync(resolve(tmpdir(),'alp-standalone-')),shared=resolve(root,'shared'),out=resolve(root,'out');
 mkdirSync(shared);mkdirSync(out);const f=fixture(),guard={verify(){}};
 const owned=createStandaloneCustody(shared,out,f.current,f.operator,f.origin,guard,f.now,process.pid);return {root,shared,out,f,owned};}
const destroy=t=>{assert(t.root.startsWith(resolve(tmpdir(),'alp-standalone-')));rmSync(t.root,{recursive:true,force:true});};
test('actual fresh seed is recognized once and its verifier stays live through every write',async()=>{
 const f=seeded();let guards=0;f.port.verifyCreatedCustody=()=>{guards++;};const r=await run(f);
 assert.equal(r.recoveryRehearsed,true);assert(guards>30);assert.equal(f.events.filter(e=>e.stage==='registered_standalone_started').length,1);
});
test('fresh seed cannot be stale, preexisting, forged, wrongly owned or extended',async()=>{
 for(const mutate of [f=>f.now+=120001,f=>f.custody.initialEvent.at=new Date(f.now+1).toISOString(),
  f=>f.port.pid++,f=>delete f.port.verifyCreatedCustody,f=>f.custody.initialEvent.runId='a'.repeat(32),
  f=>f.custody.journalBytes=Buffer.concat([f.custody.journalBytes,Buffer.from('{}\n')]),
  f=>f.port.verifyCreatedCustody=()=>{throw Error('changed inode');}]){
  const f=seeded();mutate(f);await assert.rejects(run(f));assert(!f.calls.includes('grant'));}
});
test('observer source is separately checked and faithfully attributed',async()=>{
 const good=fixture(),report=await run(good);assert.deepEqual(report.recovery.observerSource,good.operator);
 assert.notEqual(report.recovery.current.desktop.commit,report.recovery.observerSource.desktop.commit);
 for(const mutate of [f=>f.routing.observerCurrent=async()=>f.current,
  f=>f.routing.inspect=async()=>({...structuredClone(f.after.database),operatorSource:{sourceCommit:f.current.desktop.commit,clean:true}})]){
  const f=fixture();mutate(f);await assert.rejects(run(f));assert(!f.calls.includes('grant'));}
});
test('filesystem constructor seeds parseable journal before exclusive custody and never steals existing lock',async()=>{
 const t=local();try{const {c}=t.owned;assert(readFileSync(c.lock).equals(c.lockBytes));assert.equal(JSON.parse(readFileSync(c.journal)).stage,'registered_standalone_started');
  const parsed=await verifyRegisteredStandaloneCustody(t.owned.custody(),t.f.current,t.f.operator,t.f.origin,t.f.now+61000,()=>{});
  assert.equal(parsed.writeAdmitted,false);assert.equal(parsed.originalRunOutcome,'interrupted');
  assert.throws(()=>createStandaloneCustody(t.shared,t.out,t.f.current,t.f.operator,t.f.origin,c.guard,t.f.now,process.pid),/operator_active/);
  assert(readFileSync(c.lock).equals(c.lockBytes));t.owned.verifyCreated();
 }finally{destroy(t);}
});
test('filesystem custody refuses replacement bytes, journal growth, invalid PID and failed kernel guard',()=>{
 for(const kind of ['lock','journal','pid','guard']){const t=local();try{const {c}=t.owned;
  if(kind==='lock')writeFileSync(c.lock,'{}\n');else if(kind==='journal')writeFileSync(c.journal,'{}\n');
  else if(kind==='pid')assert.throws(()=>createStandaloneCustody(t.shared,t.out,t.f.current,t.f.operator,t.f.origin,c.guard,t.f.now,0),/creation_identity/);
  else c.guard.verify=()=>{throw Error('mutex lost');};
  if(kind!=='pid')assert.throws(()=>t.owned.verifyCreated());
 }finally{destroy(t);}}
});
test('actual completion archives and reads receipts before releasing only its own local lock',async()=>{
 const t=local();try{const f=t.f,{c}=t.owned;f.lock=JSON.parse(c.lockBytes);f.events=[c.initialEvent];f.custody=c;
  f.port.pid=process.pid;f.port.verifyCreatedCustody=t.owned.verifyCreated;f.port.verifyLocal=t.owned.verifyLocal;
  f.port.custody=t.owned.custody;f.port.record=e=>{f.events.push(e);return t.owned.record(e);};
  const report=await run(f),settled=settleStandaloneCustody(c,report,'rehearsal');
  assert.equal(settled.operatorCustodySettled,true);assert.equal(existsSync(c.lock),false);
  assert(readFileSync(settled.archive).equals(c.lockBytes));assert.deepEqual(JSON.parse(readFileSync(settled.receipt)),report);
  t.owned.retired();assert.throws(()=>t.owned.verifyCreated());
 }finally{destroy(t);}
});
test('forged settlement, conflicting receipt or changed custody never releases local lock',async()=>{
 for(const kind of ['phi','digest','receipt','lock']){const t=local();try{const f=t.f,{c}=t.owned;f.lock=JSON.parse(c.lockBytes);f.events=[c.initialEvent];f.custody=c;
  f.port.pid=process.pid;f.port.verifyCreatedCustody=t.owned.verifyCreated;f.port.verifyLocal=t.owned.verifyLocal;
  f.port.custody=t.owned.custody;f.port.record=e=>{f.events.push(e);return t.owned.record(e);};const report=await run(f);
  if(kind==='phi')report.phiAllowed=true;else if(kind==='digest')report.journalSha256='0'.repeat(64);
  else if(kind==='receipt')writeFileSync(resolve(c.out,report.runId+'.standalone-rehearsal-'+sha256(canonical(report))+'.json'),'different');
  else writeFileSync(c.lock,'different');
  assert.throws(()=>settleStandaloneCustody(c,report,'rehearsal'));assert(existsSync(c.lock));
 }finally{destroy(t);}}
});
test('evidence reader refuses wrong kind, alias, parent escape, byte digest and missing file',()=>{
 const t=local();try{const bytes=Buffer.from('{}\n'),file=resolve(t.out,'standalone-before-'+sha256(bytes)+'.json');writeFileSync(file,bytes);
  assert(readStandaloneEvidence(t.out,file,'standalone-before').equals(bytes));
  for(const [f,k] of [[file,'standalone-completed'],[resolve(t.root,'standalone-before-'+sha256(bytes)+'.json'),'standalone-before'],
   [resolve(t.out,'standalone-before-'+'0'.repeat(64)+'.json'),'standalone-before']])assert.throws(()=>readStandaloneEvidence(t.out,f,k));
  writeFileSync(file,'changed');assert.throws(()=>readStandaloneEvidence(t.out,file,'standalone-before'),/evidence_digest/);
 }finally{destroy(t);}
});
test('public arguments expose neither a supplied report, target/profile override nor PHI/build switch',()=>{
 const args=['--v2-root','mobile','--artifact','candidate','--application-root','application','--original-run','a'.repeat(32),'--rehearse-fictional-registered-only'];
 assert.equal(registeredStandaloneArguments(args).restore,false);
 assert.equal(registeredStandaloneArguments([...args.slice(0,-1),'--restore-stopped-fictional-standalone-only']).restore,true);
 for(const extra of ['--report','--profile','--endpoint-url','--phi','--approve','--paid-build'])assert.throws(()=>registeredStandaloneArguments([...args,extra,'value']));
 for(const changed of ['../escape','A'.repeat(32),'a'.repeat(31),''])assert.throws(()=>registeredStandaloneArguments([...args.slice(0,7),changed,args[8]]));
 const live=readFileSync(new URL('./rehearse-synthetic-care-registered-standalone.mjs',import.meta.url),'utf8');
 assert(!/execute-change-set|update-function-code|create-change-set|add-permission|eas build|PhiAllowed=true/.test(live));
 assert(live.includes('runCareRegisteredLiveRecovery(applicationRoot,mobileRoot,input,custody,root)'));
 assert(live.includes("AWS_MAX_ATTEMPTS:'1'"));assert(live.includes('observeSyntheticMemberIdentity()'));
 assert.equal(R.latestArn.includes('588966314750'),true);
});
test('endpoint overrides refuse before AWS identity, source reads or local custody creation',async()=>{
 for(const key of ['AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_STS']){const previous=process.env[key];
  try{process.env[key]='https://refused.invalid';
   await assert.rejects(rehearseRegisteredStandaloneLive('not-a-checkout','not-mobile','not-an-artifact','not-an-application','a'.repeat(32)),/endpoint_override/);
  }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}}
});
