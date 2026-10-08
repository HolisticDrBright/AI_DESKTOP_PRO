/** Current registered source artifact, distinct from the retired overlay release.
 * Build and byte verification only: no AWS client, credentials, SQL, activation,
 * deployment, deletion, mobile build or saved-inspection authority. */
import {readFileSync,lstatSync,readdirSync,mkdirSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {CARE_RELEASE as P,sha256,normalizedText,careSourceSnapshot,careReleaseZip,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {careIntentMobileBinding} from './synthetic-care-intent-release.mjs';
import {readCanonicalCareMigrations,canonicalCareRegistrationDescriptor} from './care-canonical-migrations.mjs';

export const CARE_REGISTERED=Object.freeze({contract:'synthetic-care-registered-release/1',
 protocol:'request-id-intent-discovery-settlement/1',
 predecessorDesktop:'0e38c130fa212a7a418301b4b72094c649f8f2fe',
 predecessorMobile:'1488a3bf85aca5e2c9a7b8b5c7179e314397dc66',
 predecessorZip:'f8f995e09879eb7b45d17ffc5f18d5ecb9867f21c0a0795eacb3fd31ccaa0216',
 predecessorVersion:'lagGFfNd0kIrsydunYd2WvicsWEX9tLC',predecessorBytes:1826076});
export const refuseRegistered=reason=>{throw Error('synthetic_care_registered_release_refused:'+reason);};
const check=(ok,reason)=>{if(!ok)refuseRegistered(reason);};
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&canonical(Object.keys(value).sort())===canonical([...expected].sort());
const snapshot=s=>keys(s,['commit','clean','files','sha256'])&&s.clean===true&&/^[a-f0-9]{40}$/.test(s.commit)
 &&Number.isSafeInteger(s.files)&&s.files>0&&hash(s.sha256);

/** This descriptor is an expected target, never a live observation. */
export function careRegisteredTarget(){
 return {account:P.account,region:P.region,foundation:P.foundation,stack:P.stack,apiId:P.apiId,
  functionName:P.functionName,database:P.database,cluster:P.cluster,secret:P.secret,bucket:P.bucket,
  consumerPool:P.consumerPool,consumerClient:P.consumerClient,workforcePool:P.workforcePool,workforceClient:P.workforceClient,
  keyArn:P.keyArn,execution:'synthetic-staging',phiAllowed:false};
}
export function careRegisteredCurrent(root,mobileRoot){
 const desktop=careSourceSnapshot(root,'desktop'),mobile=careIntentMobileBinding(mobileRoot,root);
 const migrations=readCanonicalCareMigrations(root).mapping;
 return {desktop,mobile,migrations,templateSha256:sha256(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'))};
}
export function assertCareRegisteredCurrent(current){
 const fields=['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'];
 check(keys(current,['desktop','mobile','migrations','templateSha256'])&&snapshot(current.desktop)
  &&keys(current.mobile,['source','built','deviceVerified',...fields])&&snapshot(current.mobile.source)
  &&current.mobile.built===false&&current.mobile.deviceVerified===false&&fields.every(k=>hash(current.mobile[k]))
  &&hash(current.templateSha256),'source_binding');
 check(canonical(current.migrations)===canonical(canonicalCareRegistrationDescriptor()),'registered_history');
}
export function createCareRegisteredCandidate(supplied,bundle){
 const current=structuredClone(supplied);assertCareRegisteredCurrent(current);
 check(Buffer.isBuffer(bundle)&&bundle.length>0&&bundle.length<=10*1024*1024,'bundle');
 const p=CARE_REGISTERED;
 const release={contract:p.contract,execution:'synthetic-staging',phiAllowed:false,...current,
  target:careRegisteredTarget(),bundleSha256:sha256(bundle),erasureProtocol:p.protocol,legacyErasureAdmission:false,
  predecessor:{desktop:p.predecessorDesktop,mobile:p.predecessorMobile,zipSha256:p.predecessorZip,
   bytes:p.predecessorBytes,version:p.predecessorVersion,
   key:`clinical-core/authenticated-api/care-intent-release/${p.predecessorDesktop}/${p.predecessorZip}.zip`,
   codeSha256:Buffer.from(p.predecessorZip,'hex').toString('base64'),liveObservationSupplied:false},
  rollout:{schemaAlreadyRegistered:true,schemaReplayAllowed:false,ledgerRewriteAllowed:false,
   sourceBoundFreshInspectionRequired:true,exactPredecessorInspectionRequired:true,compatibleRecoveryRequired:true,
   authorityExpansionAllowed:false,missingRoutesAdded:false,knownAbsentSourceRoutes:[...P.absentRoutes]},
  rollback:{databaseDownMigrationAllowed:false,idlessApiAllowed:false,parentOnlyApiAllowed:false,
   intentCompatibleReForwardRequired:true,rehearsed:false},
  acceptanceRequirements:['independent_current_source_rebuild','exact_artifact_control_plane_readback','compatible_traffic_recovery',
   'prepared_erased','prepared_cancelled','lost_prepare_reply','lost_terminal_reply','second_session_discovery',
   'cancel_erase_both_race_orders','request_replay','cross_owner_refusal','consent_withdrawal_refusal'],
  built:true,deployed:false,schemaChanged:false,hostedAcceptance:false,erasureAccepted:false,
  physicalDeviceAcceptance:false,matchedReleaseAccepted:false,productionApproved:false,phiActivation:false,
  releaseExecutionAvailable:false,paidMobileBuildStarted:false};
 const zip=careReleaseZip(bundle,release),zipSha256=sha256(zip);
 const manifest={...release,zipSha256,zipBytes:zip.length,
  key:`clinical-core/authenticated-api/care-registered-release/${current.desktop.commit}/${current.mobile.source.commit}/${zipSha256}.zip`};
 return {current,bundle:Buffer.from(bundle),release,manifest,zip,
  releaseBytes:Buffer.from(JSON.stringify(release)+'\n'),manifestBytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')};
}
export function verifyCareRegisteredCandidate(candidate,current){
 check(candidate&&['bundle','zip','releaseBytes','manifestBytes'].every(k=>Buffer.isBuffer(candidate[k])),'candidate_bytes');
 const expected=createCareRegisteredCandidate(current,candidate.bundle);
 check(canonical(candidate.manifest)===canonical(expected.manifest)
  &&canonical(candidate.release)===canonical(expected.release)&&candidate.zip.equals(expected.zip)
  &&candidate.releaseBytes.equals(expected.releaseBytes)&&candidate.manifestBytes.equals(expected.manifestBytes),'candidate_binding');
 return {contract:CARE_REGISTERED.contract,byteVerified:true,sourceRebuilt:false,zipSha256:expected.manifest.zipSha256,
  schemaReplayAuthorized:false,releaseAccepted:false,phiAllowed:false};
}
/** Exact immutable storage binding only, not upload or execution authority. */
export function verifyCareRegisteredArtifactBinding(candidate,current,artifact){
 verifyCareRegisteredCandidate(candidate,current);
 check(keys(artifact,['bucket','key','versionId','sha256','bytes','reused','encryption','kmsKeyArn','exactVersionReadbackVerified'])
  &&artifact.bucket===P.bucket&&artifact.key===candidate.manifest.key&&artifact.sha256===candidate.manifest.zipSha256
  &&artifact.bytes===candidate.zip.length&&artifact.exactVersionReadbackVerified===true&&typeof artifact.reused==='boolean'
  &&artifact.encryption==='aws:kms'&&artifact.kmsKeyArn===P.keyArn&&typeof artifact.versionId==='string'
  &&artifact.versionId.length>0&&artifact.versionId.length<=1024&&!/[\u0000-\u0020\u007f]/.test(artifact.versionId)
  &&artifact.versionId!=='null','artifact_binding');
 return structuredClone(artifact);
}
export async function buildCareRegisteredCandidate(root,mobileRoot){
 const current=careRegisteredCurrent(root,mobileRoot),bundle=await buildCareIdentityBundle(root);
 check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(current),'source_changed');
 return createCareRegisteredCandidate(current,bundle);
}
const files=['index.js','candidate.zip','release.json','artifact-manifest.json'];
const limits={'index.js':10*1024*1024,'candidate.zip':11*1024*1024,'release.json':256*1024,'artifact-manifest.json':256*1024};
function bounded(path,max){
 const before=lstatSync(path);check(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=max,'artifact_file');
 const bytes=readFileSync(path),after=lstatSync(path);
 check(after.isFile()&&!after.isSymbolicLink()&&bytes.length===before.size&&bytes.length<=max
  &&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ino===after.ino,'artifact_read');return bytes;
}
export function readCareRegisteredCandidate(directory){
 const root=resolve(directory),stat=lstatSync(root);check(stat.isDirectory()&&!stat.isSymbolicLink(),'artifact_directory');
 check(canonical(readdirSync(root).sort())===canonical([...files].sort()),'artifact_layout');
 let manifest,release,manifestBytes,releaseBytes;const bundle=bounded(resolve(root,'index.js'),limits['index.js']),zip=bounded(resolve(root,'candidate.zip'),limits['candidate.zip']);
 try{manifestBytes=bounded(resolve(root,'artifact-manifest.json'),limits['artifact-manifest.json']);
  releaseBytes=bounded(resolve(root,'release.json'),limits['release.json']);
  manifest=JSON.parse(manifestBytes.toString('utf8'));release=JSON.parse(releaseBytes.toString('utf8'));}
 catch{refuseRegistered('artifact_json');}
 return {manifest,release,bundle,zip,manifestBytes,releaseBytes};
}
/** Actual current clean sources are rebuilt; supplied manifest bytes alone never
 * establish source equivalence. This still makes no live-target observation. */
export async function inspectCareRegisteredArtifact(root,mobileRoot,directory){
 const current=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory);
 const verified=verifyCareRegisteredCandidate(candidate,current),rebuilt=await buildCareIdentityBundle(root);
 check(rebuilt.equals(candidate.bundle),'rebuilt_bundle');
 check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(current),'source_changed');
 return {...verified,sourceRebuilt:true,desktopCommit:current.desktop.commit,mobileCommit:current.mobile.source.commit,
  liveTargetObserved:false,deployed:false,erasureAccepted:false,physicalDeviceAcceptance:false,paidMobileBuildStarted:false};
}
/** Exclusive immutable writes. Retry may fill absent files, never replace one.
 * Run journals must be stored separately, not mixed into this artifact directory. */
export function writeCareRegisteredCandidate(root,candidate){
 verifyCareRegisteredCandidate(candidate,candidate.current);let directory=realpathSync(root);
 for(const part of ['dist','synthetic-care-registered-release',candidate.current.desktop.commit,
  candidate.current.mobile.source.commit,candidate.manifest.zipSha256]){
  directory=resolve(directory,part);
  try{mkdirSync(directory,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}
  const stat=lstatSync(directory);check(stat.isDirectory()&&!stat.isSymbolicLink(),'artifact_directory');
 }
 const bodies=[candidate.bundle,candidate.zip,candidate.releaseBytes,candidate.manifestBytes];
 for(let i=0;i<files.length;i++){
  const file=resolve(directory,files[i]);let fd;
  try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bodies[i]);fsyncSync(fd);}
  catch(error){if(error?.code!=='EEXIST')throw error;check(bounded(file,limits[files[i]]).equals(bodies[i]),'artifact_collision');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 verifyCareRegisteredCandidate(readCareRegisteredCandidate(directory),candidate.current);return directory;
}
