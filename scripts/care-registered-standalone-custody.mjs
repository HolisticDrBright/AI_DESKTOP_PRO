/** Separate custody for a fresh rehearsal. A failed deployment journal is
 * immutable input, never rewritten into a successful release. No AWS ports. */
import {sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {assertCareRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {splitRegisteredRestorationJournal} from './care-registered-restoration-custody.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('standalone_custody_'+c);};
const equal=(a,b)=>canonical(a)===canonical(b);
const exact=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...n].sort());
const digest=v=>/^[a-f0-9]{64}$/.test(v??'');
const id=v=>/^[a-f0-9]{32}$/.test(v??'');
const fields={registered_standalone_started:['runId','originalRunId','originalLockSha256','originalJournalSha256'],
 registered_standalone_before_archived:['file','sha256'],registered_standalone_rehearsal_admitted:['beforeSha256'],
 registered_recovery_permission_admitted:['version','sid'],registered_recovery_switch_admitted:['version'],
 registered_recovery_return_admitted:['version'],registered_recovery_compensating_return_admitted:['version'],
 registered_recovery_cases_verified:['caseCount','version'],registered_recovery_permission_cleanup_admitted:['version'],
 registered_recovery_route_permission_restored:[],registered_compatible_routing_completed:['version'],
 registered_standalone_completed:['file','sha256'],registered_standalone_finding:['code','writeAdmitted']};
const transitions={registered_standalone_started:['registered_standalone_before_archived'],
 registered_standalone_before_archived:['registered_standalone_rehearsal_admitted'],
 registered_standalone_rehearsal_admitted:['registered_recovery_permission_admitted'],
 registered_recovery_permission_admitted:['registered_recovery_switch_admitted','registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
 registered_recovery_switch_admitted:['registered_recovery_return_admitted','registered_recovery_compensating_return_admitted'],
 registered_recovery_return_admitted:['registered_recovery_cases_verified','registered_recovery_compensating_return_admitted','registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
 registered_recovery_compensating_return_admitted:['registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
 registered_recovery_cases_verified:['registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
 registered_recovery_permission_cleanup_admitted:['registered_recovery_route_permission_restored'],
 registered_recovery_route_permission_restored:['registered_compatible_routing_completed'],
 registered_compatible_routing_completed:['registered_standalone_completed']};
export function verifyRegisteredStandaloneLock(bytes,current,operator,original){
 assertCareRegisteredCurrent(current);assertCareRegisteredCurrent(operator);
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=16384,'lock_bytes');let lock;
 try{lock=JSON.parse(bytes);}catch{refuseRegistered('standalone_custody_lock_json');}
 check(bytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))
  &&exact(lock,['purpose','pid','runId','applicationSource','operatorSource','original'])
  &&lock.purpose==='registered-standalone-routing-rehearsal'&&Number.isSafeInteger(lock.pid)&&lock.pid>0
  &&id(lock.runId)&&equal(lock.applicationSource,current)&&equal(lock.operatorSource,operator),'lock_binding');
 check(exact(lock.original,['runId','lockSha256','journalSha256'])&&id(lock.original.runId)
  &&lock.runId!==lock.original.runId&&[lock.original.lockSha256,lock.original.journalSha256].every(digest)
  &&equal(lock.original,original),'original_binding');
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'operator_binding');return lock;
}
/** Parses every prefix, including a hard crash without a finding. Historical
 * success is descriptive only: the stopped operator still needs actual reads. */
