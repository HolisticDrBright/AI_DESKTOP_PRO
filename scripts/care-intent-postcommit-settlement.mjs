/** Local custody retirement only after two fresh real reconciliations. It does
 * not certify the failed release, deletion, canonical registration or PHI. */
import {readFileSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {refuseIntent,careIntentCurrent} from './synthetic-care-intent-release.mjs';
import {CARE_INTENT_POSTCOMMIT as F,verifyCarePostcommitCustody,verifyCareIntentSuccessorInspector} from './care-intent-postcommit.mjs';
import {verifyCareIntentResumptionBindings} from './care-intent-resumption-deployment.mjs';
import {observeCareIntentPostcommit} from './reconcile-synthetic-care-intent.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('postcommit_retirement_'+code);};
const bounded=path=>{
 const stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=1024*1024,'file');
 const bytes=readFileSync(path);check(bytes.length===stat.size,'file_changed');return bytes;
};
const durable=(path,bytes)=>{
 const fd=openSync(path,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
};
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
function verifyFresh(r,current,started,now){
 check(r?.contract==='synthetic-care-intent-postcommit-reconciliation/1'&&r.execution==='synthetic-staging'&&r.account===P.account
  &&Number.isFinite(started)&&Number.isFinite(now)&&Date.parse(r.observedAt)>=started&&Date.parse(r.observedAt)<=now
  &&now-Date.parse(r.observedAt)<=120000&&canonical(r.operatorCurrent)===canonical(current)
  &&r.successorReconciled===true&&r.deploymentReconciled===true&&r.sourceQualified===true
  &&r.interruption?.runId===F.parentRunId&&r.interruption.previousProcessAbsent===true
  &&r.postcommitCustody?.runId===F.runId&&r.postcommitCustody.previousProcessAbsent===true
  &&r.postcommitCustody.lockSha256===F.lockSha256&&r.postcommitCustody.journalSha256===F.journalSha256
  &&r.interruption.lockSha256===F.parentLockSha256&&r.interruption.journalSha256===F.parentJournalSha256
  &&['custodySettled','custodyAcquired','awsMutationPerformed','compatibleRecoveryVerified','schemaChanged','canonicalRegistered',
   'hostedAcceptance','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted','replayAuthorized','currentRecoveryAcceptance'].every(k=>r[k]===false),'fresh_observation');
 verifyCareIntentSuccessorInspector(r.databaseBefore,current);verifyCareIntentSuccessorInspector(r.databaseAfter,current);
 check(canonical(r.databaseBefore)===canonical(r.databaseAfter),'database_changed');
 verifyCareIntentResumptionBindings(r.applicationCurrent,current);
 const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 check(hash(r.zipSha256)&&r.deployedDownloadSha256===r.zipSha256&&r.retainedDownloadSha256===r.zipSha256
  &&r.artifact?.sha256===r.zipSha256&&r.artifact.exactVersionReadbackVerified===true
  &&r.control?.routeCount===51&&r.control.iamVerified===true&&r.control.loggingVerified===true&&r.control.phiAllowed===false
  &&r.control.revision===r.revision&&r.transport?.revisionId===r.revision&&r.transport.policy===null
  &&['routesSha256','authorizersSha256','roleSha256','policySha256','stageSha256','integrationsSha256','templateSha256'].every(k=>hash(r.control[k]))
  &&['routesSha256','authorizersSha256','latestPolicySha256','otherIntegrationsSha256'].every(k=>hash(r.transport[k])),'complete_services');
 return r;
}
/** Only the real entry point below supplies live observations and real unlink.
 * Ports exist for fault testing; no CLI can supply an observation or report. */
export async function retireCareIntentPostcommitCustody(root,directory,d){
 const started=d.now(),before=await d.observe(),current=await d.current();verifyFresh(before,current,started,d.now());
 const paths={originalLock:resolve(root,'dist/synthetic-care-routing/operator.lock'),
  originalJournal:resolve(directory,'uploads',F.parentRunId+'.events.jsonl'),
  secondaryLock:resolve(root,'dist/synthetic-care-routing/operator.resume.lock'),
  secondaryJournal:resolve(directory,'resumptions',F.runId+'.events.jsonl')};
 check(before.interruption.lock===paths.originalLock&&before.interruption.journal===paths.originalJournal
  &&before.postcommitCustody.lock===paths.secondaryLock&&before.postcommitCustody.journal===paths.secondaryJournal,'paths');
 const hashes={originalLock:F.parentLockSha256,originalJournal:F.parentJournalSha256,secondaryLock:F.lockSha256,secondaryJournal:F.journalSha256};
 const bytes=Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,bounded(path)]));
 for(const key of Object.keys(paths))check(sha256(bytes[key])===hashes[key],'original_hash');
 verifyCarePostcommitCustody(bytes.secondaryLock,bytes.secondaryJournal,before.interruption,before.applicationCurrent);
 const runId=randomBytes(16).toString('hex'),out=resolve(directory,'resumptions',runId+'.postcommit-custody'),
  lock=resolve(root,'dist/synthetic-care-routing/operator.postcommit.lock');
 const owner=json({runId,pid:process.pid,purpose:'reconciled-postcommit-custody-retirement',
  parentRunId:F.parentRunId,secondaryRunId:F.runId,operatorCurrent:current});
 try{durable(lock,owner);}catch{refuseIntent('postcommit_retirement_exclusive');}
 let secondaryRetired=false,originalRetired=false,completed=false;
 const guard=async()=>{
  check(bounded(lock).equals(owner),'owner_changed');
  check(canonical(await d.current())===canonical(current),'source_changed');
  for(const key of Object.keys(paths))check(bounded(paths[key]).equals(bytes[key]),'custody_changed');
 };
 try{
  await guard();mkdirSync(out);durable(resolve(out,'before.json'),json(before));
  for(const key of Object.keys(paths))durable(resolve(out,key),bytes[key]);
  for(const key of Object.keys(paths))check(bounded(resolve(out,key)).equals(bytes[key]),'archive_changed');
  const after=await d.observe();verifyFresh(after,current,started,d.now());
  for(const key of ['applicationCurrent','operatorCurrent','zipSha256','deployedDownloadSha256','retainedDownloadSha256',
   'predecessorDownload','revision','retainedVersion','artifact','projections','control','transport','databaseBefore','databaseAfter','interruption','postcommitCustody'])
   check(canonical(after[key])===canonical(before[key]),'observation_changed');
  await guard();durable(resolve(out,'after.json'),json(after));
  for(const key of Object.keys(paths))check(bounded(resolve(out,key)).equals(bytes[key]),'archive_changed');
  // Preserve an admitted marker before either removal. Any incomplete removal
  // retains the third guard and exact archive; never auto-replay or restore it.
  durable(resolve(out,'retirement-admitted.json'),json({runId,hashes,releaseAcceptance:false,phiAllowed:false}));
  await guard();verifyFresh(after,current,started,d.now());d.remove(paths.secondaryLock);secondaryRetired=true;
  check(bounded(lock).equals(owner)&&bounded(paths.originalLock).equals(bytes.originalLock)
   &&bounded(paths.originalJournal).equals(bytes.originalJournal)&&bounded(paths.secondaryJournal).equals(bytes.secondaryJournal),'remaining_changed');
  d.remove(paths.originalLock);originalRetired=true;
  check(bounded(lock).equals(owner),'owner_changed');
  const result={contract:'synthetic-care-intent-postcommit-custody-retirement/1',runId,
   parentRunId:F.parentRunId,secondaryRunId:F.runId,operatorCurrent:current,archive:out,
   reconciledAt:after.observedAt,exactOriginalCustodyArchived:true,originalLockRetired:true,secondaryLockRetired:true,
   outcome:'reconciled_committed_successor_not_release_acceptance',awsMutationPerformed:false,schemaChanged:false,
   freshRoutingRecoveryVerified:false,originalReleaseAccepted:false,erasureAccepted:false,canonicalRegistered:false,
   physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false,reportIsNotAuthority:true};
  durable(resolve(out,'retirement.json'),json(result));d.remove(lock);completed=true;return result;
 }catch(e){
  // The marker is recoverable even if one local remove completed. Do not erase
  // archives, recreate original locks, or issue a success after an unknown result.
  try{durable(resolve(out,'finding.json'),json({runId,secondaryRetired,originalRetired,completed:false,
   code:'postcommit_retirement_incomplete',phiAllowed:false}));}catch{}
  throw e;
 }finally{if(!completed){/* Keep the exclusive postcommit guard for explicit recovery. */}}
}
export async function settleCareIntentPostcommit(root,mobileRoot,directory){
 return retireCareIntentPostcommitCustody(root,directory,{now:Date.now,
  current:async()=>careIntentCurrent(root,mobileRoot),
  observe:async()=>(await observeCareIntentPostcommit(root,mobileRoot,directory)).result,remove:unlinkSync});
}
