/** Exclusive local admission shared with routing operators. Never retire a
 * stopped or live predecessor lock, and never unlock an uncertain rehearsal. */
import {randomBytes} from 'node:crypto';
import {existsSync,lstatSync,openSync,writeFileSync,fsyncSync,closeSync,readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256,CARE_RELEASE as P} from './synthetic-care-release.mjs';
export const refuseCatalogRollback = code => {throw Error('catalog_forward_rollback_refused:'+code);};
const check=(v,c)=>{if(!v)refuseCatalogRollback(c);};
export function boundedCatalogFile(file,max=4*1024*1024){
 const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'file');
 const bytes=readFileSync(file),b=lstatSync(file);
 check(a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&bytes.length===a.size,'file_changed');return bytes;
}
export function saveCatalogBytes(file,bytes){
 let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
 check(boundedCatalogFile(file).equals(bytes),'archive_readback');
}
export function verifyCatalogAppliedReadback(before,after,source){
 const successor='80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a';
 check(before?.contract==='catalog-forward-upgrade/1'&&before.command==='inspect'&&before.execution==='synthetic-staging'
  &&before.referenceMigrationCount===2&&before.referenceLedgerSha256==='83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62'
  &&before.coreLedgerSha256==='447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50'
  &&before.candidateSqlSha256==='3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117'
  &&before.tableCount===89&&Number.isSafeInteger(before.rowCount)&&before.rowCount>=0
  &&['dataSha256','preservedSchemaSha256','observationSha256'].every(k=>/^[a-f0-9]{64}$/.test(before[k]))
  &&['dataPreserved','schemaPreserved','historicalLedgerPreserved'].every(k=>before[k]===true)
  &&['applied','alreadyApplied','rolledBack','canonicalRegistered','hostedAcceptance','activationApproved','phiAllowed',
    'databaseMutationPerformed','apiDeploymentPerformed','phiActivation'].every(k=>before[k]===false)
  &&before.awsAccountId===P.account&&before.foundation===P.foundation&&before.operatorSource?.clean===true
  &&before.operatorSource.sourceCommit===source.commit,'apply_readback');
 const witness=referenceLedgerSha256=>sha256(JSON.stringify({contract:'catalog-forward-upgrade-observation/1',
  account:P.account,region:P.region,clusterArn:P.cluster,secretArn:P.secret,databaseName:P.database,
  coreLedgerSha256:before.coreLedgerSha256,referenceLedgerSha256,candidateSqlSha256:before.candidateSqlSha256,
  dataSha256:before.dataSha256,schemaSha256:before.preservedSchemaSha256}));
 check(before.observationSha256===witness(before.referenceLedgerSha256)
  &&JSON.stringify(after)===JSON.stringify({...before,referenceMigrationCount:3,referenceLedgerSha256:successor,
   alreadyApplied:true,observationSha256:witness(successor)}),'apply_readback');
}
export function createCatalogRollbackCustody(shared,out,source,guard,now=Date.now(),pid=process.pid,mode='rollback'){
 check(['rollback','lock-admission','apply'].includes(mode),'mode');
 const sequence=mode==='rollback'
  ?['catalog_rollback_started','catalog_rollback_admitted','catalog_rollback_readback_verified','catalog_rollback_control_verified']
  :mode==='lock-admission'?['catalog_rollback_started','catalog_lock_fixture_admitted','catalog_lock_writer_admitted','catalog_lock_wait_observed',
    'catalog_lock_refusal_verified','catalog_lock_cleanup_admitted','catalog_lock_cleanup_verified','catalog_rollback_control_verified']
  :['catalog_rollback_started','catalog_rollback_admitted','catalog_rollback_readback_verified',
    'catalog_lock_fixture_admitted','catalog_lock_writer_admitted','catalog_lock_wait_observed','catalog_lock_refusal_verified',
    'catalog_lock_cleanup_admitted','catalog_lock_cleanup_verified','catalog_apply_admitted','catalog_apply_committed',
    'catalog_apply_readback_verified','catalog_rollback_control_verified'];
 check([shared,out].every(p=>{const s=lstatSync(p);return s.isDirectory()&&!s.isSymbolicLink();}),'directory');
 check(source?.clean===true&&/^[a-f0-9]{40}$/.test(source.commit)&&/^[a-f0-9]{64}$/.test(source.sha256)
  &&Number.isSafeInteger(source.files)&&source.files>0&&Number.isSafeInteger(pid)&&pid>0&&Number.isFinite(now),'source');
 guard.verify();const runId=randomBytes(16).toString('hex'),lock=resolve(shared,'operator.lock'),journal=resolve(out,runId+'.events.jsonl');
 check(!existsSync(lock),'operator_active');
 const row={purpose:mode==='rollback'?'catalog-forward-rollback-rehearsal':mode==='apply'?'catalog-forward-preserving-apply':'catalog-lock-admission-qualification',runId,pid,source},lockBytes=Buffer.from(JSON.stringify(row)+'\n');
 let journalBytes=Buffer.from(JSON.stringify({stage:'catalog_rollback_started',runId,at:new Date(now).toISOString(),source})+'\n');
 saveCatalogBytes(journal,journalBytes);saveCatalogBytes(lock,lockBytes);
 let live=true;const stages=['catalog_rollback_started'];const lockStat=lstatSync(lock),journalStat=lstatSync(journal);
 const verify=()=>{guard.verify();check(live&&lstatSync(lock).ino===lockStat.ino&&lstatSync(journal).ino===journalStat.ino
  &&boundedCatalogFile(lock,16384).equals(lockBytes)&&boundedCatalogFile(journal).equals(journalBytes),'custody_changed');};
 const record=(stage,details)=>{verify();
  check(details&&typeof details==='object'&&!Array.isArray(details)
   &&!['stage','runId','at','source'].some(k=>Object.prototype.hasOwnProperty.call(details,k)),'reserved_event_metadata');
  // A failed lock exercise may still admit exact fixture cleanup. That shorter
  // sequence cannot settle; only the full ordered success sequence can.
  const failedCleanup=mode!=='rollback'&&stage==='catalog_lock_cleanup_admitted'
   &&stages.includes('catalog_lock_fixture_admitted')&&!stages.includes(stage);
  check(stage==='catalog_rollback_finding'||stage===sequence[stages.length]||failedCleanup,'stage');
  const next=Buffer.from(JSON.stringify({stage,runId,at:new Date().toISOString(),...details})+'\n');
  check(journalBytes.length+next.length<4*1024*1024,'journal_bound');const fd=openSync(journal,'a');
  try{writeFileSync(fd,next);fsyncSync(fd);}finally{closeSync(fd);}journalBytes=Buffer.concat([journalBytes,next]);stages.push(stage);verify();};
 const settle=report=>{verify();check(report?.contract===(mode==='rollback'?'catalog-forward-custodied-rollback/1':mode==='apply'?'catalog-forward-custodied-apply/1':'catalog-forward-custodied-lock-admission/1')&&report.runId===runId
  &&(mode==='rollback'?report.rolledBack===true:
   ['realLockWaitObserved','competingCommitVerified','changedWitnessRefused','workersSettled','fixtureRemoved'].every(k=>report[k]===true))
  &&report.repeatedDatabaseReadbackVerified===true&&report.controlUnchanged===true
  &&report.sourceUnchanged===true&&report.journalSha256===sha256(journalBytes)
  &&JSON.stringify(report.operatorSource)===JSON.stringify(source)
  &&(mode==='apply'?report.rolledBack===true&&report.independentReadbackVerified===true&&report.lastingApplyPerformed===true
   :JSON.stringify(report.before)===JSON.stringify(report.after))&&report.before?.contract==='catalog-forward-upgrade/1'
  &&report.before.command==='inspect'&&report.before.referenceMigrationCount===2&&report.before.phiAllowed===false
  &&JSON.stringify(stages)===JSON.stringify(sequence)
  &&(mode==='apply'||report.lastingApplyPerformed===false)
  &&['apiDeploymentPerformed','canonicalRegistered','hostedAcceptance','activationApproved','phiAllowed'].every(k=>report[k]===false),'settlement');
  if(mode==='apply')verifyCatalogAppliedReadback(report.before,report.after,source);
  const durableEvents=journalBytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  check(JSON.stringify(durableEvents.map(event=>event.stage))===JSON.stringify(sequence)
   &&durableEvents.every(event=>event.runId===runId&&typeof event.at==='string'&&Number.isFinite(Date.parse(event.at)))
   &&JSON.stringify(durableEvents[0].source)===JSON.stringify(source),'durable_event_sequence');
  const receipt=resolve(out,runId+'.'+mode+'-'+sha256(JSON.stringify(report))+'.json');
  saveCatalogBytes(receipt,Buffer.from(JSON.stringify(report,null,2)+'\n'));
  saveCatalogBytes(resolve(out,runId+'.settled-lock.json'),lockBytes);verify();unlinkSync(lock);live=false;
  return {receipt,receiptBytesSha256:sha256(boundedCatalogFile(receipt)),custodySettled:true};};
 return {runId,lock,journal,verify,record,settle,journalSha256:()=>{verify();return sha256(journalBytes);}};
}
