/** Fictional observations only. Public commands must construct real observers. */
import {CARE_RELEASE as P} from '../synthetic-care-release.mjs';
import {CARE_REGISTERED as C} from '../synthetic-care-registered-release.mjs';
import {CATALOG_RUNTIME as K,createCatalogRuntimeCandidate,verifyCatalogRuntimeCandidate,catalogRuntimePredecessor} from '../synthetic-catalog-runtime-release.mjs';
import {catalogRuntimePredecessorTemplate,verifyCatalogRuntimePredecessorControl} from '../catalog-runtime-preflight.mjs';
import {careRegisteredControlFixture} from './care-registered-control.mjs';
import {careRegisteredDatabaseFixture} from './care-registered-database.mjs';
export function catalogRuntimeControlFixture(){
 const f=careRegisteredControlFixture();f.candidate=createCatalogRuntimeCandidate(f.current,f.candidate.bundle);
 f.raw.template=catalogRuntimePredecessorTemplate(f.source);
 f.raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=catalogRuntimePredecessor().key;
 f.raw.fn.CodeSha256=Buffer.from(K.predecessorZip,'hex').toString('base64');f.raw.fn.CodeSize=K.predecessorBytes;
 f.artifact={bucket:P.bucket,key:f.candidate.manifest.key,versionId:'fictional-catalog-version',sha256:f.candidate.manifest.zipSha256,
  bytes:f.candidate.zip.length,reused:false,encryption:'aws:kms',kmsKeyArn:P.keyArn,exactVersionReadbackVerified:true};
 const database=careRegisteredDatabaseFixture(f.current,f.now);
 f.preflight={contract:'synthetic-catalog-runtime-preflight/1',observedAt:new Date(f.now).toISOString(),current:structuredClone(f.current),
  execution:'synthetic-staging',account:P.account,candidateZipSha256:f.candidate.manifest.zipSha256,
  localArtifact:{...verifyCatalogRuntimeCandidate(f.candidate,f.current),sourceRebuilt:true,
   desktopCommit:f.current.desktop.commit,mobileCommit:f.current.mobile.source.commit,liveTargetObserved:false,deployed:false,
   erasureAccepted:false,physicalDeviceAcceptance:false,paidMobileBuildStarted:false},
  control:verifyCatalogRuntimePredecessorControl(f.raw,f.source),databaseBefore:structuredClone(database),databaseAfter:structuredClone(database),
  predecessorDownload:{managedSha256:K.predecessorZip,managedBytes:K.predecessorBytes,storedSha256:K.predecessorZip,
   storedBytes:K.predecessorBytes,version:K.predecessorVersion,exactBytesVerified:true,frozenSourceRebuilt:true},
  retained:{version:'2',sha256:C.predecessorZip,bytes:C.predecessorBytes,invokePermissionAbsent:true,sameArtifactAsLatest:false},
  liveTargetObserved:true,independentSourceRebuildVerified:true,predecessorBytesVerified:true,repeatedReadbackVerified:true,reportIsNotAuthority:true,
  ...Object.fromEntries(['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance',
   'releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].map(k=>[k,false]))};
 return f;
}
