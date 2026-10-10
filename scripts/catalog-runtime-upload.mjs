/** Fixed synthetic artifact upload, separate from API deployment. Shared custody
 * and reconciliation are required; a report file cannot admit a write. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync,lstatSync,readdirSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,readFileSync} from 'node:fs';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,careSourceSnapshot,normalizedText} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,careRegisteredCurrent,readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {CATALOG_RUNTIME as K,verifyCatalogRuntimeCandidate} from './synthetic-catalog-runtime-release.mjs';
import {verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
import {verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {catalogRuntimeInspectArguments,catalogRuntimeObservationEnvironment,observeCatalogRuntimePreflight} from './inspect-synthetic-catalog-runtime-release.mjs';
import {REGISTERED_UPLOAD_TRANSPORT,registeredUploadTransportFailure} from './upload-synthetic-care-registered-release.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {uploadAndVerifyCareArtifact} from './upload-synthetic-care-release.mjs';
import {observeIntentControlRaw} from './care-intent-live.mjs';
import {assertSyntheticMemberIdentity,observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_upload_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const capture=c=>{const copy=structuredClone(c);for(const k of ['bundle','zip','releaseBytes','manifestBytes'])copy[k]=Buffer.from(copy[k]);return copy;};
export function catalogRuntimeUploadArguments(args){
 check(args[10]==='--upload-fictional-catalog-runtime-code-only','arguments');
 const inspect=[...args];inspect[10]='--inspect-fictional-catalog-runtime-only';return catalogRuntimeInspectArguments(inspect);
}
export function verifyCatalogRuntimeUploadPreflight(r,candidate,current,now){
 verifyCatalogRuntimeCandidate(candidate,current);const t=Date.parse(r?.observedAt);
 const fields=['contract','observedAt','current','execution','account','candidateZipSha256','localArtifact','control',
  'databaseBefore','databaseAfter','predecessorDownload','retained','liveTargetObserved','independentSourceRebuildVerified',
  'predecessorBytesVerified','repeatedReadbackVerified','reportIsNotAuthority','deployAuthorized','awsMutationPerformed',
  'schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance','releaseAccepted','physicalDeviceAcceptance',
  'phiAllowed','paidMobileBuildStarted'];
 check(r&&equal(Object.keys(r).sort(),fields.sort())&&Number.isFinite(now)&&Number.isFinite(t)&&t<=now&&now-t<=120000
  &&r.contract==='synthetic-catalog-runtime-preflight/1'&&r.execution==='synthetic-staging'&&r.account===P.account
  &&equal(r.current,current)&&r.candidateZipSha256===candidate.manifest.zipSha256
  &&['liveTargetObserved','independentSourceRebuildVerified','predecessorBytesVerified','repeatedReadbackVerified','reportIsNotAuthority'].every(k=>r[k]===true)
  &&['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance',
   'releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].every(k=>r[k]===false),'preflight');
 const dbStart=Math.min(Date.parse(r.databaseBefore?.observedAt),Date.parse(r.databaseAfter?.observedAt));
 verifyCareRegisteredDatabase(r.databaseBefore,current,dbStart,t);verifyCareRegisteredDatabase(r.databaseAfter,current,dbStart,t);
 const comparable=x=>{const copy=structuredClone(x);delete copy.observedAt;return copy;};
 check(equal(comparable(r.databaseBefore),comparable(r.databaseAfter)),'database_changed');
 check(equal(r.localArtifact,{...verifyCatalogRuntimeCandidate(candidate,current),sourceRebuilt:true,
  desktopCommit:current.desktop.commit,mobileCommit:current.mobile.source.commit,liveTargetObserved:false,deployed:false,
  erasureAccepted:false,physicalDeviceAcceptance:false,paidMobileBuildStarted:false}),'rebuild');
 check(equal(r.predecessorDownload,{managedSha256:K.predecessorZip,managedBytes:K.predecessorBytes,
  storedSha256:K.predecessorZip,storedBytes:K.predecessorBytes,version:K.predecessorVersion,
  exactBytesVerified:true,frozenSourceRebuilt:true})&&equal(r.retained,{version:K.recoveryVersion,sha256:C.predecessorZip,
   bytes:C.predecessorBytes,invokePermissionAbsent:true,sameArtifactAsLatest:false}),'predecessor');
 check(r.control?.identityRouteCount===51&&r.control.apiRouteCount===112&&r.control.iamVerified===true
  &&r.control.loggingVerified===true&&r.control.phiAllowed===false,'control');
}
/** Test seams only. Public commands construct the observers themselves. */
export async function runCatalogRuntimeUpload(suppliedCandidate,suppliedCurrent,port){
 const candidate=capture(suppliedCandidate),current=structuredClone(suppliedCurrent);
 verifyCatalogRuntimeCandidate(candidate,current);
 const caller=structuredClone(await port.identity());assertSyntheticMemberIdentity(caller);
 const unchanged=async()=>{
  await port.custody();check(equal(await port.current(),current),'source_changed');
  const next=await port.identity();assertSyntheticMemberIdentity(next);check(equal(next,caller),'principal_changed');
 };
 await unchanged();const preparation=structuredClone(await port.preflight());
 verifyCatalogRuntimeUploadPreflight(preparation,candidate,current,port.now());
 await port.record({stage:'catalog_runtime_live_preflight_verified',observedAt:preparation.observedAt});
 const boundary=async()=>{
  await unchanged();verifyCatalogRuntimeUploadPreflight(preparation,candidate,current,port.now());
  check(equal(await port.control(),preparation.control),'control_changed');await unchanged();
  verifyCatalogRuntimeUploadPreflight(preparation,candidate,current,port.now());
 };
 // The preflight already ended with a complete repeated control observation.
 // Bucket reads cannot admit a code write. Re-observe the complete control at
 // the actual PUT boundary and again after exact-version readback.
 await unchanged();verifyCatalogRuntimeUploadPreflight(preparation,candidate,current,port.now());
 const artifact=await uploadAndVerifyCareArtifact(async(command,options)=>{
  await unchanged();
  if(command instanceof PutObjectCommand){
   await boundary();await port.admit({stage:'catalog_runtime_artifact_put_admitted',key:candidate.manifest.key,sha256:candidate.manifest.zipSha256});
   // Journal admission may itself await I/O. Recheck before the first remote
   // write instead of letting admission extend the freshness window.
   await boundary();
  }
  return port.send(command,options);
 },candidate.manifest,candidate.zip);
 await boundary();await port.record({stage:'catalog_runtime_artifact_exact_version_verified',artifact});
 return {contract:'synthetic-catalog-runtime-upload/1',observedAt:new Date(port.now()).toISOString(),current,
  execution:'synthetic-staging',account:P.account,region:P.region,preparation,artifact,
  candidateUploaded:true,awsMutationPerformed:!artifact.reused,changeSetCreated:false,deployed:false,schemaChanged:false,
  recoveryRehearsed:false,hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,phiAllowed:false,paidMobileBuildStarted:false};
}
export function verifyCatalogRuntimeCustodyRoot(operatorRoot,custodyRoot){
 verifyCatalogRuntimeCustodyLocation(operatorRoot,custodyRoot);
 check(equal(careSourceSnapshot(custodyRoot,'desktop'),{commit:'c7e1840b9cd58086d077e54d224784a273246d77',clean:true,files:1703,
  sha256:'5fcc4dbfe28ef3b11ce39b8d56319cf968c095c34839cced9f2f1bea839854f8'}),'custody_source');
}
export function verifyCatalogRuntimeCustodyLocation(operatorRoot,custodyRoot){
 const expected=resolve(operatorRoot,'..','DESKTOP_COMMERCIAL_20261005');
 check(resolve(custodyRoot).toLowerCase()===expected.toLowerCase()
  &&realpathSync(custodyRoot).toLowerCase()===expected.toLowerCase(),'custody_root');
 const stat=lstatSync(custodyRoot);check(stat.isDirectory()&&!stat.isSymbolicLink(),'custody_root');
}
export function catalogRuntimeOperationDirectory(root,current,candidate){
 verifyCatalogRuntimeCandidate(candidate,current);let directory=realpathSync(root);
 const step=part=>{directory=resolve(directory,part);try{mkdirSync(directory,{mode:0o700});}catch(e){if(e?.code!=='EEXIST')throw e;}
  const stat=lstatSync(directory);check(stat.isDirectory()&&!stat.isSymbolicLink(),'operations_directory');};
 step('dist');const dist=directory;step('synthetic-care-routing');directory=dist;
 for(const part of ['synthetic-catalog-runtime-operations',current.desktop.commit,current.mobile.source.commit,candidate.manifest.zipSha256])step(part);
 return directory;
}
export function verifyCatalogRuntimeSharedLocks(root,ownOperator=false,ownReconciliation=false){
 const shared=resolve(root,'dist/synthetic-care-routing'),stat=lstatSync(shared);
 check(stat.isDirectory()&&!stat.isSymbolicLink(),'shared_directory');
 const allowed=[...(ownOperator?['operator.lock']:[]),...(ownReconciliation?['registered-upload-reconciliation.lock']:[])];
 check(readdirSync(shared).filter(name=>name.endsWith('.lock')).every(name=>allowed.includes(name)),'shared_lock_active');
}
export function saveCatalogRuntimeReceipt(file,value){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');let fd;
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
 const stat=lstatSync(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===bytes.length&&readFileSync(file).equals(bytes),'receipt_readback');
}
export async function uploadCatalogRuntimeLive(root,options){
 const {mobileRoot,directory,custodyRoot}=options;catalogRuntimeObservationEnvironment(process.env);
 process.env.AWS_MAX_ATTEMPTS='1';process.env.AWS_RETRY_MODE='standard';process.env.AWS_PAGER='';
 const current=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory);
 verifyCatalogRuntimeCandidate(candidate,current);verifyCatalogRuntimeCustodyRoot(root,custodyRoot);observeSyntheticMemberIdentity();
 const out=catalogRuntimeOperationDirectory(custodyRoot,current,candidate);verifyCatalogRuntimeSharedLocks(custodyRoot);
 const custody=createIntentUploadCustody(custodyRoot,out,current,'catalog-runtime-artifact-upload');
 const client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
 let transportFailure;
 try{
  custody.record({stage:'catalog_runtime_upload_started',runId:custody.runId});
  const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
  const result=await runCatalogRuntimeUpload(candidate,current,{
   now:Date.now,identity:async()=>observeSyntheticMemberIdentity(),
   custody:async()=>{catalogRuntimeObservationEnvironment(process.env);verifyCatalogRuntimeCustodyLocation(root,custodyRoot);
    custody.verify();verifyCatalogRuntimeSharedLocks(custodyRoot,true);},
   current:async()=>{const fresh=careRegisteredCurrent(root,mobileRoot),r=readCareRegisteredCandidate(directory);
    check(['zip','bundle','releaseBytes','manifestBytes'].every(k=>r[k].equals(candidate[k])),'artifact_changed');return fresh;},
   preflight:()=>observeCatalogRuntimePreflight(root,options),
   control:async()=>verifyCatalogRuntimePredecessorControl(observeIntentControlRaw(),source),record:custody.record,admit:custody.admit,
   send:async(command,options={})=>{
    try{const result=await client.send(command,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)});transportFailure=undefined;return result;}
    catch(error){transportFailure=registeredUploadTransportFailure(command,error);throw error;}
   },
  });
  const receipt=resolve(out,custody.runId+'.json');saveCatalogRuntimeReceipt(receipt,{runId:custody.runId,journal:custody.journal,...result});
  verifyCatalogRuntimeCustodyRoot(root,custodyRoot);custody.verify();verifyCatalogRuntimeSharedLocks(custodyRoot,true);
  custody.record({stage:'catalog_runtime_upload_completed',receipt});custody.settle();
  return {receipt,runId:custody.runId,journal:custody.journal,...result,operatorCustodySettled:true};
 }catch(error){const fallback=registeredPreflightFailureCode(error),code=fallback.endsWith(':preflight_failed')&&transportFailure?transportFailure:fallback;
  custody.record({stage:'catalog_runtime_upload_finding',code,writeAdmitted:custody.admitted});throw Error(code);
 }finally{client.destroy();custody.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>catalogRuntimeUploadArguments(process.argv.slice(2)))
  .then(options=>uploadCatalogRuntimeLive(process.cwd(),options)).then(r=>console.log(JSON.stringify(r)))
  .catch(error=>{console.error(registeredPreflightFailureCode(error));process.exitCode=1;});
}
