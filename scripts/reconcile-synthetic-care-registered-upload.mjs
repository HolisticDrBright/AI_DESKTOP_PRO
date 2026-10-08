/** Read-only AWS reconciliation of a stopped, failed registered upload. It
 * archives only the verified local lock; no upload, deployment or SQL port. */
import {readFileSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {S3Client,ListObjectVersionsCommand,HeadObjectCommand,GetObjectCommand,
 GetBucketLocationCommand,GetBucketVersioningCommand,GetBucketEncryptionCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,assertCareRegisteredCurrent,readCareRegisteredCandidate,verifyCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCareRegisteredPredecessorControl} from './care-registered-preflight.mjs';
import {observeIntentControlRaw} from './care-intent-live.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {verifyCareUploadBucket,verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {REGISTERED_UPLOAD_TRANSPORT,registeredUploadTransportFailure} from './upload-synthetic-care-registered-release.mjs';
import {registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {observeSyntheticMemberIdentity,assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('upload_reconciliation_'+code);};
export function registeredUploadReconciliationArguments(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--reconcile-fictional-registered-upload-only'
  &&[a[1],a[3]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
const frozenCurrent=c=>Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,c.manifest[k]]));
function readBounded(file,max){
 const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'file');
 const bytes=readFileSync(file),b=lstatSync(file);
 check(a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&bytes.length===a.size,'file_changed');return bytes;
}
function directory(root,parts){let d=realpathSync(root);
 for(const p of parts){d=resolve(d,p);const s=lstatSync(d);check(s.isDirectory()&&!s.isSymbolicLink(),'directory');}return d;
}
export function acquireRegisteredUploadReconciliationGuard(sharedDirectory,operator){
 assertCareRegisteredCurrent(operator);const stat=lstatSync(sharedDirectory);check(stat.isDirectory()&&!stat.isSymbolicLink(),'directory');
 const file=resolve(sharedDirectory,'registered-upload-reconciliation.lock'),bytes=Buffer.from(JSON.stringify({
  purpose:'registered-upload-reconciliation',pid:process.pid,runId:randomBytes(16).toString('hex'),operator:operator.desktop.commit})+'\n');
 let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
 catch(e){if(e?.code==='EEXIST')refuseRegistered('upload_reconciliation_guard_active');throw e;}
 finally{if(fd!==undefined)closeSync(fd);}
 const verify=()=>check(readBounded(file,16384).equals(bytes),'guard_changed');
 return {file,bytes,verify,close:()=>{verify();unlinkSync(file);}};
}
export function stoppedUploadWriter(pid){
 check(Number.isSafeInteger(pid)&&pid>0&&pid!==process.pid,'writer_identity');
 try{process.kill(pid,0);return false;}catch(e){check(e?.code==='ESRCH','writer_unknown');return true;}
}
export function verifyFailedRegisteredUploadCustody(c,candidate,now){
 const frozen=frozenCurrent(candidate);verifyCareRegisteredCandidate(candidate,frozen);
 check(Buffer.isBuffer(c?.lockBytes)&&c.lockBytes.length<=16384&&Buffer.isBuffer(c.journalBytes),'custody_bytes');
 let lock,events;
 try{lock=JSON.parse(c.lockBytes.toString('utf8'));
  check(c.journalBytes.length<=1024*1024&&c.journalBytes.at(-1)===10,'journal_bound');
  events=c.journalBytes.toString('utf8').trimEnd().split('\n').map(s=>JSON.parse(s));
 }catch{refuseRegistered('upload_reconciliation_custody_json');}
 check(c.lockBytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))
  &&canonical(Object.keys(lock).sort())===canonical(['desktop','mobile','pid','purpose','runId'])
  &&c.journalBytes.equals(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')),'custody_encoding');
 check(lock.purpose==='registered-artifact-upload'&&/^[a-f0-9]{32}$/.test(lock.runId)
  &&Number.isSafeInteger(lock.pid)&&lock.pid>0
  &&canonical(lock.desktop)===canonical(frozen.desktop)&&canonical(lock.mobile)===canonical(frozen.mobile),'custody_binding');
 check(events.length>=4&&events.length<=6&&events[0].stage==='registered_upload_started'&&events[0].runId===lock.runId
  &&events.at(-1).stage==='registered_upload_finding'&&events.at(-1).writeAdmitted===true
  &&events.every(e=>['registered_upload_started','registered_live_preflight_verified','registered_artifact_put_admitted',
   'registered_artifact_exact_version_verified','registered_upload_finding'].includes(e.stage)),'journal_scope');
 const admissions=events.filter(e=>e.stage==='registered_artifact_put_admitted');
 check(admissions.length===1&&admissions[0].key===candidate.manifest.key&&admissions[0].sha256===candidate.manifest.zipSha256
  &&events.filter(e=>e.stage==='registered_live_preflight_verified').length===1,'admission');
 let prior=-Infinity;
 for(const e of events){const t=Date.parse(e.at);check(Number.isFinite(t)&&t>=prior&&t<=now,'journal_time');prior=t;}
 // The dead writer and terminal failure are mandatory. This grace exceeds its
 // bounded 30-second request; it is NOT a claim about remote deletion or that
 // the original ambiguous PUT was rejected by AWS.
 check(Number.isFinite(now)&&now-prior>=60000,'writer_settlement');
 return {lock,events,frozen,journalSha256:sha256(c.journalBytes)};
}
export async function inspectRegisteredUploadObject(candidate,send){
 const m=candidate.manifest,bucket={Bucket:P.bucket,ExpectedBucketOwner:P.account};
 verifyCareUploadBucket(await send(new GetBucketLocationCommand(bucket)),await send(new GetBucketVersioningCommand(bucket)),
  await send(new GetBucketEncryptionCommand(bucket)));
 const a=await send(new ListObjectVersionsCommand({...bucket,Prefix:m.key,MaxKeys:100}));
 check(a.IsTruncated===false&&!a.NextKeyMarker&&!a.NextVersionIdMarker
  &&(a.Versions===undefined||Array.isArray(a.Versions))&&(a.DeleteMarkers===undefined||Array.isArray(a.DeleteMarkers))
  &&(a.Versions?.length??0)+(a.DeleteMarkers?.length??0)<=100,'versions_complete');
 check([...(a.Versions??[]),...(a.DeleteMarkers??[])].every(v=>typeof v.Key==='string'&&v.Key.startsWith(m.key)),'version_prefix');
 const versions=(a.Versions??[]).filter(v=>v.Key===m.key),markers=(a.DeleteMarkers??[]).filter(v=>v.Key===m.key);
 check(versions.length<=1&&markers.length===0,'versions_ambiguous');
 if(versions.length===0){
  try{await send(new HeadObjectCommand({...bucket,Key:m.key,ChecksumMode:'ENABLED'}));}
  catch(e){check(e?.name==='NotFound'&&e?.$metadata?.httpStatusCode===404,'absence_unconfirmed');
   return {state:'absent_at_observation',versionId:null,bytesVerified:false,originalPutOutcome:'unknown',deletionCertified:false};}
  refuseRegistered('upload_reconciliation_listing_head_disagree');
 }
 const v=versions[0];check(v.IsLatest===true&&v.Size===m.zipBytes&&typeof v.VersionId==='string'&&v.VersionId&&v.VersionId!=='null','version');
 const input={...bucket,Key:m.key,VersionId:v.VersionId,ChecksumMode:'ENABLED'};
 verifyCareStoredArtifact(await send(new HeadObjectCommand(input)),m,v.VersionId);
 const signal=AbortSignal.timeout(30000),object=await send(new GetObjectCommand(input),{abortSignal:signal});
 try{verifyCareStoredArtifact(object,m,v.VersionId);}catch(e){object.Body?.destroy?.();throw e;}
 const bytes=await readCareArtifact(object.Body,m,signal);check(bytes.equals(candidate.zip),'bytes');
 return {state:'stored_exact_version',versionId:v.VersionId,bytesVerified:true,sha256:m.zipSha256,bytes:m.zipBytes,
  originalPutOutcome:'unknown',deletionCertified:false};
}
/** Ports are credential-free tests only. The public command reads the real
 * stopped process, original custody, complete control plane and S3 versions. */
