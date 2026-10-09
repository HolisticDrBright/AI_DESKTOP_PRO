/** Read-only remote reconciliation. Only an exact stopped-writer local lock is
 * archived/retired. No remote upload, delete, deployment or retry port exists. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,lstatSync} from 'node:fs';
import {S3Client} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,assertCareRegisteredCurrent,readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCatalogRuntimeCandidate} from './synthetic-catalog-runtime-release.mjs';
import {verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
import {catalogRuntimeInspectArguments,catalogRuntimeObservationEnvironment} from './inspect-synthetic-catalog-runtime-release.mjs';
import {verifyCatalogRuntimeCustodyRoot,verifyCatalogRuntimeCustodyLocation,catalogRuntimeOperationDirectory,
 verifyCatalogRuntimeSharedLocks} from './catalog-runtime-upload.mjs';
import {acquireRegisteredUploadReconciliationGuard,stoppedUploadWriter,inspectRegisteredUploadObject,
 archiveReconciledUploadLock} from './reconcile-synthetic-care-registered-upload.mjs';
import {REGISTERED_UPLOAD_TRANSPORT} from './upload-synthetic-care-registered-release.mjs';
import {registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {observeIntentControlRaw} from './care-intent-live.mjs';
import {assertSyntheticMemberIdentity,observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_reconciliation_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
export function catalogRuntimeUploadReconciliationArguments(args){
 check(args[10]==='--reconcile-fictional-catalog-runtime-upload-only','arguments');
 const inspect=[...args];inspect[10]='--inspect-fictional-catalog-runtime-only';return catalogRuntimeInspectArguments(inspect);
}
const frozenCurrent=candidate=>Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,structuredClone(candidate.manifest[k])]));
function bounded(file,max){
 const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'custody_file');
 const bytes=readFileSync(file),b=lstatSync(file);
 check(b.isFile()&&!b.isSymbolicLink()&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ino===b.ino&&bytes.length===a.size,'custody_changed');return bytes;
}
export function verifyFailedCatalogRuntimeUploadCustody(c,candidate,now){
 const frozen=frozenCurrent(candidate);verifyCatalogRuntimeCandidate(candidate,frozen);
 check(Buffer.isBuffer(c?.lockBytes)&&c.lockBytes.length>0&&c.lockBytes.length<=16384
  &&Buffer.isBuffer(c.journalBytes)&&c.journalBytes.length>0&&c.journalBytes.length<=1024*1024&&c.journalBytes.at(-1)===10,'custody_bytes');
 let lock,events;try{lock=JSON.parse(c.lockBytes.toString('utf8'));events=c.journalBytes.toString('utf8').trimEnd().split('\n').map(s=>JSON.parse(s));}
 catch{refuseRegistered('catalog_runtime_reconciliation_custody_json');}
 check(c.lockBytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))
  &&equal(Object.keys(lock).sort(),['desktop','mobile','pid','purpose','runId'])
  &&c.journalBytes.equals(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')),'custody_encoding');
 check(lock.purpose==='catalog-runtime-artifact-upload'&&/^[a-f0-9]{32}$/.test(lock.runId)
  &&Number.isSafeInteger(lock.pid)&&lock.pid>0&&equal(lock.desktop,frozen.desktop)&&equal(lock.mobile,frozen.mobile),'custody_binding');
 const stages=events.map(e=>e.stage),known=['catalog_runtime_upload_started','catalog_runtime_live_preflight_verified',
  'catalog_runtime_artifact_put_admitted','catalog_runtime_artifact_exact_version_verified','catalog_runtime_upload_completed','catalog_runtime_upload_finding'];
 // A process crash can leave no terminal finding. Admit only an exact prefix
 // after PUT admission, never manufacture a completion event for the writer.
 const suffix=stages.slice(3);
 check(events.length>=3&&events.length<=6&&stages.every(s=>known.includes(s))&&new Set(stages).size===stages.length
  &&stages[0]===known[0]&&events[0].runId===lock.runId&&stages[1]===known[1]&&stages[2]===known[2]
  &&[[],[known[3]],[known[4]],[known[5]],[known[3],known[4]],[known[3],known[5]],
   [known[3],known[4],known[5]]].some(s=>equal(s,suffix)),'journal_scope');
 if(stages.at(-1)===known[5])check(events.at(-1).writeAdmitted===true,'admitted_finding');
 if(stages.includes(known[4]))check(stages.indexOf(known[3])===3&&stages.indexOf(known[4])===4,'journal_scope');
 check(events[2].key===candidate.manifest.key&&events[2].sha256===candidate.manifest.zipSha256,'admission_binding');
 let previous=-Infinity;for(const e of events){const t=Date.parse(e.at);check(Number.isFinite(t)&&t>=previous&&t<=now,'journal_time');previous=t;}
 check(Number.isFinite(now)&&now-previous>=60000,'writer_settlement');
 return {frozen,lock,events,journalSha256:sha256(c.journalBytes)};
}
export async function runCatalogRuntimeUploadReconciliation(suppliedCandidate,operator,suppliedCustody,port){
 const candidate=structuredClone(suppliedCandidate);
 for(const field of ['bundle','zip','releaseBytes','manifestBytes'])candidate[field]=Buffer.from(candidate[field]);
 assertCareRegisteredCurrent(operator);
 const custody={...suppliedCustody,lockBytes:Buffer.from(suppliedCustody.lockBytes),journalBytes:Buffer.from(suppliedCustody.journalBytes)},
  failed=verifyFailedCatalogRuntimeUploadCustody(custody,candidate,port.now()),current=structuredClone(operator);
 check(equal(current.mobile,failed.frozen.mobile)&&equal(current.migrations,failed.frozen.migrations)
  &&current.templateSha256===failed.frozen.templateSha256,'operator_binding');
 const caller=structuredClone(await port.identity());assertSyntheticMemberIdentity(caller);
 const guard=async()=>{
  check(equal(await port.current(),current),'operator_changed');check(await port.writerStopped(failed.lock.pid)===true,'writer_active');
  const read=await port.custody();check(read.lockBytes.equals(custody.lockBytes)&&read.journalBytes.equals(custody.journalBytes),'custody_changed');
  const next=await port.identity();assertSyntheticMemberIdentity(next);check(equal(next,caller),'principal_changed');
 };
 await guard();const control=structuredClone(await port.control());await guard();
 const first=structuredClone(await port.storage());await guard();
 check(equal(await port.control(),control),'control_changed');await guard();
 const second=await port.storage();check(equal(first,second),'storage_changed');
 check(first.originalPutOutcome==='unknown'&&first.deletionCertified===false
  &&(first.state==='absent_at_observation'?first.versionId===null&&first.bytesVerified===false:
   first.state==='stored_exact_version'&&first.bytesVerified===true&&first.sha256===candidate.manifest.zipSha256
    &&first.bytes===candidate.zip.length&&typeof first.versionId==='string'&&first.versionId.length>0),'storage');
 check(equal(await port.control(),control),'control_changed');await guard();
 return {contract:'synthetic-catalog-runtime-upload-reconciliation/1',observedAt:new Date(port.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,runId:failed.lock.runId,
  applicationSource:failed.frozen,applicationSourceRebuilt:false,operatorSource:current,journalSha256:failed.journalSha256,
  storage:first,writerStopped:true,repeatedStorageReadback:true,predecessorControl:control,originalPutOutcome:'unknown',
  retryPerformed:false,awsMutationPerformed:false,deployed:false,schemaChanged:false,hostedAcceptance:false,
  releaseAccepted:false,reportIsNotAuthority:true,phiAllowed:false,paidMobileBuildStarted:false};
}
export async function reconcileCatalogRuntimeUpload(root,options){
 const {mobileRoot,directory,custodyRoot}=options;catalogRuntimeObservationEnvironment(process.env);
 process.env.AWS_MAX_ATTEMPTS='1';process.env.AWS_RETRY_MODE='standard';process.env.AWS_PAGER='';
 const operator=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory),frozen=frozenCurrent(candidate);
 verifyCatalogRuntimeCandidate(candidate,frozen);verifyCatalogRuntimeCustodyRoot(root,custodyRoot);observeSyntheticMemberIdentity();
 const shared=resolve(custodyRoot,'dist/synthetic-care-routing');verifyCatalogRuntimeSharedLocks(custodyRoot,true);
 const guard=acquireRegisteredUploadReconciliationGuard(shared,operator);let client;
 try{
  const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),saved=JSON.parse(lockBytes.toString('utf8'));
  check(/^[a-f0-9]{32}$/.test(saved.runId),'run_id');
  const out=catalogRuntimeOperationDirectory(custodyRoot,frozen,candidate),journal=resolve(out,saved.runId+'.events.jsonl'),
   journalBytes=bounded(journal,1024*1024),custody={lock,lockBytes,journal,journalBytes,out,guard};
  const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
  client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
  const send=(command,options={})=>client.send(command,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)});
  const boundary=()=>{catalogRuntimeObservationEnvironment(process.env);verifyCatalogRuntimeCustodyLocation(root,custodyRoot);
   guard.verify();verifyCatalogRuntimeSharedLocks(custodyRoot,true,true);};
  const unchangedCandidate=()=>{const reread=readCareRegisteredCandidate(directory);
   check(['bundle','zip','releaseBytes','manifestBytes'].every(k=>reread[k].equals(candidate[k])),'artifact_changed');};
  const report=await runCatalogRuntimeUploadReconciliation(candidate,operator,custody,{
   now:Date.now,current:async()=>{boundary();unchangedCandidate();return careRegisteredCurrent(root,mobileRoot);},identity:async()=>observeSyntheticMemberIdentity(),
   writerStopped:async pid=>stoppedUploadWriter(pid),custody:async()=>{boundary();return {lockBytes:bounded(lock,16384),journalBytes:bounded(journal,1024*1024)};},
   control:async()=>verifyCatalogRuntimePredecessorControl(observeIntentControlRaw(),source),storage:()=>inspectRegisteredUploadObject(candidate,send),
  });
  boundary();check(stoppedUploadWriter(saved.pid),'writer_active');
  unchangedCandidate();
  check(equal(careRegisteredCurrent(root,mobileRoot),operator),'operator_changed');verifyCatalogRuntimeCustodyRoot(root,custodyRoot);
  return {...report,...archiveReconciledUploadLock(custody,report)};
 }finally{client?.destroy();guard.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>catalogRuntimeUploadReconciliationArguments(process.argv.slice(2)))
  .then(options=>reconcileCatalogRuntimeUpload(process.cwd(),options)).then(r=>console.log(JSON.stringify(r)))
  .catch(error=>{console.error(registeredPreflightFailureCode(error));process.exitCode=1;});
}
