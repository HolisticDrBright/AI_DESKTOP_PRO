/** Distinct catalog-runtime successor. Source construction only; the deployed
 * registered predecessor and retained recovery version are different artifacts.
 * No AWS, upload, execution, SQL, activation or mobile build port exists here. */
import {readFileSync,lstatSync,mkdirSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_RELEASE as P,sha256,careReleaseZip,careSourceSnapshot,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,careRegisteredCurrent,assertCareRegisteredCurrent,createCareRegisteredCandidate,
 readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
export const CATALOG_RUNTIME=Object.freeze({
 contract:'synthetic-catalog-runtime-release/1',
 predecessorDesktop:'9597fcb709482c8eb9bedb2841b27993844a4a6e',
 predecessorMobile:'38ea48c07dc7d4ca7c2c37962b2a50ac178e381b',
 predecessorZip:'285f33d0c033d266b34febbf53336e1f1853873d31c29138f3fc92e52941b0fc',
 predecessorVersion:'wVlgZVgXihAPuhEl0e8uk9P__oUn75Mn',predecessorBytes:1827487,
 desktopFiles:1703,desktopSourceSha256:'533229c490d423d56bed82d9324bc6f208beb13dcbadfa3d19b032165778c0ff',
 mobileFiles:919,mobileSourceSha256:'9a03bf8f35aa0bec9dd04c0dd235d5132180eee6b072b8aad33b7f32c5d11026',
 recoveryVersion:'2',
});
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_'+code);};
export function catalogRuntimePredecessor(){
 const p=CATALOG_RUNTIME;
 return {desktop:p.predecessorDesktop,mobile:p.predecessorMobile,zipSha256:p.predecessorZip,bytes:p.predecessorBytes,
  version:p.predecessorVersion,
  key:`clinical-core/authenticated-api/care-registered-release/${p.predecessorDesktop}/${p.predecessorMobile}/${p.predecessorZip}.zip`,
  codeSha256:Buffer.from(p.predecessorZip,'hex').toString('base64'),liveObservationSupplied:false};
}
export function catalogRuntimeRecoveryPredecessor(){
 return {desktop:C.predecessorDesktop,mobile:C.predecessorMobile,zipSha256:C.predecessorZip,bytes:C.predecessorBytes,
  version:CATALOG_RUNTIME.recoveryVersion,storageVersion:C.predecessorVersion,
  key:`clinical-core/authenticated-api/care-intent-release/${C.predecessorDesktop}/${C.predecessorZip}.zip`,
  codeSha256:Buffer.from(C.predecessorZip,'hex').toString('base64'),liveObservationSupplied:false,rehearsed:false};
}
export function createCatalogRuntimeCandidate(supplied,bundle){
 const current=structuredClone(supplied);assertCareRegisteredCurrent(current);
 // Derive common closed-boundary metadata from the original pure constructor;
 // never rewrite a supplied report, artifact or live AWS observation.
 const release=createCareRegisteredCandidate(current,bundle).release;
 release.contract=CATALOG_RUNTIME.contract;release.predecessor=catalogRuntimePredecessor();
 release.recoveryPredecessor=catalogRuntimeRecoveryPredecessor();
 release.rollout.sameTargetCatalogAcceptanceRequired=true;
 release.rollout.ownerAdoptedPlanInventoryRequired=true;
 release.acceptanceRequirements.push('same_target_catalog_ingredient_inventory','owner_adopted_plan_inventory',
  'all_program_supplements_held_until_complete_inventory');
 const zip=careReleaseZip(bundle,release),zipSha256=sha256(zip);
 const manifest={...release,zipSha256,zipBytes:zip.length,
  key:`clinical-core/authenticated-api/catalog-runtime-release/${current.desktop.commit}/${current.mobile.source.commit}/${zipSha256}.zip`};
 return {current,bundle:Buffer.from(bundle),release,manifest,zip,
  releaseBytes:Buffer.from(JSON.stringify(release)+'\n'),manifestBytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')};
}
export function verifyCatalogRuntimeCandidate(candidate,current){
 check(candidate&&['bundle','zip','releaseBytes','manifestBytes'].every(k=>Buffer.isBuffer(candidate[k])),'candidate_bytes');
 const expected=createCatalogRuntimeCandidate(current,candidate.bundle);
 check(canonical(candidate.release)===canonical(expected.release)&&canonical(candidate.manifest)===canonical(expected.manifest)
  &&candidate.zip.equals(expected.zip)&&candidate.releaseBytes.equals(expected.releaseBytes)
  &&candidate.manifestBytes.equals(expected.manifestBytes),'candidate_binding');
 return {contract:CATALOG_RUNTIME.contract,byteVerified:true,sourceRebuilt:false,zipSha256:expected.manifest.zipSha256,
  schemaReplayAuthorized:false,releaseAccepted:false,phiAllowed:false};
}
export async function buildCatalogRuntimeCandidate(root,mobileRoot){
 const current=careRegisteredCurrent(root,mobileRoot),bundle=await buildCareIdentityBundle(root);
 check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(current),'source_changed');
 return createCatalogRuntimeCandidate(current,bundle);
}
/** Exact versioned storage binding, not a saved upload's authority. */
export function verifyCatalogRuntimeArtifactBinding(candidate,current,artifact){
 verifyCatalogRuntimeCandidate(candidate,current);
 check(artifact&&canonical(Object.keys(artifact).sort())===canonical(['bucket','bytes','encryption','exactVersionReadbackVerified',
  'key','kmsKeyArn','reused','sha256','versionId'])&&artifact.bucket===P.bucket&&artifact.key===candidate.manifest.key
  &&artifact.sha256===candidate.manifest.zipSha256&&artifact.bytes===candidate.zip.length&&artifact.exactVersionReadbackVerified===true
  &&typeof artifact.reused==='boolean'&&artifact.encryption==='aws:kms'&&artifact.kmsKeyArn===P.keyArn
  &&typeof artifact.versionId==='string'&&artifact.versionId.length>0&&artifact.versionId.length<=1024
  &&artifact.versionId!=='null'&&!/[\u0000-\u0020\u007f]/.test(artifact.versionId),'artifact_binding');
 return structuredClone(artifact);
}
export async function inspectCatalogRuntimeArtifact(root,mobileRoot,directory){
 const current=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory);
 const verified=verifyCatalogRuntimeCandidate(candidate,current),rebuilt=await buildCareIdentityBundle(root);
 check(rebuilt.equals(candidate.bundle),'rebuilt_bundle');
 check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(current),'source_changed');
 return {...verified,sourceRebuilt:true,desktopCommit:current.desktop.commit,mobileCommit:current.mobile.source.commit,
  liveTargetObserved:false,deployed:false,erasureAccepted:false,physicalDeviceAcceptance:false,paidMobileBuildStarted:false};
}
const names=['index.js','candidate.zip','release.json','artifact-manifest.json'];
export function writeCatalogRuntimeCandidate(root,candidate){
 verifyCatalogRuntimeCandidate(candidate,candidate.current);let directory=realpathSync(root);
 for(const part of ['dist','synthetic-catalog-runtime-release',candidate.current.desktop.commit,
  candidate.current.mobile.source.commit,candidate.manifest.zipSha256]){
  directory=resolve(directory,part);
  try{mkdirSync(directory,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}
  const s=lstatSync(directory);check(s.isDirectory()&&!s.isSymbolicLink(),'artifact_directory');
 }
 const bodies=[candidate.bundle,candidate.zip,candidate.releaseBytes,candidate.manifestBytes];
 for(let i=0;i<names.length;i++){
  const file=resolve(directory,names[i]);let fd;
  try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bodies[i]);fsyncSync(fd);}
  catch(error){if(error?.code!=='EEXIST')throw error;
   const s=lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&s.size===bodies[i].length
    &&readFileSync(file).equals(bodies[i]),'artifact_collision');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 verifyCatalogRuntimeCandidate(readCareRegisteredCandidate(directory),candidate.current);return directory;
}
/** Full protected snapshots must match the immutable deployed sources before
 * the historical source inspector can run. No arbitrary commit or hash input. */
export function verifyCatalogRuntimeFrozenSources(desktopRoot,mobileRoot){
 const p=CATALOG_RUNTIME,desktop=careSourceSnapshot(desktopRoot,'desktop'),mobile=careSourceSnapshot(mobileRoot,'v2');
 check(canonical(desktop)===canonical({commit:p.predecessorDesktop,clean:true,files:p.desktopFiles,sha256:p.desktopSourceSha256})
  &&canonical(mobile)===canonical({commit:p.predecessorMobile,clean:true,files:p.mobileFiles,sha256:p.mobileSourceSha256}),'frozen_source');
 return {desktop,mobile};
}
