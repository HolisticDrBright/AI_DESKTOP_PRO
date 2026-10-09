/** Local custody only. The original admitted lock/journal remain unchanged
 * during resumption. Fresh service reconciliation is separately mandatory. */
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
import {readCareIntentInterruption} from './care-intent-interruption.mjs';
import {verifyCareIntentResumptionBindings} from './care-intent-resumption-deployment.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('resume_custody_'+code);};
const durableWrite=(file,bytes)=>{
 const fd=openSync(file,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
};
export function createCareIntentResumptionCustody(root,directory,observed,candidate,application,operator){
 verifyCareIntentResumptionBindings(application,operator);
 const current=readCareIntentInterruption(root,directory,application,candidate);
 check(canonical(current)===canonical(observed),'original_changed');
 const runId=randomBytes(16).toString('hex'),out=resolve(directory,'resumptions'),lock=resolve(root,'dist/synthetic-care-routing/operator.resume.lock');
 mkdirSync(out,{recursive:true});
 const saved={runId,pid:process.pid,purpose:'intent-interrupted-release-resumption',parentRunId:observed.runId,
  parentLockSha256:observed.lockSha256,parentJournalSha256:observed.journalSha256,applicationCurrent:application,operatorCurrent:operator};
 const savedBytes=Buffer.from(JSON.stringify(saved)+'\n');
 try{durableWrite(lock,savedBytes);}catch{refuseIntent('resume_custody_exclusive_lock');}
 const journal=resolve(out,runId+'.events.jsonl');let admitted=false,settled=false;
 const guard=()=>{
  check(readFileSync(lock).equals(savedBytes),'owner_changed');
  check(canonical(readCareIntentInterruption(root,directory,application,candidate))===canonical(observed),'original_changed');
 };
 const record=event=>{
  const fd=openSync(journal,'a');try{writeFileSync(fd,JSON.stringify({...event,at:new Date().toISOString(),runId})+'\n');fsyncSync(fd);}
  finally{closeSync(fd);}
 };
 try{guard();record({stage:'interrupted_custody_bound',parentRunId:observed.runId,
  parentLockSha256:observed.lockSha256,parentJournalSha256:observed.journalSha256,remoteSuccessProven:false});}
 catch(e){if(readFileSync(lock).equals(savedBytes))unlinkSync(lock);throw e;}
 return {runId,lock,journal,guard,record,
  admit:event=>{guard();record(event);admitted=true;},
  settle:result=>{
   guard();check(result?.contract==='synthetic-care-intent-schema-release/1'&&result.schemaChanged===true
    &&result.preservationVerified===true&&result.compatibleRecoveryVerified===true
    &&canonical(result.current)===canonical(application)&&canonical(result.operatorCurrent)===canonical(operator)
    &&result.after?.alreadyApplied===true&&result.phiAllowed===false&&result.paidMobileBuildStarted===false,'unfinished');
   const originalLock=readFileSync(observed.lock),originalJournal=readFileSync(observed.journal);
   check(sha256(originalLock)===observed.lockSha256&&sha256(originalJournal)===observed.journalSha256,'archive_changed');
   const archive=resolve(out,runId+'.original-custody');mkdirSync(archive);
   durableWrite(resolve(archive,'operator.lock'),originalLock);durableWrite(resolve(archive,'events.jsonl'),originalJournal);
   guard();record({stage:'original_custody_archived',archive,parentRunId:observed.runId});
   // Clearing only the unchanged original lock follows confirmed settlement,
   // never PID age, a saved status report, or an observation timeout.
   guard();record({stage:'resumption_settled',schemaChanged:true,preservationVerified:true});
   unlinkSync(observed.lock);settled=true;
  },
  get admitted(){return admitted;},get settled(){return settled;},
  close:()=>{if(!admitted||settled){check(readFileSync(lock).equals(savedBytes),'owner_changed');unlinkSync(lock);}}
 };
}
