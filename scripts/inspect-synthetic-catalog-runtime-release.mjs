/** Actual read-only observer, fixed synthetic target only. Input paths select
 * sources/artifacts, never accounts, destinations, profiles or approval flags. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {CATALOG_RUNTIME as K,catalogRuntimePredecessor,verifyCatalogRuntimeFrozenSources,
 verifyCatalogRuntimeCandidate,inspectCatalogRuntimeArtifact} from './synthetic-catalog-runtime-release.mjs';
import {CARE_REGISTERED as C,careRegisteredCurrent,readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {runCatalogRuntimePreflight} from './catalog-runtime-preflight.mjs';
import {buildCareRegisteredDatabaseObserver,readCareRegisteredPredecessor,runCareRegisteredInspectorChild,
 registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {intentAws,observeIntentControlRaw,downloadIntentFunction} from './care-intent-live.mjs';
import {verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_inspect_'+code);};
export function catalogRuntimeInspectArguments(args){
 const names=['--v2-root','--artifact','--custody-root','--deployed-desktop-root','--deployed-v2-root'];
 check(args.length===11&&args[10]==='--inspect-fictional-catalog-runtime-only'
  &&names.every((n,i)=>args[i*2]===n&&typeof args[i*2+1]==='string'&&args[i*2+1].trim().length>0
   &&!args[i*2+1].startsWith('--')),'arguments');
 return Object.fromEntries(['mobileRoot','directory','custodyRoot','frozenDesktopRoot','frozenMobileRoot'].map((n,i)=>[n,resolve(args[i*2+1])]));
}
export function catalogRuntimeObservationEnvironment(env){
 check(!Object.entries(env).some(([key,value])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(key)&&value),'endpoint_override');
}
/** Original immutable metadata is verified by its original clean source and
 * independently rebuilt there. It is never rebased to the new three-row ledger. */
export function inspectCatalogRuntimePredecessorSources(custodyRoot,frozenDesktopRoot,frozenMobileRoot){
 verifyCatalogRuntimeFrozenSources(frozenDesktopRoot,frozenMobileRoot);
 const p=catalogRuntimePredecessor(),directory=resolve(custodyRoot,'dist/synthetic-care-registered-release',
  p.desktop,p.mobile,p.zipSha256),candidate=readCareRegisteredCandidate(directory);
 check(candidate.manifest.desktop.commit===p.desktop&&candidate.manifest.mobile.source.commit===p.mobile
  &&candidate.manifest.zipSha256===p.zipSha256&&candidate.manifest.zipBytes===p.bytes
  &&candidate.manifest.key===p.key&&candidate.zip.length===p.bytes&&sha256(candidate.zip)===p.zipSha256,'predecessor_artifact');
 const result=JSON.parse(runCareRegisteredInspectorChild(frozenDesktopRoot,
  [resolve(frozenDesktopRoot,'scripts/inspect-synthetic-care-registered-artifact.mjs'),
   '--v2-root',frozenMobileRoot,'--artifact',directory]));
 check(result.contract===C.contract&&result.byteVerified===true&&result.sourceRebuilt===true
  &&result.zipSha256===p.zipSha256&&result.desktopCommit===p.desktop&&result.mobileCommit===p.mobile
  &&result.liveTargetObserved===false&&result.deployed===false&&result.phiAllowed===false,'frozen_rebuild');
 verifyCatalogRuntimeFrozenSources(frozenDesktopRoot,frozenMobileRoot);return candidate;
}
export async function observeCatalogRuntimePreflight(root,options){
 const {mobileRoot,directory,custodyRoot,frozenDesktopRoot,frozenMobileRoot}=options;
 catalogRuntimeObservationEnvironment(process.env);
 process.env.AWS_MAX_ATTEMPTS='1';process.env.AWS_RETRY_MODE='standard';process.env.AWS_PAGER='';
 const current=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory);
 verifyCatalogRuntimeCandidate(candidate,current);
 const local=await inspectCatalogRuntimeArtifact(root,mobileRoot,directory);
 const predecessor=inspectCatalogRuntimePredecessorSources(custodyRoot,frozenDesktopRoot,frozenMobileRoot),
  recovery=readCareRegisteredPredecessor(custodyRoot);
 observeSyntheticMemberIdentity();
 const database=buildCareRegisteredDatabaseObserver(root,current),
  sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json');
 const s3=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1});
 try{return await runCatalogRuntimePreflight(candidate,current,JSON.parse(sourceText),{
  sourceText,now:Date.now,rebuild:async()=>local,
  current:async()=>{
   catalogRuntimeObservationEnvironment(process.env);verifyCatalogRuntimeFrozenSources(frozenDesktopRoot,frozenMobileRoot);
   const fresh=careRegisteredCurrent(root,mobileRoot),reread=readCareRegisteredCandidate(directory),
    old=readCareRegisteredCandidate(resolve(custodyRoot,'dist/synthetic-care-registered-release',K.predecessorDesktop,K.predecessorMobile,K.predecessorZip)),
    retained=readCareRegisteredPredecessor(custodyRoot);
   for(const [a,b] of [[reread,candidate],[old,predecessor],[retained,recovery]]){
    for(const key of ['bundle','zip'])check(a[key].equals(b[key]),'artifact_changed');
    for(const key of ['releaseBytes','manifestBytes'])if(Buffer.isBuffer(b[key]))check(a[key].equals(b[key]),'artifact_changed');
    check(canonical(a.release)===canonical(b.release)&&canonical(a.manifest)===canonical(b.manifest),'artifact_changed');
   }
   check(reread.releaseBytes.equals(candidate.releaseBytes)&&reread.manifestBytes.equals(candidate.manifestBytes),'artifact_changed');return fresh;
  },identity:async()=>observeSyntheticMemberIdentity(),database,control:async()=>observeIntentControlRaw(),
  downloads:async fn=>{
   const managed=await downloadIntentFunction(fn,predecessor),input={Bucket:P.bucket,ExpectedBucketOwner:P.account,
    Key:predecessor.manifest.key,VersionId:K.predecessorVersion,ChecksumMode:'ENABLED'};
   verifyCareStoredArtifact(await s3.send(new HeadObjectCommand(input),{abortSignal:AbortSignal.timeout(30000)}),predecessor.manifest,K.predecessorVersion);
   const signal=AbortSignal.timeout(30000),remote=await s3.send(new GetObjectCommand(input),{abortSignal:signal});
   try{verifyCareStoredArtifact(remote,predecessor.manifest,K.predecessorVersion);}catch(error){remote.Body?.destroy?.();throw error;}
   const stored=await readCareArtifact(remote.Body,predecessor.manifest,signal);check(stored.equals(predecessor.zip),'predecessor_s3_bytes');
   return {managedSha256:sha256(managed),managedBytes:managed.length,storedSha256:sha256(stored),storedBytes:stored.length,
    version:K.predecessorVersion,exactBytesVerified:true,frozenSourceRebuilt:true};
  },retained:async()=>{
   const configuration=intentAws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier',K.recoveryVersion]),
    bytes=await downloadIntentFunction(configuration,recovery),
    policy=intentAws(['lambda','get-policy','--function-name',P.functionName,'--qualifier',K.recoveryVersion],K.recoveryVersion);
   return {configuration,sha256:sha256(bytes),bytes:bytes.length,policy};
  }
 });}finally{s3.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>catalogRuntimeInspectArguments(process.argv.slice(2)))
  .then(options=>observeCatalogRuntimePreflight(process.cwd(),options)).then(r=>console.log(JSON.stringify(r)))
  .catch(error=>{console.error(registeredPreflightFailureCode(error));process.exitCode=1;});
}
