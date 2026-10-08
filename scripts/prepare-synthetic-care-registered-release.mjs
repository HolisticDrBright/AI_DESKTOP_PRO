/** Actual fixed-target registered preflight. No report-loading, deployment,
 * target/profile override or write/activation mode is exposed. */
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,careRegisteredCurrent,readCareRegisteredCandidate,inspectCareRegisteredArtifact,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCareIntentCandidate} from './synthetic-care-intent-release.mjs';
import {CARE_REGISTERED_PREDECESSOR,runCareRegisteredPreflight} from './care-registered-preflight.mjs';
import {intentAws,observeIntentControlRaw,downloadIntentFunction} from './care-intent-live.mjs';
import {verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('preflight_'+code);};
export function careRegisteredPreflightArguments(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--inspect-fictional-current-release-only'
  &&[a[1],a[3]].every(v=>typeof v==='string'&&v.trim().length>0&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
const bounded=(path,max)=>{
 const first=lstatSync(path);check(first.isFile()&&!first.isSymbolicLink()&&first.size>0&&first.size<=max,'predecessor_file');
 const bytes=readFileSync(path),after=lstatSync(path);
 check(after.isFile()&&!after.isSymbolicLink()&&first.ino===after.ino&&first.size===after.size
  &&first.mtimeMs===after.mtimeMs&&bytes.length===first.size,'predecessor_read');return bytes;
};
/** Only the previously deployed, pinned immutable ZIP is admitted. Its
 * embedded historical source remains historical, never current approval. */
export function readCareRegisteredPredecessor(root){
 const directory=resolve(root,'dist/synthetic-care-intent-release',C.predecessorDesktop,C.predecessorMobile),s=lstatSync(directory);
 check(s.isDirectory()&&!s.isSymbolicLink(),'predecessor_directory');
 const manifest=JSON.parse(bounded(resolve(directory,'artifact-manifest.json'),256*1024).toString('utf8')),
  release=JSON.parse(bounded(resolve(directory,'release.json'),256*1024).toString('utf8')),
  bundle=bounded(resolve(directory,'index.js'),10*1024*1024),zip=bounded(resolve(directory,'candidate.zip'),11*1024*1024);
 const old={desktop:release.desktop,mobile:release.mobile,migrations:release.migrations,templateSha256:release.templateSha256};
 verifyCareIntentCandidate(manifest,release,bundle,zip,old);
 check(manifest.desktop.commit===C.predecessorDesktop&&manifest.mobile.source.commit===C.predecessorMobile
  &&manifest.zipSha256===C.predecessorZip&&manifest.zipBytes===C.predecessorBytes&&zip.length===C.predecessorBytes
  &&sha256(zip)===C.predecessorZip
  &&manifest.key===`clinical-core/authenticated-api/care-intent-release/${C.predecessorDesktop}/${C.predecessorZip}.zip`,'predecessor_artifact');
 return {manifest,release,bundle,zip};
}
const inspectorCodes=new Set(['care_canonical_registration_boundary_refused','care_canonical_registration_observation_changed',
 'care_canonical_registration_failed','artifact_refused','history_refused','boundary_refused','inventory_refused',
 'verification_failed','upgrade_failed']);
const inspectorPhases=new Set(['begin','statement','commit','rollback','unknown']);
const inspectorReasons=new Set(['database_resuming','database_unavailable','access_denied','token_expired','credentials_unavailable',
 'timeout','aborted','transaction_missing','statement_timeout','service_unavailable','transport_type_error','connection_reset','unknown']);
/** Process output is not trusted as a message. Only the inspector's finite
 * machine vocabulary is retained; stdout, stack, SQL and arbitrary stderr are
 * never rendered. A timeout/output bound takes precedence over partial output.
 * This diagnostic is not evidence that the failed inspection completed. */
export function careRegisteredInspectorDiagnostic(error,phase){
 check(phase==='build'||phase==='inspect','inspector_phase');
 const e=error&&typeof error==='object'?error:{};
 if(e.code==='ETIMEDOUT')return 'timeout';
 if(e.code==='ENOBUFS')return 'output_limit';
 if(e.signal)return 'terminated';
 if(phase!=='inspect'||!Number.isInteger(e.status)||e.status<1||e.status>255)return 'unknown';
 const bytes=typeof e.stderr==='string'?Buffer.from(e.stderr):Buffer.isBuffer(e.stderr)?e.stderr:undefined;
 if(!bytes||bytes.length===0||bytes.length>256)return 'unknown';
 const text=bytes.toString('utf8').replace(/\r?\n$/,'');
 const [code,transport,...extra]=text.split(':');
 if(extra.length||!inspectorCodes.has(code))return 'unknown';
 if(transport===undefined)return code;
 const transportPhase=[...inspectorPhases].find(p=>transport.startsWith(p+'_'));
 if(!transportPhase||!inspectorReasons.has(transport.slice(transportPhase.length+1)))return 'unknown';
 return code+'_'+transport;
}
export function runCareRegisteredInspectorChild(root,args,phase='inspect',timeout=180000){
 check((phase==='build'||phase==='inspect')&&Number.isInteger(timeout)&&timeout>=10&&timeout<=180000,'inspector_arguments');
 try{return execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout,maxBuffer:2*1024*1024,
  windowsHide:true,stdio:['ignore','pipe','pipe']});}
 catch(error){refuseRegistered('preflight_inspector_'+phase+'_failed_'+careRegisteredInspectorDiagnostic(error,phase));}
}
export function buildCareRegisteredDatabaseObserver(root,current){
 const build=JSON.parse(runCareRegisteredInspectorChild(root,[resolve(root,'scripts/build-care-intent-canonical-inspector.mjs')],'build'));
 const directory=resolve(root,'dist/aws-clinical-core/care-intent-canonical-inspector'),file=resolve(directory,'index.cjs');
 const verify=()=>{
  const saved=JSON.parse(bounded(resolve(directory,'artifact-manifest.json'),256*1024).toString('utf8'));
  check(canonical(saved)===canonical(build)&&build.contract==='care-intent-canonical-inspector-build/1'
   &&build.sourceCommit===current.desktop.commit&&build.clean===true&&canonical(build.mapping)===canonical(current.migrations)
   &&build.inspectionOnly===true&&build.schemaReplayAvailable===false&&build.ledgerRewriteAvailable===false
   &&build.releaseAccepted===false&&build.phiAllowed===false&&sha256(bounded(file,10*1024*1024))===build.sha256,'inspector_build');
 };verify();
 return async()=>{verify();const r=JSON.parse(runCareRegisteredInspectorChild(root,[file,'inspect']));verify();return r;};
}
export async function observeCareRegisteredPreflight(root,mobileRoot,directory){
 const current=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(directory),
  sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'),source=JSON.parse(sourceText);
 // Both independent rebuilding and principal validation happen before reading
 // predecessor storage/database. A dirty candidate never reaches an AWS client.
 const local=await inspectCareRegisteredArtifact(root,mobileRoot,directory);
 observeSyntheticMemberIdentity();
 const predecessor=readCareRegisteredPredecessor(root),database=buildCareRegisteredDatabaseObserver(root,current);
 const s3=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1});
 try{return await runCareRegisteredPreflight(candidate,current,source,{
  sourceText,now:Date.now,rebuild:async()=>local,
  current:async()=>{
   const fresh=careRegisteredCurrent(root,mobileRoot),reread=readCareRegisteredCandidate(directory);
   check(reread.zip.equals(candidate.zip)&&reread.bundle.equals(candidate.bundle)
    &&reread.releaseBytes.equals(candidate.releaseBytes)&&reread.manifestBytes.equals(candidate.manifestBytes),'artifact_changed');return fresh;
  },identity:async()=>observeSyntheticMemberIdentity(),database,control:async()=>observeIntentControlRaw(),
  downloads:async fn=>{
   const managed=await downloadIntentFunction(fn,predecessor),input={Bucket:P.bucket,ExpectedBucketOwner:P.account,
    Key:predecessor.manifest.key,VersionId:C.predecessorVersion,ChecksumMode:'ENABLED'};
   verifyCareStoredArtifact(await s3.send(new HeadObjectCommand(input),{abortSignal:AbortSignal.timeout(30000)}),predecessor.manifest,C.predecessorVersion);
   const signal=AbortSignal.timeout(30000),remote=await s3.send(new GetObjectCommand(input),{abortSignal:signal});
   try{verifyCareStoredArtifact(remote,predecessor.manifest,C.predecessorVersion);}catch(error){remote.Body?.destroy?.();throw error;}
   const stored=await readCareArtifact(remote.Body,predecessor.manifest,signal);check(stored.equals(predecessor.zip),'predecessor_s3_bytes');
   return {managedSha256:sha256(managed),managedBytes:managed.length,storedSha256:sha256(stored),storedBytes:stored.length,
    version:C.predecessorVersion,exactBytesVerified:true};
  },retained:async()=>{
   const version=CARE_REGISTERED_PREDECESSOR.retainedVersion,
    configuration=intentAws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier',version]),
    bytes=await downloadIntentFunction(configuration,predecessor),
    policy=intentAws(['lambda','get-policy','--function-name',P.functionName,'--qualifier',version],version);
   return {configuration,sha256:sha256(bytes),bytes:bytes.length,policy};
  }
 });}finally{s3.destroy();}
}
export function registeredPreflightFailureCode(error){
 const message=error instanceof Error?error.message:'';
 return /^(?:synthetic_care_(?:registered_release|intent_release|release)_refused:[a-z0-9_]{1,180}|synthetic_member_principal_refused)$/.test(message)
  ?message:'synthetic_care_registered_release_refused:preflight_failed';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careRegisteredPreflightArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>observeCareRegisteredPreflight(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r)))
  .catch(error=>{console.error(registeredPreflightFailureCode(error));process.exitCode=1;});
}
