/** Fixed fictional target only. A fresh rehearsal cannot replay a release.
 * Stopped custody exposes only return-to-LATEST/exact-permission removal;
 * completed custody gets read-only observations. No report-loading option. */
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,lstatSync,realpathSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage} from './care-recovery-routing.mjs';
import {careRegisteredCurrent,readCareRegisteredCandidate,verifyCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {acquireRecoverableRegisteredInspectionGuard} from './care-registered-restoration-guard.mjs';
import {verifyInterruptedRegisteredReleaseCustody,createRegisteredRestorationObservers,registeredReleaseDirectory,
 readRegisteredReleaseEvidence,readRegisteredReleaseBounded as bounded} from './reconcile-synthetic-care-registered-release.mjs';
import {verifyRegisteredStandaloneLock,verifyRegisteredStandaloneCustody} from './care-registered-standalone-custody.mjs';
import {runRegisteredStandaloneRehearsal} from './care-registered-standalone.mjs';
import {runRegisteredStandaloneRestoration} from './care-registered-standalone-restoration.mjs';
import {compileRegisteredIntentParser,runCareRegisteredLiveRecovery} from './care-registered-routing-live.mjs';
import {stoppedUploadWriter} from './reconcile-synthetic-care-registered-upload.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('standalone_live_'+c);};
const equal=(a,b)=>canonical(a)===canonical(b);
const fixedEndpoint=()=>check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
export function registeredStandaloneArguments(a){
 check(a.length===9&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--application-root'&&a[6]==='--original-run'
  &&[a[1],a[3],a[5]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--'))&&/^[a-f0-9]{32}$/.test(a[7]??'')
  &&['--rehearse-fictional-registered-only','--restore-stopped-fictional-standalone-only'].includes(a[8]),'arguments');
 return {mobileRoot:resolve(a[1]),artifactDirectory:resolve(a[3]),applicationRoot:resolve(a[5]),originalRunId:a[7],
  restore:a[8]==='--restore-stopped-fictional-standalone-only'};
}
function aws(args){
 fixedEndpoint();observeSyntheticMemberIdentity();
 try{const text=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return text.trim()?JSON.parse(text):{};
 }catch{refuseRegistered('standalone_live_aws_unconfirmed');}
}
function ensureDirectory(root,parts){
 let file=realpathSync(root);for(const part of parts){check(/^[a-zA-Z0-9_-]{1,128}$/.test(part),'directory_part');file=resolve(file,part);
  try{mkdirSync(file,{mode:0o700});}catch(e){if(e?.code!=='EEXIST')throw e;}
  const stat=lstatSync(file);check(stat.isDirectory()&&!stat.isSymbolicLink(),'directory');}return file;
}
function save(file,bytes){
 let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}catch(e){if(e?.code!=='EEXIST')throw e;}
 finally{if(fd!==undefined)closeSync(fd);}check(bounded(file,4*1024*1024).equals(bytes),'save_readback');
}
export function readStandaloneEvidence(out,file,kind){
 check(['standalone-before','standalone-completed'].includes(kind)&&typeof file==='string'&&resolve(file)===resolve(out,basename(file))
  &&new RegExp('^'+kind+'-[a-f0-9]{64}\\.json$').test(basename(file)),'evidence_path');
 const bytes=bounded(file,4*1024*1024);check(basename(file)===kind+'-'+sha256(bytes)+'.json','evidence_digest');return bytes;
}
/** Seed the journal before acquiring the shared operator lock. A process loss
 * after the lock exists therefore always has a parseable admission-free prefix.
 * An earlier loss leaves only a local orphan seed, never AWS authority. */
export function createStandaloneCustody(shared,out,current,operator,origin,guard,now,pid=process.pid){
 check([shared,out].every(file=>lstatSync(file).isDirectory()&&!lstatSync(file).isSymbolicLink()),'custody_directory');
 check(Number.isFinite(now)&&Number.isSafeInteger(pid)&&pid>0,'creation_identity');guard.verify();
 const runId=randomBytes(16).toString('hex'),lock=resolve(shared,'operator.lock'),journal=resolve(out,runId+'.events.jsonl'),
  lockRow={purpose:'registered-standalone-routing-rehearsal',pid,runId,applicationSource:current,operatorSource:operator,original:origin},
  lockBytes=Buffer.from(JSON.stringify(lockRow)+'\n'),initialEvent={at:new Date(now).toISOString(),stage:'registered_standalone_started',
   runId,originalRunId:origin.runId,originalLockSha256:origin.lockSha256,originalJournalSha256:origin.journalSha256};
 verifyRegisteredStandaloneLock(lockBytes,current,operator,origin);
 check(!existsSync(lock),'operator_active');let fd;
 try{fd=openSync(journal,'wx',0o600);writeFileSync(fd,JSON.stringify(initialEvent)+'\n');fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
 fd=undefined;try{fd=openSync(lock,'wx',0o600);writeFileSync(fd,lockBytes);fsyncSync(fd);}catch(e){if(e?.code==='EEXIST')refuseRegistered('standalone_live_operator_active');throw e;}
 finally{if(fd!==undefined)closeSync(fd);}
 const lockStat=lstatSync(lock),journalStat=lstatSync(journal);let journalBytes=bounded(journal,1024*1024),live=true;
 const c={lock,lockBytes,journal,journalBytes:Buffer.from(journalBytes),out,guard,initialEvent,current,operator,origin};
 const verifyCreated=()=>{guard.verify();check(live&&lstatSync(lock).ino===lockStat.ino&&lstatSync(journal).ino===journalStat.ino
  &&bounded(lock,16384).equals(lockBytes)&&bounded(journal,1024*1024).equals(journalBytes),'created_custody_changed');};
 return {c,verifyCreated,verifyLocal:expected=>{verifyCreated();check(expected.equals(journalBytes),'journal_changed');},
  custody:()=>{verifyCreated();return {lockBytes:bounded(lock,16384),journalBytes:bounded(journal,1024*1024)};},
  record:e=>{verifyCreated();const next=Buffer.concat([journalBytes,Buffer.from(JSON.stringify(e)+'\n')]);check(next.length<=1024*1024,'journal_bound');
   const fd=openSync(journal,'a');try{writeFileSync(fd,JSON.stringify(e)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
   check(bounded(journal,1024*1024).equals(next),'journal_readback');journalBytes=next;verifyCreated();return Buffer.from(journalBytes);},
  retired:()=>{live=false;}};
}
export function settleStandaloneCustody(c,report,mode){
 check(['rehearsal','restoration'].includes(mode),'settlement_mode');const own=JSON.parse(c.lockBytes);
 check(report.runId===own.runId&&equal(report.applicationSource,c.current)&&equal(report.operatorSource,c.operator)&&equal(report.original,c.origin)
  &&report.journalSha256===sha256(bounded(c.journal,1024*1024))&&report.reportIsNotAuthority===true
  &&report.repeatedReadbackVerified===true&&report.exactBytesVerified===true&&report.databasePreserved===true
  &&report.routeRestoredAtObservation===true&&report.temporaryPermissionAbsentAtObservation===true
  &&['schemaChanged','hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].every(k=>report[k]===false),'settlement_report');
 if(mode==='rehearsal')check(report.contract==='synthetic-care-registered-standalone-rehearsal/1'&&report.sourceRebuilt===true
  &&report.recoveryRehearsed===true&&report.proposalExecuted===false&&report.codeUpdated===false&&report.originalResultPreserved===true,'settlement_rehearsal');
 else check(report.contract==='synthetic-care-registered-standalone-restoration/1'&&report.writerStopped===true&&report.applicationSourceRebuilt===true
  &&report.restorationVerified===true&&report.recoveryRehearsed===false&&report.originalReleaseResultPreserved===true&&report.standaloneOutcomePreserved===true,'settlement_restoration');
 const unchanged=()=>{c.guard.verify();check(bounded(c.lock,16384).equals(c.lockBytes)
  &&sha256(bounded(c.journal,1024*1024))===report.journalSha256,'settlement_custody_changed');};unchanged();
 const archive=resolve(c.out,own.runId+'.standalone-settled-lock.json'),receipt=resolve(c.out,own.runId+'.standalone-'+mode+'-'+sha256(canonical(report))+'.json');
 save(archive,c.lockBytes);save(receipt,Buffer.from(JSON.stringify(report,null,2)+'\n'));unchanged();unlinkSync(c.lock);
 return {archive,receipt,operatorCustodySettled:true};
}
export async function rehearseRegisteredStandaloneLive(root,mobileRoot,artifactDirectory,applicationRoot,originalRunId,restore=false){
 fixedEndpoint();
 check(/^[a-f0-9]{32}$/.test(originalRunId),'original_run');
 const operator=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(artifactDirectory),
  current=Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,candidate.manifest[k]]));
 verifyCareRegisteredCandidate(candidate,current);check(equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'application_source');observeSyntheticMemberIdentity();
 const sourceText=normalizedText(applicationRoot,'infra/aws-clinical-core/identity-api-extension.json'),
  shared=registeredReleaseDirectory(root,['dist','synthetic-care-routing']),guard=await acquireRecoverableRegisteredInspectionGuard(shared,operator);let observers,owned;
 try{
  const originalOut=registeredReleaseDirectory(root,['dist','synthetic-care-registered-operations',current.desktop.commit,current.mobile.source.commit,candidate.manifest.zipSha256]),
   archiveFiles=['.release-settled-lock.json','.restored-lock.json'].map(suffix=>resolve(originalOut,originalRunId+suffix)).filter(existsSync);
  check(archiveFiles.length===1,'original_archive_ambiguous');
  const originalLock=archiveFiles[0],originalJournal=resolve(originalOut,originalRunId+'.events.jsonl'),originalContext={
   lock:originalLock,lockBytes:bounded(originalLock,16384),journal:originalJournal,journalBytes:bounded(originalJournal,1024*1024),out:originalOut,guard},
   originalEvidence=async(file,kind)=>readRegisteredReleaseEvidence(originalOut,candidate,file,kind),
   original=await verifyInterruptedRegisteredReleaseCustody(originalContext,candidate,sourceText,Date.now(),originalEvidence),
   origin={runId:originalRunId,lockSha256:sha256(originalContext.lockBytes),journalSha256:sha256(originalContext.journalBytes)};
  check(original.lock.runId===originalRunId&&original.scope==='execution'&&!original.events.some(e=>e.stage==='registered_upload_completed'),'original_execution');
  const out=ensureDirectory(root,['dist','synthetic-care-standalone-operations',current.desktop.commit,current.mobile.source.commit,candidate.manifest.zipSha256]);
  let c;
  if(restore){
   const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),row=JSON.parse(lockBytes);verifyRegisteredStandaloneLock(lockBytes,current,row.operatorSource,origin);
   const journal=resolve(out,row.runId+'.events.jsonl');c={lock,lockBytes,journal,journalBytes:bounded(journal,1024*1024),out,guard,current,operator,origin};
   await verifyRegisteredStandaloneCustody(c,current,row.operatorSource,origin,Date.now(),async(file,kind)=>readStandaloneEvidence(out,file,kind),{restorationOperator:operator});
  }else{check(!existsSync(resolve(shared,'operator.lock')),'operator_active');owned=createStandaloneCustody(shared,out,current,operator,origin,guard,Date.now());c=owned.c;}
  observers=createRegisteredRestorationObservers(root,mobileRoot,artifactDirectory,applicationRoot,candidate,operator,originalContext);
  const originalCustody=async()=>{guard.verify();return {lockBytes:bounded(originalLock,16384),journalBytes:bounded(originalJournal,1024*1024)};},
   sourceGuard=()=>{fixedEndpoint();guard.verify();check(equal(careRegisteredCurrent(root,mobileRoot),operator)&&equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'source_changed');
    const fresh=readCareRegisteredCandidate(artifactDirectory);check(['zip','bundle','manifestBytes','releaseBytes'].every(k=>fresh[k].equals(candidate[k])),'artifact_changed');
    check(bounded(originalLock,16384).equals(originalContext.lockBytes)&&bounded(originalJournal,1024*1024).equals(originalContext.journalBytes),'original_changed');observeSyntheticMemberIdentity();},
   evidence=async(file,kind)=>readStandaloneEvidence(out,file,kind),parseIntent=await compileRegisteredIntentParser(applicationRoot);
  let stoppedJournal=Buffer.from(c.journalBytes);
  const ports={...observers.port,pid:process.pid,originalCustody,originalEvidence,evidence,parseIntent,
   custody:async()=>{sourceGuard();return owned?owned.custody():{lockBytes:bounded(c.lock,16384),journalBytes:bounded(c.journal,1024*1024)};},
   record:async e=>{sourceGuard();if(owned)return owned.record(e);check(bounded(c.lock,16384).equals(c.lockBytes)&&bounded(c.journal,1024*1024).equals(stoppedJournal),'custody_changed');
    const next=Buffer.concat([stoppedJournal,Buffer.from(JSON.stringify(e)+'\n')]);check(next.length<=1024*1024,'journal_bound');
    const fd=openSync(c.journal,'a');try{writeFileSync(fd,JSON.stringify(e)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    check(bounded(c.journal,1024*1024).equals(next),'journal_readback');stoppedJournal=next;return Buffer.from(next);},
   save:async(kind,bytes)=>{sourceGuard();check(['standalone-before','standalone-completed'].includes(kind),'archive_kind');
    const file=resolve(out,kind+'-'+sha256(bytes)+'.json');save(file,bytes);return file;},
   verifyCreatedCustody:()=>{sourceGuard();check(owned,'new_custody_required');owned.verifyCreated();},
   verifyLocal:bytes=>{sourceGuard();owned.verifyLocal(bytes);},
   recovery:(input,custody)=>runCareRegisteredLiveRecovery(applicationRoot,mobileRoot,input,custody,root),
   returnLatest:async()=>{sourceGuard();return aws(['apigatewayv2','update-integration','--api-id',P.apiId,'--integration-id',R.integrationId,'--integration-uri',R.latestArn]);},
   removePermission:async(sid,revision)=>{sourceGuard();check(/^alp-care-intent-recovery-[a-f0-9]{32}$/.test(sid),'sid');
    return aws(['lambda','remove-permission','--function-name',P.functionName,'--qualifier','2','--statement-id',sid,'--revision-id',revision]);},
   waitLatest:async previous=>{const deadline=Date.now()+180000;while(Date.now()<deadline){sourceGuard();
    const integration=aws(['apigatewayv2','get-integration','--api-id',P.apiId,'--integration-id',R.integrationId]);
    check([R.latestArn,R.latestArn+':2'].includes(integration.IntegrationUri),'foreign_routing');
    if(integration.IntegrationUri===R.latestArn){verifyRecoveryIntegration(integration,R.latestArn);const stage=aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']);
     if(stage.DeploymentId!==previous){verifyRecoveryStage(stage);const deployed=await observers.port.apiDeployment(stage.DeploymentId);
      if(deployed.DeploymentId===stage.DeploymentId&&deployed.DeploymentStatus==='DEPLOYED')return;}}
    await new Promise(done=>setTimeout(done,2000));}refuseRegistered('standalone_live_return_unconfirmed');},
  };
  const report=restore?await runRegisteredStandaloneRestoration(candidate,operator,c,sourceText,ports)
   :await runRegisteredStandaloneRehearsal(candidate,operator,c,sourceText,ports);
  sourceGuard();owned?.verifyLocal(bounded(c.journal,1024*1024));
  if(restore)check(stoppedUploadWriter(JSON.parse(c.lockBytes).pid),'writer_active');
  const settlement=settleStandaloneCustody(c,report,restore?'restoration':'rehearsal');owned?.retired();return {...report,...settlement};
 }finally{observers?.close();await guard.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>registeredStandaloneArguments(process.argv.slice(2)))
  .then(a=>rehearseRegisteredStandaloneLive(process.cwd(),a.mobileRoot,a.artifactDirectory,a.applicationRoot,a.originalRunId,a.restore))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
