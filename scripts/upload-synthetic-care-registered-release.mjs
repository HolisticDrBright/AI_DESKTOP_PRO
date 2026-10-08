/** Current registered upload only. Own fresh preflight; no saved-report,
 * target/profile, execution, SQL replay or mobile-build surface. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openSync,writeFileSync,fsyncSync,closeSync,readFileSync,mkdirSync,realpathSync,lstatSync} from 'node:fs';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,normalizedText} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,readCareRegisteredCandidate,verifyCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {observeCareRegisteredPreflight,registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {verifyCareRegisteredPredecessorControl} from './care-registered-preflight.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {observeIntentControlRaw} from './care-intent-live.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {uploadAndVerifyCareArtifact} from './upload-synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity,assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('upload_'+code);};
export function careRegisteredUploadArguments(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--upload-fictional-registered-code-only'
  &&[a[1],a[3]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
export function verifyRegisteredUploadPreflight(r,candidate,current,now){
 verifyCareRegisteredCandidate(candidate,current);
 const time=Date.parse(r?.observedAt);
 check(Number.isFinite(now)&&Number.isFinite(time)&&time<=now&&now-time<=120000
  &&r.contract==='synthetic-care-registered-preflight/1'&&r.execution==='synthetic-staging'&&r.account===P.account
  &&canonical(r.current)===canonical(current)&&r.candidateZipSha256===candidate.manifest.zipSha256
  &&r.liveTargetObserved===true&&r.independentSourceRebuildVerified===true&&r.predecessorBytesVerified===true
  &&r.repeatedReadbackVerified===true&&r.reportIsNotAuthority===true
  &&['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance',
   'releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].every(k=>r[k]===false),'preflight');
}
/** Observers are test seams only. The command below supplies actual observers
 * and never accepts their output from a file, environment or CLI argument. */
export async function runRegisteredUpload(candidate,current,port){
 verifyCareRegisteredCandidate(candidate,current);
 const firstCaller=await port.identity();assertSyntheticMemberIdentity(firstCaller);
 const unchanged=async()=>{
  check(canonical(await port.current())===canonical(current),'source_changed');
  const caller=await port.identity();assertSyntheticMemberIdentity(caller);
  check(canonical(caller)===canonical(firstCaller),'principal_changed');
 };
 await unchanged();
 const preparation=await port.preflight();
 verifyRegisteredUploadPreflight(preparation,candidate,current,port.now());
 port.record({stage:'registered_live_preflight_verified',observedAt:preparation.observedAt});
 const boundary=async()=>{
  await unchanged();verifyRegisteredUploadPreflight(preparation,candidate,current,port.now());
  check(canonical(await port.control())===canonical(preparation.control),'control_changed');
  await unchanged();verifyRegisteredUploadPreflight(preparation,candidate,current,port.now());
 };
 await boundary();
 const artifact=await uploadAndVerifyCareArtifact(async(command,options)=>{
  if(command instanceof PutObjectCommand){
   await boundary();
   port.admit({stage:'registered_artifact_put_admitted',key:candidate.manifest.key,sha256:candidate.manifest.zipSha256});
  }
  return port.send(command,options);
 },candidate.manifest,candidate.zip);
 await boundary();
 port.record({stage:'registered_artifact_exact_version_verified',artifact});
 return {contract:'synthetic-care-registered-upload/1',observedAt:new Date(port.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,current,preparation,artifact,
  candidateUploaded:true,awsMutationPerformed:!artifact.reused,changeSetCreated:false,deployed:false,schemaChanged:false,
  recoveryRehearsed:false,hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,
  phiAllowed:false,paidMobileBuildStarted:false};
}
function durableReport(file,report){
 const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
 const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 check(readFileSync(file).equals(bytes),'receipt_readback');
}
export function registeredOperationDirectory(root,current,candidate){
 verifyCareRegisteredCandidate(candidate,current);let directory=realpathSync(root);
 // Create/check each component; never traverse an operations or shared-lock
 // junction into an unrelated directory. The artifact itself stays immutable.
 const step=part=>{
  directory=resolve(directory,part);
  try{mkdirSync(directory,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}
  const stat=lstatSync(directory);check(stat.isDirectory()&&!stat.isSymbolicLink(),'operations_directory');
 };
 step('dist');const dist=directory;step('synthetic-care-routing');directory=dist;
 for(const part of ['synthetic-care-registered-operations',current.desktop.commit,current.mobile.source.commit,candidate.manifest.zipSha256])step(part);
 return directory;
}
export async function uploadCareRegisteredRelease(root,mobileRoot,directory){
 const current=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory);
 verifyCareRegisteredCandidate(candidate,current);observeSyntheticMemberIdentity();
 const out=registeredOperationDirectory(root,current,candidate);
 const custody=createIntentUploadCustody(root,out,current,'registered-artifact-upload');
 const client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1});
 try{
  custody.record({stage:'registered_upload_started',runId:custody.runId});
  const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
  const report=await runRegisteredUpload(candidate,current,{
   now:Date.now,identity:async()=>observeSyntheticMemberIdentity(),
   current:async()=>{
    const fresh=careRegisteredCurrent(root,mobileRoot),r=readCareRegisteredCandidate(directory);
    check(['zip','bundle','releaseBytes','manifestBytes'].every(k=>r[k].equals(candidate[k])),'artifact_changed');return fresh;
   },preflight:()=>observeCareRegisteredPreflight(root,mobileRoot,directory),
   control:async()=>verifyCareRegisteredPredecessorControl(observeIntentControlRaw(),source),
   record:custody.record,admit:custody.admit,
   send:(command,options={})=>client.send(command,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)}),
  });
  const receipt=resolve(out,custody.runId+'.json');durableReport(receipt,{runId:custody.runId,journal:custody.journal,...report});
  custody.record({stage:'registered_upload_completed',receipt});custody.settle();
  return {receipt,runId:custody.runId,journal:custody.journal,...report,operatorCustodySettled:true};
 }catch(error){custody.record({stage:'registered_upload_finding',code:registeredPreflightFailureCode(error),writeAdmitted:custody.admitted});throw error;}
 finally{client.destroy();custody.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careRegisteredUploadArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>uploadCareRegisteredRelease(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r)))
  .catch(error=>{console.error(registeredPreflightFailureCode(error));process.exitCode=1;});
}
