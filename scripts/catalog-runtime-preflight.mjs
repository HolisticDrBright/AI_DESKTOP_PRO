/** Fixed actual predecessor profile, separate from the original registered
 * profile. Raw AWS responses are checked intact. This has no mutation port. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,assertCareRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {CATALOG_RUNTIME as K,catalogRuntimePredecessor,verifyCatalogRuntimeCandidate,verifyCatalogRuntimeArtifactBinding} from './synthetic-catalog-runtime-release.mjs';
import {careRegisteredPredecessorTemplate,verifyRegisteredFunctionProfile,verifyRegisteredControlInventory,
 verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {canonical,CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_preflight_'+code);};
export function catalogRuntimePredecessorTemplate(source){
 const expected=careRegisteredPredecessorTemplate(source);
 expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=K.predecessorVersion;return expected;
}
export function verifyCatalogRuntimePredecessorFunction(fn){
 return verifyRegisteredFunctionProfile(fn,K.predecessorZip,K.predecessorBytes,'$LATEST');
}
export function verifyCatalogRuntimeRecoveryFunction(fn){
 return verifyRegisteredFunctionProfile(fn,C.predecessorZip,C.predecessorBytes,K.recoveryVersion);
}
const parameters=key=>({ClinicalApiId:P.apiId,DatabaseName:P.database,DatabaseClusterArn:P.cluster,DatabaseSecretArn:'****',
  ConsumerUserPoolId:P.consumerPool,ConsumerUserPoolClientId:P.consumerClient,WorkforceUserPoolId:P.workforcePool,
  WorkforceUserPoolClientId:P.workforceClient,ClinicalCoreKeyArn:P.keyArn,LambdaCodeBucket:P.bucket,
  LambdaCodeKey:key});
export function verifyCatalogRuntimePredecessorControl(raw,source){
 return verifyRegisteredControlInventory(raw,source,catalogRuntimePredecessorTemplate(source),parameters(catalogRuntimePredecessor().key),verifyCatalogRuntimePredecessorFunction);
}
export function verifyCatalogRuntimeSuccessorControl(raw,source,candidate,current,artifact,retainedVersion){
 check(retainedVersion===undefined||retainedVersion===K.recoveryVersion,'routing_version');
 verifyCatalogRuntimeArtifactBinding(candidate,current,artifact);
 const expected=catalogRuntimePredecessorTemplate(source);expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=artifact.versionId;
 return verifyRegisteredControlInventory(raw,source,expected,parameters(artifact.key),
  fn=>verifyRegisteredFunctionProfile(fn,candidate.manifest.zipSha256,candidate.zip.length,'$LATEST'),
  retainedVersion?R.latestArn+':'+retainedVersion:R.latestArn);
}
/** Injected ports are fictional tests only. The public observer constructs each
 * port from its own Git/STS/database/S3/Lambda read; no saved report is admitted. */
export async function runCatalogRuntimePreflight(suppliedCandidate,suppliedCurrent,suppliedSource,port){
 // Capture all supplied witnesses before the first asynchronous observation.
 const candidate=structuredClone(suppliedCandidate),current=structuredClone(suppliedCurrent),source=structuredClone(suppliedSource);
 for(const field of ['bundle','zip','releaseBytes','manifestBytes'])candidate[field]=Buffer.from(candidate[field]);
 const sourceText=port.sourceText,started=port.now();assertCareRegisteredCurrent(current);
 verifyCatalogRuntimeCandidate(candidate,current);
 check(sha256(sourceText)===current.templateSha256&&canonical(JSON.parse(sourceText))===canonical(source),'source_template');
 const local=await port.rebuild();
 check(canonical(local)===canonical({...verifyCatalogRuntimeCandidate(candidate,current),sourceRebuilt:true,
  desktopCommit:current.desktop.commit,mobileCommit:current.mobile.source.commit,liveTargetObserved:false,deployed:false,
  erasureAccepted:false,physicalDeviceAcceptance:false,paidMobileBuildStarted:false}),'independent_rebuild');
 const unchanged=async()=>check(canonical(await port.current())===canonical(current),'source_changed');
 await unchanged();const caller=await port.identity();assertSyntheticMemberIdentity(caller);
 const before=verifyCareRegisteredDatabase(await port.database(),current,started,port.now());
 await unchanged();const first=await port.control(),control=verifyCatalogRuntimePredecessorControl(first,source);
 const downloads=await port.downloads(first.fn);
 check(canonical(downloads)===canonical({managedSha256:K.predecessorZip,managedBytes:K.predecessorBytes,
  storedSha256:K.predecessorZip,storedBytes:K.predecessorBytes,version:K.predecessorVersion,
  exactBytesVerified:true,frozenSourceRebuilt:true}),'predecessor_download');
 const retained=await port.retained();
 check(canonical(verifyCatalogRuntimeRecoveryFunction(retained?.configuration))===canonical(verifyCatalogRuntimePredecessorFunction(first.fn))
  &&retained.policy===null&&retained.sha256===C.predecessorZip&&retained.bytes===C.predecessorBytes,'retained');
 const after=verifyCareRegisteredDatabase(await port.database(),current,started,port.now());
 const comparable=r=>{const copy=structuredClone(r);delete copy.observedAt;return copy;};
 check(canonical(comparable(before))===canonical(comparable(after)),'database_changed');
 check(canonical(verifyCatalogRuntimePredecessorControl(await port.control(),source))===canonical(control),'control_changed');
 check(canonical(await port.retained())===canonical(retained),'retained_changed');
 const finalCaller=await port.identity();assertSyntheticMemberIdentity(finalCaller);
 check(canonical(finalCaller)===canonical(caller),'principal_changed');await unchanged();
 return {contract:'synthetic-catalog-runtime-preflight/1',observedAt:new Date(port.now()).toISOString(),current,
  execution:'synthetic-staging',account:P.account,candidateZipSha256:candidate.manifest.zipSha256,
  localArtifact:local,control,databaseBefore:before,databaseAfter:after,predecessorDownload:downloads,
  retained:{version:K.recoveryVersion,sha256:retained.sha256,bytes:retained.bytes,invokePermissionAbsent:true,
   sameArtifactAsLatest:false},
  liveTargetObserved:true,independentSourceRebuildVerified:true,predecessorBytesVerified:true,repeatedReadbackVerified:true,
  reportIsNotAuthority:true,deployAuthorized:false,awsMutationPerformed:false,schemaReplayPerformed:false,
  recoveryRehearsed:false,erasureAccepted:false,hostedAcceptance:false,releaseAccepted:false,physicalDeviceAcceptance:false,
  phiAllowed:false,paidMobileBuildStarted:false};
}