export async function runRegisteredUploadReconciliation(candidate,operator,custody,port){
 assertCareRegisteredCurrent(operator);
 const failed=verifyFailedRegisteredUploadCustody(custody,candidate,port.now());
 check(operator.desktop.clean===true&&canonical(operator.mobile)===canonical(failed.frozen.mobile)
  &&canonical(operator.migrations)===canonical(failed.frozen.migrations)&&operator.templateSha256===failed.frozen.templateSha256,'operator_binding');
 const caller=await port.identity();assertSyntheticMemberIdentity(caller);
 const guard=async()=>{
  check(canonical(await port.current())===canonical(operator),'operator_changed');
  check(await port.writerStopped(failed.lock.pid)===true,'writer_active');
  const reread=await port.custody();check(reread.lockBytes.equals(custody.lockBytes)&&reread.journalBytes.equals(custody.journalBytes),'custody_changed');
  const next=await port.identity();assertSyntheticMemberIdentity(next);check(canonical(next)===canonical(caller),'principal_changed');
 };
 await guard();const control=await port.control();await guard();
 const first=await port.storage();await guard();const after=await port.control();
 check(canonical(after)===canonical(control),'control_changed');await guard();
 const second=await port.storage();check(canonical(first)===canonical(second),'storage_changed');
 check(['absent_at_observation','stored_exact_version'].includes(first?.state)&&first.originalPutOutcome==='unknown'
  &&first.deletionCertified===false&&(first.state==='absent_at_observation'
   ?first.versionId===null&&first.bytesVerified===false:first.bytesVerified===true&&first.sha256===candidate.manifest.zipSha256
    &&first.bytes===candidate.manifest.zipBytes&&typeof first.versionId==='string'&&first.versionId.length>0),'storage_result');
 check(canonical(await port.control())===canonical(control),'control_changed');await guard();
 return {contract:'synthetic-care-registered-upload-reconciliation/1',observedAt:new Date(port.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,runId:failed.lock.runId,
  applicationSource:failed.frozen,applicationSourceRebuilt:false,operatorSource:operator,journalSha256:failed.journalSha256,storage:first,
  writerStopped:true,repeatedStorageReadback:true,predecessorControl:control,originalPutOutcome:'unknown',
  retryPerformed:false,awsMutationPerformed:false,deployed:false,schemaChanged:false,hostedAcceptance:false,
  releaseAccepted:false,reportIsNotAuthority:true,phiAllowed:false,paidMobileBuildStarted:false};
}
function save(file,bytes){let fd;
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
 catch(e){if(e?.code!=='EEXIST')throw e;check(readBounded(file,1024*1024).equals(bytes),'archive_collision');}
 finally{if(fd!==undefined)closeSync(fd);}
 check(readBounded(file,1024*1024).equals(bytes),'archive_readback');
}
export function archiveReconciledUploadLock(custody,report){
 check(report.runId===JSON.parse(custody.lockBytes.toString('utf8')).runId&&report.writerStopped===true
  &&report.repeatedStorageReadback===true&&report.originalPutOutcome==='unknown'&&report.reportIsNotAuthority===true
  &&report.awsMutationPerformed===false&&report.deployed===false,'archive_report');
 check(custody.guard&&Buffer.isBuffer(custody.guard.bytes),'guard_required');custody.guard.verify();
 check(readBounded(custody.lock,1024*1024).equals(custody.lockBytes)
  &&readBounded(custody.journal,1024*1024).equals(custody.journalBytes),'custody_changed');
 const archive=resolve(custody.out,report.runId+'.settled-lock.json'),receipt=resolve(custody.out,
  report.runId+'.reconciliation-'+sha256(canonical(report))+'.json');
 save(archive,custody.lockBytes);save(receipt,Buffer.from(JSON.stringify(report,null,2)+'\n'));
 // Exact local lock only, after recoverable archive/receipt readback. Original
 // journal, artifact and any remote object remain untouched.
 check(readBounded(custody.lock,1024*1024).equals(custody.lockBytes)
  &&readBounded(custody.journal,1024*1024).equals(custody.journalBytes),'custody_changed');
 custody.guard.verify();unlinkSync(custody.lock);return {archive,receipt,operatorCustodySettled:true};
}
export async function reconcileRegisteredUpload(root,mobileRoot,artifactDirectory){
 const operator=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(artifactDirectory),frozen=frozenCurrent(candidate);
 verifyCareRegisteredCandidate(candidate,frozen);observeSyntheticMemberIdentity();
 const sharedDirectory=directory(root,['dist','synthetic-care-routing']),guard=acquireRegisteredUploadReconciliationGuard(sharedDirectory,operator);
 let client;
 try{
 const lock=resolve(sharedDirectory,'operator.lock'),lockBytes=readBounded(lock,1024*1024),saved=JSON.parse(lockBytes.toString('utf8'));
 check(/^[a-f0-9]{32}$/.test(saved.runId),'run_id');
 const out=directory(root,['dist','synthetic-care-registered-operations',frozen.desktop.commit,frozen.mobile.source.commit,candidate.manifest.zipSha256]),
  journal=resolve(out,saved.runId+'.events.jsonl'),journalBytes=readBounded(journal,1024*1024),custody={lock,lockBytes,journal,journalBytes,out,guard};
 const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
 client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
 const send=async(command,options={})=>client.send(command,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)});
 const report=await runRegisteredUploadReconciliation(candidate,operator,custody,{
  now:Date.now,current:async()=>careRegisteredCurrent(root,mobileRoot),identity:async()=>observeSyntheticMemberIdentity(),writerStopped:async pid=>stoppedUploadWriter(pid),
  custody:async()=>{guard.verify();return {...custody,lockBytes:readBounded(lock,1024*1024),journalBytes:readBounded(journal,1024*1024)};},
  control:async()=>verifyCareRegisteredPredecessorControl(observeIntentControlRaw(),source),storage:()=>inspectRegisteredUploadObject(candidate,send),
 });
  check(stoppedUploadWriter(saved.pid),'writer_active');
  check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(operator),'operator_changed');
  return {...report,...archiveReconciledUploadLock(custody,report)};
 }catch(e){if(e instanceof Error&&e.message.startsWith('synthetic_care_'))throw e;
  throw Error(registeredUploadTransportFailure(undefined,e));}finally{client?.destroy();guard.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>registeredUploadReconciliationArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>reconcileRegisteredUpload(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
