/** Read-only live reconciliation, never a resumption/unlock/upgrade command.
 * Service and database evidence is collected here, not loaded from a report. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D,verifyDeployedCareArtifact} from './verify-deployed-synthetic-care.mjs';
import {careIntentCurrent,readCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {qualifyCareIntentResumptionSource,qualifyCareIntentPostcommitSource,readHistoricalCareSource,verifyCareHistoricalSnapshot} from './care-intent-resumption-source.mjs';
import {verifyCareIntentResumedDeployment,verifyCareIntentHistoricalDownload} from './care-intent-resumption-deployment.mjs';
import {readCareIntentInterruption} from './care-intent-interruption.mjs';
import {loadCareIntentDatabasePort} from './release-synthetic-care-intent.mjs';
import {verifyCareIntentInspector} from './prepare-synthetic-care-intent-release.mjs';
import {verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {intentAws as aws,observeIntentControlRaw,downloadIntentFunction} from './care-intent-live.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {intentFailureCode} from './upload-synthetic-care-intent-release.mjs';
import {SYNTHETIC_MEMBER_PROFILE as profile,observeSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
import {readCarePostcommitCustody,verifyCareIntentSuccessorInspector} from './care-intent-postcommit.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('reconcile_'+code);};
export function careIntentReconcileArgs(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--candidate'
  &&a[4]==='--reconcile-interrupted-fictional-intent-only'&&!a[1].startsWith('--')&&!a[3].startsWith('--'),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
const template=result=>typeof result.TemplateBody==='string'?JSON.parse(result.TemplateBody):result.TemplateBody;
export async function observeCareIntentResumption(root,mobileRoot,directory){
 return observeCareIntentReconciliation(root,mobileRoot,directory,false);
}
/** Successor-only inspection; it cannot feed the parent-schema release runner. */
export async function observeCareIntentPostcommit(root,mobileRoot,directory){
 return observeCareIntentReconciliation(root,mobileRoot,directory,true);
}
async function observeCareIntentReconciliation(root,mobileRoot,directory,postcommit){
 const started=Date.now(),candidate=readCareIntentCandidate(directory),qualified=postcommit
  ?await qualifyCareIntentPostcommitSource(root,mobileRoot,candidate):await qualifyCareIntentResumptionSource(root,mobileRoot,candidate);
 const {applicationCurrent,operatorCurrent}=qualified;
 const interruption=readCareIntentInterruption(root,directory,applicationCurrent,candidate);
 const custody=postcommit?readCarePostcommitCustody(root,directory,interruption,applicationCurrent):undefined;
 if(custody)verifyCareHistoricalSnapshot(readHistoricalCareSource(mobileRoot,'v2',custody.savedOperatorCurrent.mobile.source.commit),custody.savedOperatorCurrent.mobile.source);
 const unchanged=()=>{
  check(canonical(careIntentCurrent(root,mobileRoot))===canonical(operatorCurrent)
   &&readFileSync(resolve(directory,'candidate.zip')).equals(candidate.zip),'source_drift');
  check(canonical(readCareIntentInterruption(root,directory,applicationCurrent,candidate))===canonical(interruption),'custody_drift');
  if(custody)check(canonical(readCarePostcommitCustody(root,directory,interruption,applicationCurrent))===canonical(custody),'postcommit_custody_drift');
 };
 unchanged();observeSyntheticMemberIdentity();
 const sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'),source=JSON.parse(sourceText);
 const schema=loadCareIntentDatabasePort(root,operatorCurrent),inspect=async()=>postcommit
  ?verifyCareIntentSuccessorInspector(await schema('inspect'),operatorCurrent):verifyCareIntentInspector(await schema('inspect'),operatorCurrent),
  baseline=await inspect();
 unchanged();const first=observeIntentControlRaw();
 check(first.template?.Resources?.IdentityApiFunction?.Properties?.Code?.S3ObjectVersion===interruption.artifactVersion,'code_version_locator');
 const previousDir=resolve(root,'dist/synthetic-care-release',D.desktop,D.mobile),previous={
  manifest:JSON.parse(readFileSync(resolve(previousDir,'artifact-manifest.json'),'utf8')),
  release:JSON.parse(readFileSync(resolve(previousDir,'release.json'),'utf8')),
  bundle:readFileSync(resolve(previousDir,'index.js')),zip:readFileSync(resolve(previousDir,'candidate.zip'))};
 verifyDeployedCareArtifact(previous.manifest,previous.release,previous.bundle,previous.zip);
 const oldConfiguration=aws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier','1']);
 const predecessor={configuration:oldConfiguration,download:verifyCareIntentHistoricalDownload(await downloadIntentFunction(oldConfiguration,previous))};
 const configuration=aws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier',interruption.retainedVersion]);
 const retained={configuration,codeBytes:await downloadIntentFunction(configuration,candidate)};
 const codeBytes=await downloadIntentFunction(first.fn,candidate);
 const s3=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1});
 let artifact;
 try{
  const input={Bucket:P.bucket,ExpectedBucketOwner:P.account,Key:candidate.manifest.key,VersionId:interruption.artifactVersion,ChecksumMode:'ENABLED'};
  verifyCareStoredArtifact(await s3.send(new HeadObjectCommand(input),{abortSignal:AbortSignal.timeout(30000)}),candidate.manifest,interruption.artifactVersion);
  const signal=AbortSignal.timeout(30000),object=await s3.send(new GetObjectCommand(input),{abortSignal:signal});
  try{verifyCareStoredArtifact(object,candidate.manifest,interruption.artifactVersion);}catch(e){object.Body?.destroy?.();throw e;}
  check((await readCareArtifact(object.Body,candidate.manifest,signal)).equals(candidate.zip),'s3_bytes');
  artifact={bucket:P.bucket,key:candidate.manifest.key,versionId:interruption.artifactVersion,sha256:candidate.manifest.zipSha256,
   bytes:candidate.zip.length,encryption:'aws:kms',kmsKeyArn:P.keyArn,exactVersionReadbackVerified:true};
 }finally{s3.destroy();}
 const {binding}=interruption;
 const views=()=>({summary:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--no-include-property-values','--no-paginate']),
  detailed:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--include-property-values','--no-paginate']),
  proposedTemplate:template(aws(['cloudformation','get-template','--stack-name',binding.stackId,'--change-set-name',binding.id,'--template-stage','Original']))});
 const projection=views(),policy=()=>aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier',interruption.retainedVersion],interruption.retainedVersion);
 const w={contract:'synthetic-care-intent-resumption-observations/1',observedAt:new Date().toISOString(),applicationCurrent,operatorCurrent,
  source,sourceText,raw:first,predecessor,retained,artifact,binding,...projection,codeBytes,retainedPolicy:policy()};
 const deployed=verifyCareIntentResumedDeployment(w,candidate,applicationCurrent,operatorCurrent,started,Date.now());
 unchanged();const after=await inspect();
 check(canonical(after)===canonical(baseline),'database_drift');
 const returnedRaw=observeIntentControlRaw(),returnedViews=views();
 check(canonical(returnedViews)===canonical(projection),'execution_drift');
 const returned={...w,raw:returnedRaw,...returnedViews,retainedPolicy:policy(),observedAt:new Date().toISOString()};
 const final=verifyCareIntentResumedDeployment(returned,candidate,applicationCurrent,operatorCurrent,started,Date.now());
 check(canonical(final.latest)===canonical(deployed.latest)&&canonical(final.control)===canonical(deployed.control)
  &&canonical(final.transport)===canonical(deployed.transport),'live_drift');
 unchanged();
 const result={contract:postcommit?'synthetic-care-intent-postcommit-reconciliation/1':'synthetic-care-intent-live-reconciliation/1',observedAt:final.observedAt,
  applicationCurrent,operatorCurrent,sourceRepresentations:qualified.sourceRepresentations,runtime:qualified.runtime,
  interruption,execution:'synthetic-staging',account:P.account,zipSha256:candidate.manifest.zipSha256,
  deployedDownloadSha256:sha256(codeBytes),retainedDownloadSha256:sha256(retained.codeBytes),predecessorDownload:predecessor.download,
  revision:final.latest.RevisionId,retainedVersion:retained.configuration.Version,artifact,projections:final.projections,
  control:final.control,transport:final.transport,databaseBefore:baseline,databaseAfter:after,reportIsNotAuthority:true,
  deploymentReconciled:true,sourceQualified:true,custodyAcquired:false,awsMutationPerformed:false,
  compatibleRecoveryVerified:false,schemaChanged:false,canonicalRegistered:false,hostedAcceptance:false,
  physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
 if(postcommit){
  result.postcommitCustody=custody;result.successorReconciled=true;result.custodySettled=false;
  result.currentRecoveryAcceptance=false;result.replayAuthorized=false;
  // No transport/schema mutation port escapes the read-only successor profile.
  return {result};
 }
 return {result,candidate,qualified,interruption,deployment:returned,baseline,schema,unchanged,started};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careIntentReconcileArgs(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>observeCareIntentResumption(process.cwd(),mobileRoot,directory))
  .then(({result})=>console.log(JSON.stringify(result)))
  .catch(e=>{console.error(intentFailureCode(e));process.exitCode=1;});
}