export async function verifyRegisteredStandaloneCustody(c,current,operator,original,now,readEvidence,{settled=true,restorationOperator=operator}={}){
 const lock=verifyRegisteredStandaloneLock(c?.lockBytes,current,operator,original);
 check(Buffer.isBuffer(c?.journalBytes)&&c.journalBytes.length>0&&c.journalBytes.length<=1024*1024,'journal_bytes');
 const split=splitRegisteredRestorationJournal(c.journalBytes,current,now);let events;
 try{events=split.originalJournalBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);}catch{refuseRegistered('standalone_custody_journal_json');}
 check(events.length>=1&&events.length<=18,'journal_scope');let prior=-Infinity;
 for(const e of events){
  check(Object.hasOwn(fields,e.stage)&&exact(e,['at','stage',...fields[e.stage]]),'event_fields');
  const t=Date.parse(e.at);check(Number.isFinite(t)&&t>=prior&&t<=now,'event_time');prior=t;
 }
 check(Number.isFinite(now)&&(!settled||now-prior>=60000),'writer_settlement');
 if(split.restoration)check(equal(split.restoration.operatorSource,restorationOperator),'restoration_operator');
 const first=events[0];check(first.stage==='registered_standalone_started'&&first.runId===lock.runId
  &&first.originalRunId===original.runId&&first.originalLockSha256===original.lockSha256
  &&first.originalJournalSha256===original.journalSha256,'start_binding');
 const finding=events.at(-1).stage==='registered_standalone_finding'?events.at(-1):null,
  rows=finding?events.slice(0,-1):events,evidenceReferences=[];
 let state=first.stage,beforeBytes,before,sid,completed;
 for(let i=1;i<rows.length;i++){
  const e=rows[i];check(transitions[state]?.includes(e.stage),'transition');state=e.stage;
  if(Object.hasOwn(e,'version'))check(e.version==='2','version');
  if(e.stage==='registered_standalone_before_archived'||e.stage==='registered_standalone_completed'){
   check(typeof readEvidence==='function'&&typeof e.file==='string'&&e.file.length>0&&e.file.length<=4096&&digest(e.sha256),'archive');
   const bytes=await readEvidence(e.file,e.stage==='registered_standalone_before_archived'?'standalone-before':'standalone-completed');
   check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=4*1024*1024&&sha256(bytes)===e.sha256,'archive_bytes');let value;
   try{value=JSON.parse(bytes);}catch{refuseRegistered('standalone_custody_archive_json');}
   check(bytes.equals(Buffer.from(JSON.stringify(value,null,2)+'\n')),'archive_encoding');
   evidenceReferences.push({file:e.file,kind:e.stage==='registered_standalone_before_archived'?'standalone-before':'standalone-completed',sha256:e.sha256});
   if(e.stage==='registered_standalone_before_archived'){
    before=value;beforeBytes=bytes;check(exact(before,['contract','runId','applicationSource','operatorSource','original','startedAt','observations'])
     &&before.contract==='synthetic-care-registered-standalone-before/1'&&before.runId===lock.runId
     &&equal(before.applicationSource,current)&&equal(before.operatorSource,operator)&&equal(before.original,original)
     &&before.startedAt===first.at&&Array.isArray(before.observations)&&before.observations.length===2,'before_binding');
   }else completed=value;
  }
  if(e.stage==='registered_standalone_rehearsal_admitted')check(e.beforeSha256===sha256(beforeBytes),'before_admission');
  if(e.stage==='registered_recovery_permission_admitted'){
   check(e.sid==='alp-care-intent-recovery-'+lock.runId,'permission_identity');sid=e.sid;
  }
  if(e.stage==='registered_recovery_cases_verified')check(e.caseCount===105,'case_count');
 }
 const writeAdmitted=Boolean(sid);
 if(finding)check(typeof finding.writeAdmitted==='boolean'&&finding.writeAdmitted===writeAdmitted
  &&/^synthetic_care_registered_release_refused:[a-z0-9_]{1,180}$/.test(finding.code)
  &&state!=='registered_standalone_completed','finding');
 if(split.restoration&&completed)check(split.restoration.events.every(e=>['registered_stopped_restoration_started','registered_stopped_restoration_observed'].includes(e.stage)),
  'completed_readonly_restoration');
 return {lock,current,operator,events,state,before,beforeBytes,sid,completed,evidenceReferences,writeAdmitted,
  journalSha256:sha256(c.journalBytes),originalJournalSha256:sha256(split.originalJournalBytes),
  originalRunOutcome:finding?'failed':completed?'completed':'interrupted',originalFailure:finding?.code??null,
  restoration:split.restoration,lastAt:split.restoration?.lastAt??prior};
}
