/** Read-only AWS settlement of a stopped combined upload/proposal operation.
 * No remote mutation, execution, deletion, schema replay or report override. */
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,assertCareRegisteredCurrent,readCareRegisteredCandidate,verifyCareRegisteredCandidate,
 inspectCareRegisteredArtifact,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {verifyCareRegisteredPredecessorControl,verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {careRegisteredCodeTemplateInputs,careRegisteredChangeSetBinding,
 verifyCareRegisteredUnexecutedProposalViews} from './care-registered-code-change.mjs';
import {acquireRegisteredUploadReconciliationGuard,stoppedUploadWriter,
 inspectRegisteredUploadObject} from './reconcile-synthetic-care-registered-upload.mjs';
import {REGISTERED_UPLOAD_TRANSPORT} from './upload-synthetic-care-registered-release.mjs';
import {buildCareRegisteredDatabaseObserver,readCareRegisteredPredecessor,registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {observeIntentControlRaw,downloadIntentFunction} from './care-intent-live.mjs';
import {collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {observeSyntheticMemberIdentity,assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('proposal_reconciliation_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const frozenCurrent=c=>Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,c.manifest[k]]));
const exact=(o,names)=>o&&typeof o==='object'&&!Array.isArray(o)&&equal(Object.keys(o).sort(),[...names].sort());
export function registeredProposalReconciliationArguments(a){
 check(a.length===7&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--application-root'
  &&a[6]==='--reconcile-fictional-registered-proposal-only'
  &&[a[1],a[3],a[5]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3]),applicationRoot:resolve(a[5])};
}
function bounded(file,max=1024*1024){
 const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'file');
 const bytes=readFileSync(file),b=lstatSync(file);
 check(a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&bytes.length===a.size,'file_changed');return bytes;
}
function directory(root,parts){let path=realpathSync(root);
 for(const part of parts){path=resolve(path,part);const s=lstatSync(path);check(s.isDirectory()&&!s.isSymbolicLink(),'directory');}return path;
}
/** Completed exact upload followed by a stopped proposal attempt. Earlier
 * upload failures and unknown/unavailable proposal shapes stay held. */
export function verifyFailedRegisteredProposalCustody(c,candidate,sourceText,now){
 const frozen=frozenCurrent(candidate);verifyCareRegisteredCandidate(candidate,frozen);
 check(Buffer.isBuffer(c?.lockBytes)&&c.lockBytes.length<=16384&&Buffer.isBuffer(c.journalBytes)
  &&c.journalBytes.length<=1024*1024&&c.journalBytes.at(-1)===10,'custody_bytes');
 let lock,events;try{lock=JSON.parse(c.lockBytes.toString('utf8'));
  events=c.journalBytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));}
 catch{refuseRegistered('proposal_reconciliation_custody_json');}
 check(exact(lock,['desktop','mobile','pid','purpose','runId'])&&lock.purpose==='registered-artifact-upload-proposal'
  &&/^[a-f0-9]{32}$/.test(lock.runId)&&Number.isSafeInteger(lock.pid)&&lock.pid>0
  &&equal(lock.desktop,frozen.desktop)&&equal(lock.mobile,frozen.mobile)
  &&c.lockBytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))
  &&c.journalBytes.equals(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')),'custody_binding');
 const stages=events.map(e=>e.stage);
 check(equal(stages,['registered_upload_started','registered_live_preflight_verified','registered_artifact_put_admitted',
  'registered_artifact_exact_version_verified','registered_change_set_create_admitted','registered_change_set_observed','registered_upload_finding']),
  'journal_scope');
 const fields=[['runId'],['observedAt'],['key','sha256'],['artifact'],['stackId','name','clientToken'],['id','name','reused'],['code','writeAdmitted']];
 for(let i=0;i<events.length;i++)check(exact(events[i],['at','stage',...fields[i]]),'journal_fields');
 check(events[0].runId===lock.runId&&events[2].key===candidate.manifest.key&&events[2].sha256===candidate.manifest.zipSha256
  &&events[6].writeAdmitted===true&&typeof events[6].code==='string'
  &&/^synthetic_care_registered_release_refused:[a-z0-9_]{1,180}$/.test(events[6].code),'journal_binding');
 let prior=-Infinity;
 for(const e of events){const time=Date.parse(e.at);check(Number.isFinite(time)&&time>=prior&&time<=now,'journal_time');prior=time;}
 check(Number.isFinite(now)&&now-prior>=60000&&Date.parse(events[1].observedAt)<=Date.parse(events[1].at)
  &&Date.parse(events[1].at)-Date.parse(events[1].observedAt)<=120000,'writer_settlement');
 const artifact=events[3].artifact,input=careRegisteredCodeTemplateInputs(sourceText,candidate,frozen,artifact),
  fixed=careRegisteredChangeSetBinding(input,frozen,artifact),admission=events[4],observed=events[5];
 check(artifact.reused===false&&admission.stackId===fixed.stackId&&admission.name===fixed.name&&admission.clientToken===fixed.digest
  &&observed.name===fixed.name&&observed.reused===false&&typeof observed.id==='string'
  &&new RegExp('^arn:aws:cloudformation:'+P.region+':'+P.account+':changeSet/'+fixed.name+'/[A-Za-z0-9-]{1,128}$').test(observed.id),
  'proposal_admission');
 return {lock,events,frozen,artifact,input,binding:{...fixed,id:observed.id},journalSha256:sha256(c.journalBytes),
  originalFailure:events[6].code};
}
/** Pure orchestration with credential-free seams. CLI binds every seam to its
 * own current source/process/S3/CloudFormation/database observations. */
export async function runRegisteredProposalReconciliation(candidate,operator,custody,sourceText,port){
 assertCareRegisteredCurrent(operator);const started=port.now(),failed=verifyFailedRegisteredProposalCustody(custody,candidate,sourceText,started);
 check(equal(operator.mobile,failed.frozen.mobile)&&equal(operator.migrations,failed.frozen.migrations)
  &&operator.templateSha256===failed.frozen.templateSha256,'operator_binding');
 const caller=await port.identity();assertSyntheticMemberIdentity(caller);
 const guard=async()=>{
  check(equal(await port.current(),operator)&&equal(await port.applicationCurrent(),failed.frozen),'source_changed');
  check(await port.writerStopped(failed.lock.pid)===true,'writer_active');
  const copy=await port.custody();check(copy.lockBytes.equals(custody.lockBytes)&&copy.journalBytes.equals(custody.journalBytes),'custody_changed');
  const next=await port.identity();assertSyntheticMemberIdentity(next);check(equal(next,caller),'principal_changed');
 };
 await guard();const rebuilt=await port.rebuild();
 check(rebuilt?.byteVerified===true&&rebuilt.sourceRebuilt===true&&rebuilt.zipSha256===candidate.manifest.zipSha256
  &&rebuilt.desktopCommit===failed.frozen.desktop.commit&&rebuilt.mobileCommit===failed.frozen.mobile.source.commit
  &&rebuilt.liveTargetObserved===false&&rebuilt.deployed===false&&rebuilt.phiAllowed===false,'independent_rebuild');
 await guard();const firstDatabase=verifyCareRegisteredDatabase(await port.database(),operator,started,port.now());
 const raw=await port.control(),control=verifyCareRegisteredPredecessorControl(raw,JSON.parse(sourceText));await guard();
 const predecessorDownload=await port.predecessor(raw.fn);
 check(predecessorDownload?.sha256===candidate.release.predecessor.zipSha256
  &&predecessorDownload.bytes===candidate.release.predecessor.bytes&&predecessorDownload.exactBytesVerified===true,'predecessor_bytes');
 await guard();
 const observe=async()=>{
  const storage=await port.storage();check(storage?.state==='stored_exact_version'&&storage.bytesVerified===true
   &&storage.versionId===failed.artifact.versionId&&storage.sha256===candidate.manifest.zipSha256
   &&storage.bytes===candidate.manifest.zipBytes&&storage.deletionCertified===false,'storage_binding');
  const observed=await port.proposal(failed.binding),list=observed?.listing;
  check(Array.isArray(list?.Summaries)&&list.Summaries.length<=2000&&!list.NextToken
   &&list.Summaries.every(s=>typeof s.ChangeSetName==='string'&&typeof s.ChangeSetId==='string')
   &&new Set(list.Summaries.map(s=>s.ChangeSetId)).size===list.Summaries.length,'proposal_listing');
  const matches=list.Summaries.filter(s=>s.ChangeSetName===failed.binding.name);
  check(matches.length===1&&matches[0].ChangeSetId===failed.binding.id,'proposal_identity');
  const currentRaw=await port.control();
  const projection=verifyCareRegisteredUnexecutedProposalViews(observed.summary,observed.detailed,observed.template,
   failed.input,failed.binding,currentRaw,sourceText,control,failed.frozen,candidate,failed.artifact,port.now());
  await guard();return {storage,projection,listingSha256:sha256(canonical(list))};
 };
 const first=await observe(),second=await observe();check(equal(first,second),'observation_changed');
 const secondDatabase=verifyCareRegisteredDatabase(await port.database(),operator,started,port.now()),comparable=r=>{
  const copy=structuredClone(r);delete copy.observedAt;return copy;
 };
 check(equal(comparable(firstDatabase),comparable(secondDatabase)),'database_changed');
 verifyCareRegisteredDatabase(firstDatabase,operator,started,port.now());
 check(equal(verifyCareRegisteredPredecessorControl(await port.control(),JSON.parse(sourceText)),control),'control_changed');await guard();
 return {contract:'synthetic-care-registered-proposal-reconciliation/1',observedAt:new Date(port.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,runId:failed.lock.runId,applicationSource:failed.frozen,
  applicationSourceRebuilt:true,operatorSource:operator,journalSha256:failed.journalSha256,originalRunOutcome:'failed',
  originalFailure:failed.originalFailure,storage:first.storage,proposal:first.projection,listingSha256:first.listingSha256,
  predecessorControl:control,predecessorDownload,databaseBefore:firstDatabase,databaseAfter:secondDatabase,writerStopped:true,
  repeatedStorageReadback:true,repeatedProposalReadback:true,databasePreserved:true,reportIsNotAuthority:true,
  originalPutOutcome:'recorded_verified',originalProposalOutcome:'observed_unexecuted',retryPerformed:false,
  executionAdmissible:false,awsMutationPerformed:false,deletionCertified:false,deployed:false,schemaChanged:false,
  hostedAcceptance:false,releaseAccepted:false,phiAllowed:false,paidMobileBuildStarted:false};
}
function save(file,bytes){let fd;
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}catch(e){if(e?.code!=='EEXIST')throw e;}
 finally{if(fd!==undefined)closeSync(fd);}check(bounded(file,4*1024*1024).equals(bytes),'archive_readback');
}
export function archiveReconciledProposalLock(custody,report){
 check(report.contract==='synthetic-care-registered-proposal-reconciliation/1'
  &&report.runId===JSON.parse(custody.lockBytes.toString('utf8')).runId&&report.writerStopped===true
  &&report.applicationSourceRebuilt===true&&report.repeatedStorageReadback===true&&report.repeatedProposalReadback===true
  &&report.databasePreserved===true&&report.originalRunOutcome==='failed'&&report.reportIsNotAuthority===true
  &&report.executionAdmissible===false&&report.awsMutationPerformed===false&&report.deletionCertified===false&&report.deployed===false,
  'archive_report');
 check(custody.guard&&Buffer.isBuffer(custody.guard.bytes),'guard_required');custody.guard.verify();
 const unchanged=()=>check(bounded(custody.lock).equals(custody.lockBytes)&&bounded(custody.journal).equals(custody.journalBytes),'custody_changed');
 unchanged();const archive=resolve(custody.out,report.runId+'.proposal-settled-lock.json'),receipt=resolve(custody.out,
  report.runId+'.proposal-reconciliation-'+sha256(canonical(report))+'.json');
 save(archive,custody.lockBytes);save(receipt,Buffer.from(JSON.stringify(report,null,2)+'\n'));
 unchanged();custody.guard.verify();unlinkSync(custody.lock);return {archive,receipt,operatorCustodySettled:true};
}
function aws(args){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}}));}
 catch{refuseRegistered('proposal_reconciliation_aws_unconfirmed');}
}
export async function reconcileRegisteredProposal(root,mobileRoot,artifactDirectory,applicationRoot){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 const operator=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(artifactDirectory),frozen=frozenCurrent(candidate);
 verifyCareRegisteredCandidate(candidate,frozen);
 check(equal(careRegisteredCurrent(applicationRoot,mobileRoot),frozen),'application_source');observeSyntheticMemberIdentity();
 const shared=directory(root,['dist','synthetic-care-routing']),guard=acquireRegisteredUploadReconciliationGuard(shared,operator);
 let client;
 try{
  const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),id=JSON.parse(lockBytes.toString('utf8')).runId;
  check(/^[a-f0-9]{32}$/.test(id),'run_id');
  const out=directory(root,['dist','synthetic-care-registered-operations',frozen.desktop.commit,frozen.mobile.source.commit,candidate.manifest.zipSha256]),
   journal=resolve(out,id+'.events.jsonl'),journalBytes=bounded(journal),custody={lock,lockBytes,journal,journalBytes,out,guard},
   sourceText=normalizedText(applicationRoot,'infra/aws-clinical-core/identity-api-extension.json');
  verifyFailedRegisteredProposalCustody(custody,candidate,sourceText,Date.now());
  const database=buildCareRegisteredDatabaseObserver(root,operator),predecessor=readCareRegisteredPredecessor(root);
  client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
  const unchangedArtifact=()=>{const c=readCareRegisteredCandidate(artifactDirectory);
   check(['zip','bundle','releaseBytes','manifestBytes'].every(k=>c[k].equals(candidate[k])),'artifact_changed');};
  const report=await runRegisteredProposalReconciliation(candidate,operator,custody,sourceText,{
   now:Date.now,current:async()=>{unchangedArtifact();return careRegisteredCurrent(root,mobileRoot);},
   applicationCurrent:async()=>careRegisteredCurrent(applicationRoot,mobileRoot),
   identity:async()=>observeSyntheticMemberIdentity(),writerStopped:async pid=>stoppedUploadWriter(pid),
   custody:async()=>{guard.verify();return {lockBytes:bounded(lock,16384),journalBytes:bounded(journal)};},
   rebuild:()=>inspectCareRegisteredArtifact(applicationRoot,mobileRoot,artifactDirectory),database,
   control:async()=>observeIntentControlRaw(),
   predecessor:async fn=>{const bytes=await downloadIntentFunction(fn,predecessor);
    return {sha256:sha256(bytes),bytes:bytes.length,exactBytesVerified:bytes.equals(predecessor.zip)};},
   storage:()=>inspectRegisteredUploadObject(candidate,(c,options={})=>client.send(c,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)})),
   proposal:async binding=>({listing:collectCancellationInventory(aws,['cloudformation','list-change-sets','--stack-name',binding.stackId],'Summaries','NextToken'),
    summary:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--no-include-property-values','--no-paginate']),
    detailed:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--include-property-values','--no-paginate']),
    template:(()=>{const t=aws(['cloudformation','get-template','--stack-name',binding.stackId,'--change-set-name',binding.id,'--template-stage','Original']).TemplateBody;
     return typeof t==='string'?JSON.parse(t):t;})()}),
  });
  unchangedArtifact();check(stoppedUploadWriter(JSON.parse(lockBytes.toString('utf8')).pid),'writer_active');
  check(equal(careRegisteredCurrent(root,mobileRoot),operator)&&equal(careRegisteredCurrent(applicationRoot,mobileRoot),frozen),'source_changed');
  return {...report,...archiveReconciledProposalLock(custody,report)};
 }finally{client?.destroy();guard.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>registeredProposalReconciliationArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory,applicationRoot})=>reconcileRegisteredProposal(process.cwd(),mobileRoot,directory,applicationRoot))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
