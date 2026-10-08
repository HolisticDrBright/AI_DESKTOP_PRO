/** A stopped standalone test is compensated, never resumed or certified from
 * saved results. Original deployment custody and this test custody are both
 * verified. Actual public ports are constructed separately, not supplied. */
import {sha256} from './synthetic-care-release.mjs';
import {assertCareRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyInterruptedRegisteredReleaseCustody} from './reconcile-synthetic-care-registered-release.mjs';
import {verifyRegisteredStandaloneCustody} from './care-registered-standalone-custody.mjs';
import {runRegisteredRoutingCompensation} from './restore-synthetic-care-registered-routing.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('standalone_restoration_'+c);};
export async function runRegisteredStandaloneRestoration(candidate,operator,c,sourceText,d){
 assertCareRegisteredCurrent(operator);const started=d.now(),originBytes=await d.originalCustody(),
  original=await verifyInterruptedRegisteredReleaseCustody(originBytes,candidate,sourceText,started,d.originalEvidence),
  current=original.current,origin={runId:original.lock.runId,lockSha256:sha256(originBytes.lockBytes),journalSha256:sha256(originBytes.journalBytes)};
 check(original.scope==='execution'&&!original.events.some(e=>e.stage==='registered_upload_completed'),'original_execution');
 let ownLock;try{ownLock=JSON.parse(c.lockBytes);}catch{refuseRegistered('standalone_restoration_lock_json');}
 const ownOperator=ownLock.operatorSource;
 const parsed=await verifyRegisteredStandaloneCustody(c,current,ownOperator,origin,started,d.evidence,{restorationOperator:operator});
 // A completed writer lost during local settlement gets read-only observations,
 // never compensating writes or a new claim that the old tests were rerun.
 const readOnly=Boolean(parsed.completed);
 const deployed=original.events.find(e=>e.stage==='registered_deployed_bytes_control_verified');check(deployed,'missing_original_successor');
 const originalGuard=async()=>{
  const bytes=await d.originalCustody();check(bytes.lockBytes.equals(originBytes.lockBytes)&&bytes.journalBytes.equals(originBytes.journalBytes),'original_custody_changed');
  check(await d.writerStopped(original.lock.pid)===true,'original_writer_active');
  if(original.restoration)check(started-original.restoration.lastAt>=60000&&await d.writerStopped(original.restoration.pid)===true,'original_restoration_active');
 };
 await originalGuard();
 const saved={...original,lock:parsed.lock,current,events:[deployed,...parsed.events],sid:parsed.sid,
  journalSha256:parsed.journalSha256,originalJournalSha256:parsed.originalJournalSha256,restoration:parsed.restoration,
  originalRunOutcome:parsed.originalRunOutcome,originalFailure:parsed.originalFailure,readOnlyCompletion:readOnly,
  evidenceReferences:[...original.evidenceReferences.map(e=>({...e,kind:'original-'+e.kind})),...parsed.evidenceReferences]};
 const report=await runRegisteredRoutingCompensation(candidate,operator,c,sourceText,{
  ...d,custody:async()=>{await originalGuard();return d.custody();},
  returnLatest:async()=>{check(!readOnly,'completed_routing_drift');return d.returnLatest();},
  removePermission:async(...args)=>{check(!readOnly,'completed_permission_drift');return d.removePermission(...args);},
  evidence:async(file,kind)=>kind.startsWith('original-')?d.originalEvidence(file,kind.slice(9)):d.evidence(file,kind),
 },saved,started);
 await originalGuard();
 return {...report,contract:'synthetic-care-registered-standalone-restoration/1',original:origin,standaloneSource:ownOperator,
  originalReleaseOutcome:original.originalRunOutcome,originalReleaseFailure:original.originalFailure,
  standaloneOutcomePreserved:true,originalReleaseResultPreserved:true,
  restorationMode:readOnly?'read-only-completion':'compensating-stopped-test',completedTestResultNotRequalified:readOnly};
}
