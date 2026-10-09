/** Read-only reconciliation of ONE admitted postcommit failure. The journal
 * binds its location and history, never proves AWS success or unlocks custody. */
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {careIntentProcessAbsent} from './care-intent-interruption.mjs';
import {verifyCareIntentResumptionBindings} from './care-intent-resumption-deployment.mjs';
import {readHistoricalCareSource,verifyCareHistoricalSnapshot} from './care-intent-resumption-source.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('postcommit_'+code);};
// Immutable identity of the admitted run, not configurable success assertions.
export const CARE_INTENT_POSTCOMMIT=Object.freeze({
 runId:'bccd1492d8dae22401676387cdba66ec',parentRunId:'cc190186dd49bd98865d1f4da43e73e7',
 operatorDesktop:'7399e59a99131e5701ea30f6306d8c89be88e6b8',
 operatorMobile:'315e8deaa7e0e37d77c949dfefaadb595b605612',
 lockSha256:'53d4e579ec83323df899bcaa2f3b69d4e6e78d859921f2737826bcc8a80362e4',
 journalSha256:'a6cb52d7f5f3dd6d198871b8edf37f8120383c46f80c61f6d696084a4a71e0e4',
 parentLockSha256:'72757b3401472a40db201ec686d28f619d15767f23f553c30474ca6ef07e3f83',
 parentJournalSha256:'ed35fbb6f6803e235dfba80c6d1e839c97b96f18961f75e63d40b56ccc6e7121',
 originalDataSha256:'29e413773ffb4e263421b312501242384e5f6085b3930fd6339fa9100ab53351',
 completeDataSha256:'d7f7c07d521aa1b68c4ffa7273a871b1a1d5763e725a87b8a97cd3a4fd981d1b',
 schemaSha256:'629df9a05ecd1f7534204f1ee6ab9116a4a5544d86b5296f993a04d263d62bba',
 rowCount:23985,
});
const fixed=CARE_INTENT_POSTCOMMIT;
export function verifyCarePostcommitCustody(lockBytes,journalBytes,original,application){
 check(Buffer.isBuffer(lockBytes)&&Buffer.isBuffer(journalBytes)
  &&sha256(lockBytes)===fixed.lockSha256&&sha256(journalBytes)===fixed.journalSha256,'custody_digest');
 let saved,events;
 try{saved=JSON.parse(lockBytes.toString('utf8'));events=journalBytes.toString('utf8').trimEnd().split('\n').map(s=>JSON.parse(s));}
 catch{refuseIntent('postcommit_custody_json');}
 check(saved.runId===fixed.runId&&saved.parentRunId===fixed.parentRunId&&saved.purpose==='intent-interrupted-release-resumption'
  &&Number.isSafeInteger(saved.pid)&&saved.pid>0
  &&saved.parentLockSha256===fixed.parentLockSha256&&saved.parentJournalSha256===fixed.parentJournalSha256
  &&original.runId===fixed.parentRunId&&original.lockSha256===fixed.parentLockSha256&&original.journalSha256===fixed.parentJournalSha256
  &&canonical(saved.applicationCurrent)===canonical(application)
  &&saved.operatorCurrent?.desktop?.commit===fixed.operatorDesktop&&saved.operatorCurrent.mobile?.source?.commit===fixed.operatorMobile,'custody_binding');
 verifyCareIntentResumptionBindings(application,saved.operatorCurrent);
 check(events.length===108&&events.every((e,i)=>e.runId===fixed.runId&&Number.isFinite(Date.parse(e.at))
  &&(i===0||Date.parse(e.at)>=Date.parse(events[i-1].at)))
  &&events.at(-1).stage==='finding'&&events.at(-1).code==='synthetic_care_intent_release_refused:continuation_schema_postinspect'
  &&events.at(-1).writeAdmitted===true,'custody_scope');
 return {runId:saved.runId,pid:saved.pid,parentRunId:saved.parentRunId,
  savedOperatorCurrent:saved.operatorCurrent,lockSha256:fixed.lockSha256,journalSha256:fixed.journalSha256,
  commitAdmitted:true,remoteSuccessProven:false,replayAuthorized:false,custodySettled:false};
}
const bounded=(path,max)=>{
 const stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=max,'custody_file');
 const bytes=readFileSync(path);check(bytes.length===stat.size&&bytes.length<=max,'custody_read');return bytes;
};
export function readCarePostcommitCustody(root,directory,original,application){
 const lock=resolve(root,'dist/synthetic-care-routing/operator.resume.lock'),journal=resolve(directory,'resumptions',fixed.runId+'.events.jsonl');
 const result=verifyCarePostcommitCustody(bounded(lock,16384),bounded(journal,1024*1024),original,application);
 careIntentProcessAbsent(result.pid);
 const saved=result.savedOperatorCurrent;
 // Fresh ancestor Git reconstruction is required even for the old operator.
 verifyCareHistoricalSnapshot(readHistoricalCareSource(root,'desktop',saved.desktop.commit),saved.desktop);
 // Mobile reconstruction belongs to the caller, which knows its checkout.
 return {...result,lock,journal,previousProcessAbsent:true,originalCustodyRetained:true};
}
export function verifyCareIntentSuccessorInspector(r,current){
 const m=current.migrations;
 check(r?.contract==='care-erasure-intent-upgrade/1'&&r.command==='inspect'
  &&canonical(r.operatorSource)===canonical({sourceCommit:current.desktop.commit,clean:true})
  &&r.awsAccountId===P.account&&r.foundation===P.foundation&&r.execution==='synthetic-staging'&&r.phiAllowed===false
  &&r.observedMigrationCount===48&&r.sourceMigrationCount===47&&r.tableCount===89
  &&r.rowCount===fixed.rowCount&&r.originalRowCount===fixed.rowCount&&r.completeRowCount===fixed.rowCount&&r.intentRowCount===0
  &&r.originalDataSha256===fixed.originalDataSha256&&r.completeDataSha256===fixed.completeDataSha256
  &&r.dataSha256===fixed.completeDataSha256&&r.schemaSha256===fixed.schemaSha256
  &&r.applied===false&&r.alreadyApplied===true&&r.rolledBack===false&&r.dataPreserved===true&&r.schemaPreserved===true
  &&r.fromLedgerSha256===m.liveBefore&&r.toLedgerSha256===m.liveAfter&&r.referenceLedgerSha256===m.reference
  &&['canonicalRegistered','hostedAcceptance','recoveryAcceptance','activationApproved','rollbackReadback','lastingUpgradeAvailable',
   'apiDeploymentPerformed','recoveryDrillPerformed','acceptance','phiActivation'].every(k=>r[k]===false),'successor_inspection');
 return structuredClone(r);
}
