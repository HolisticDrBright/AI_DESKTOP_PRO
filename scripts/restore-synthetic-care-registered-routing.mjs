/** Compensating routing only, under the original stopped release custody.
 * This cannot replay execution, grant a permission or qualify recovery. */
import {execFileSync} from 'node:child_process';
import {openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,assertCareRegisteredCurrent,readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryStage,verifyRecoveryIntegration} from './care-recovery-routing.mjs';
import {verifyCareRegisteredRestorationDeployment} from './care-registered-deployment.mjs';
import {verifyCareRegisteredFunction,verifyCareRegisteredSuccessorFunction} from './care-registered-preflight.mjs';
import {verifyIntentRecoveryPolicy} from './care-intent-routing.mjs';
import {verifyInterruptedRegisteredReleaseCustody,createRegisteredRestorationObservers,readRegisteredReleaseBounded as bounded,
 registeredReleaseDirectory,readRegisteredReleaseEvidence} from './reconcile-synthetic-care-registered-release.mjs';
import {stoppedUploadWriter} from './reconcile-synthetic-care-registered-upload.mjs';
import {acquireRecoverableRegisteredInspectionGuard} from './care-registered-restoration-guard.mjs';
import {assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('stopped_restoration_'+c);};
const equal=(a,b)=>canonical(a)===canonical(b);
const inventory=v=>{const c=structuredClone(v);delete c.observedAt;return c;};
const retainedBytes=v=>{const c=structuredClone(v);delete c.policy;return c;};
export function registeredRoutingRestorationArguments(a){
 check(a.length===7&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--application-root'
  &&a[6]==='--restore-fictional-registered-routing-only'
  &&[a[1],a[3],a[5]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3]),applicationRoot:resolve(a[5])};
}
/** Ports exist only for deterministic negative tests. The public command below
 * constructs all observations itself, not from caller-supplied reports. */
export async function runRegisteredRoutingRestoration(candidate,operator,c,sourceText,d){
 assertCareRegisteredCurrent(operator);const started=d.now(),saved=await verifyInterruptedRegisteredReleaseCustody(c,candidate,sourceText,started,d.evidence);
 check(saved.scope==='execution'&&saved.sid,'no_recovery_admission');
 return runRegisteredRoutingCompensation(candidate,operator,c,sourceText,d,saved,started);
}
/** Internal shared compensation after a profile-specific custody verifier.
 * Public commands must construct saved from their exact journal, not a report.
 * Ports exist for negative tests; none can grant or replay a deployment. */
export async function runRegisteredRoutingCompensation(candidate,operator,c,sourceText,d,saved,started=d.now()){
 assertCareRegisteredCurrent(operator);
 check(Number.isSafeInteger(d.pid)&&d.pid>0,'operator_pid');
 check(saved.scope==='execution','no_execution_admission');
 check(equal(operator.mobile,saved.current.mobile)&&equal(operator.migrations,saved.current.migrations)
  &&operator.templateSha256===saved.current.templateSha256,'operator_binding');
 if(saved.restoration)check(equal(saved.restoration.operatorSource,operator),'restoration_operator_changed');
 const caller=await d.identity();assertSyntheticMemberIdentity(caller);let journalBytes=Buffer.from(c.journalBytes);
 const guard=async()=>{
  check(equal(await d.current(),operator)&&equal(await d.applicationCurrent(),saved.current),'source_changed');
  check(await d.writerStopped(saved.lock.pid)===true,'writer_active');
  if(saved.restoration)check(started-saved.restoration.lastAt>=60000&&await d.writerStopped(saved.restoration.pid)===true,'restoration_writer_active');
  const actual=await d.custody();check(actual.lockBytes.equals(c.lockBytes)&&actual.journalBytes.equals(journalBytes),'custody_changed');
  for(const e of saved.evidenceReferences)check(sha256(await d.evidence(e.file,e.kind))===e.sha256,'evidence_changed');
  const identity=await d.identity();assertSyntheticMemberIdentity(identity);check(equal(identity,caller),'principal_changed');
 };
 await guard();const rebuilt=await d.rebuild();
 check(rebuilt?.byteVerified===true&&rebuilt.sourceRebuilt===true&&rebuilt.zipSha256===candidate.manifest.zipSha256
  &&rebuilt.desktopCommit===saved.current.desktop.commit&&rebuilt.mobileCommit===saved.current.mobile.source.commit
  &&rebuilt.liveTargetObserved===false&&rebuilt.deployed===false&&rebuilt.phiAllowed===false,'source_rebuild');
 const deployed=saved.events.find(e=>e.stage==='registered_deployed_bytes_control_verified');check(deployed,'missing_successor_admission');
 const observe=async()=>{
  await guard();const database=await d.database(),raw=await d.control(),views=await d.proposal(saved.binding),
   codeBytes=await d.latest(raw.fn),retained=await d.retained(),policy=await d.retainedPolicy(),storage=await d.storage();
  const uri=raw.integrations?.Items?.find(v=>v.IntegrationId===R.integrationId)?.IntegrationUri;
  check([R.latestArn,R.latestArn+':2'].includes(uri),'foreign_routing');
  const witness={contract:'synthetic-care-registered-deployment-observation/1',current:saved.current,artifact:saved.artifact,
   executionAdmittedAt:saved.execute.at,before:saved.before,after:{observedAt:new Date(d.now()).toISOString(),raw,database,...views},codeBytes};
  const deployment=verifyCareRegisteredRestorationDeployment(witness,candidate,saved.current,sourceText,saved.artifact,operator,started,d.now(),uri===R.latestArn?undefined:'2');
  check(raw.fn.RevisionId===deployed.revision,'successor_revision_changed');
  check(equal(policy,retained.policy),'permission_changed_during_observation');
  if(policy!==null)verifyIntentRecoveryPolicy(policy,saved.sid,'2',true);
  else check(uri===R.latestArn,'retained_without_permission');
  check(retained.sha256===candidate.release.predecessor.zipSha256&&retained.bytes===candidate.release.predecessor.bytes
   &&equal(verifyCareRegisteredFunction(retained.configuration,true),verifyCareRegisteredSuccessorFunction(raw.fn,candidate,saved.current)),'retained_binding');
  check(storage?.state==='stored_exact_version'&&storage.bytesVerified===true&&storage.versionId===saved.artifact.versionId
   &&storage.sha256===candidate.manifest.zipSha256&&storage.bytes===candidate.manifest.zipBytes&&storage.deletionCertified===false,'storage_binding');
  verifyRecoveryStage(raw.stage);const apiDeployment=await d.apiDeployment(raw.stage.DeploymentId);
  check(apiDeployment?.DeploymentId===raw.stage.DeploymentId&&apiDeployment.DeploymentStatus==='DEPLOYED','api_deployment');
  await guard();return {database,raw,deployment,retained,policy,storage,apiDeployment,uri};
 };
 const same=(a,b,routeChange=false,permissionChange=false)=>{
  check(equal(inventory(a.database),inventory(b.database))&&equal(a.raw.fn,b.raw.fn)&&equal(a.storage,b.storage)
   &&equal(retainedBytes(a.retained),retainedBytes(b.retained)),'state_changed');
  for(const k of ['functionConfigurationSha256','resourcesSha256','templateSha256','parametersSha256','routesSha256',
   'authorizersSha256','policySha256','roleSha256','identityRouteCount','apiRouteCount'])check(a.deployment.control[k]===b.deployment.control[k],'authority_changed');
  if(!routeChange)check(a.uri===b.uri&&equal(a.apiDeployment,b.apiDeployment),'routing_changed');
  if(!permissionChange)check(equal(a.policy,b.policy),'permission_changed');
 };
 const initial=await observe(),confirmed=await observe();same(initial,confirmed);
 // Completed test custody admits observations only. Refuse drift before even
 // appending a compensating admission, preserving its read-only journal grammar.
 if(saved.readOnlyCompletion)check(initial.uri===R.latestArn&&initial.policy===null,'completed_readonly_drift');
 const append=async(stage,detail={})=>{
  await guard();const e={at:new Date(d.now()).toISOString(),stage,...detail},expected=Buffer.concat([journalBytes,Buffer.from(JSON.stringify(e)+'\n')]);
  const actual=await d.record(e);check(Buffer.isBuffer(actual)&&actual.equals(expected),'admission_durability');journalBytes=expected;await guard();return e;
 };
 let returnAdmission=saved.restoration?.returnAdmission,permissionAdmission=saved.restoration?.permissionAdmission,mutated=false;
 if(!saved.restoration)await append('registered_stopped_restoration_started',{
  originalJournalSha256:saved.journalSha256,operatorSource:operator,pid:d.pid});
 let actual=await observe();same(initial,actual);
 if(returnAdmission){
  // A lost response admits observation only. No second update is issued.
  await d.waitLatest(returnAdmission.previousDeployment);actual=await observe();same(initial,actual,true);
 }else if(actual.uri!==R.latestArn){
  check(!saved.readOnlyCompletion,'completed_readonly_drift');
  returnAdmission=await append('registered_stopped_return_admitted',{previousDeployment:actual.raw.stage.DeploymentId});
  mutated=true;try{await d.returnLatest();}catch{/* outcome unknown: observe, never replay */}
  await d.waitLatest(returnAdmission.previousDeployment);actual=await observe();same(initial,actual,true);
 }
 check(actual.uri===R.latestArn&&(!returnAdmission||actual.raw.stage.DeploymentId!==returnAdmission.previousDeployment),'return_unconfirmed');
 if(permissionAdmission){
  // Unknown removal is not permission to retry against a newer revision.
  check(actual.policy===null,'prior_removal_unconfirmed');
 }else if(actual.policy!==null){
  check(!saved.readOnlyCompletion,'completed_readonly_drift');
  verifyIntentRecoveryPolicy(actual.policy,saved.sid,'2',true);
  permissionAdmission=await append('registered_stopped_permission_remove_admitted',{revision:actual.policy.RevisionId});
  mutated=true;try{await d.removePermission(saved.sid,permissionAdmission.revision);}catch{/* observe exact absence below */}
 }
 const first=await observe(),second=await observe();same(initial,first,Boolean(returnAdmission),Boolean(permissionAdmission));same(first,second);
 check(second.uri===R.latestArn&&second.policy===null,'restoration_unconfirmed');
 if(returnAdmission)check(second.raw.stage.DeploymentId!==returnAdmission.previousDeployment,'return_unconfirmed');
 if(!saved.restoration?.observed)await append('registered_stopped_restoration_observed',{
  controlSha256:sha256(canonical(second.deployment.control)),databaseSha256:sha256(canonical(inventory(second.database)))});
 await guard();return {contract:'synthetic-care-registered-routing-restoration/1',execution:'synthetic-staging',account:P.account,region:P.region,
  runId:saved.lock.runId,applicationSource:saved.current,operatorSource:operator,journalSha256:sha256(journalBytes),
  originalJournalSha256:saved.originalJournalSha256??saved.journalSha256,originalRunOutcome:saved.originalRunOutcome,originalFailure:saved.originalFailure,
  observedAt:new Date(d.now()).toISOString(),writerStopped:true,applicationSourceRebuilt:true,repeatedReadbackVerified:true,
  deployment:second.deployment,databaseBefore:initial.database,databaseAfter:second.database,storage:second.storage,retained:second.retained,
  apiDeployment:second.apiDeployment,exactBytesVerified:true,databasePreserved:true,routeRestoredAtObservation:true,
  temporaryPermissionAbsentAtObservation:true,restorationVerified:true,awsMutationPerformed:mutated,
  originalExecutionReplyConfirmed:false,retryPerformed:false,executionAdmissible:false,reportIsNotAuthority:true,
  recoveryRehearsed:false,schemaChanged:false,deletionCertified:false,hostedAcceptance:false,erasureAccepted:false,
  releaseAccepted:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}
function save(file,bytes){let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
 catch(e){if(e?.code!=='EEXIST')throw e;}finally{if(fd!==undefined)closeSync(fd);}check(bounded(file).equals(bytes),'archive_readback');}
export function archiveRegisteredRestoredLock(c,report){
 check(report.contract==='synthetic-care-registered-routing-restoration/1'&&report.runId===JSON.parse(c.lockBytes).runId
  &&report.journalSha256===sha256(bounded(c.journal,1024*1024))&&report.writerStopped===true&&report.applicationSourceRebuilt===true
  &&report.repeatedReadbackVerified===true&&report.exactBytesVerified===true&&report.databasePreserved===true
  &&report.routeRestoredAtObservation===true&&report.temporaryPermissionAbsentAtObservation===true&&report.restorationVerified===true
  &&report.executionAdmissible===false&&report.retryPerformed===false&&report.reportIsNotAuthority===true
  &&['recoveryRehearsed','schemaChanged','deletionCertified','hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted']
   .every(k=>report[k]===false),'archive_report');
 const unchanged=()=>{c.guard.verify();check(bounded(c.lock,16384).equals(c.lockBytes)
  &&sha256(bounded(c.journal,1024*1024))===report.journalSha256,'custody_changed');};
 unchanged();const archive=resolve(c.out,report.runId+'.restored-lock.json'),receipt=resolve(c.out,report.runId+'.routing-restoration-'+sha256(canonical(report))+'.json');
 save(archive,c.lockBytes);save(receipt,Buffer.from(JSON.stringify(report,null,2)+'\n'));unchanged();unlinkSync(c.lock);
 return {archive,receipt,operatorCustodySettled:true};
}
function aws(args){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 try{const text=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return text.trim()?JSON.parse(text):{};
 }catch{refuseRegistered('stopped_restoration_aws_unconfirmed');}
}
export async function restoreRegisteredRouting(root,mobileRoot,artifactDirectory,applicationRoot){
 const operator=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(artifactDirectory),
  current=Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,candidate.manifest[k]]));
 check(equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'application_source');
 const shared=registeredReleaseDirectory(root,['dist','synthetic-care-routing']),guard=await acquireRecoverableRegisteredInspectionGuard(shared,operator);let observers;
 try{
  const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),id=JSON.parse(lockBytes).runId;check(/^[a-f0-9]{32}$/.test(id),'run_id');
  const out=registeredReleaseDirectory(root,['dist','synthetic-care-registered-operations',current.desktop.commit,current.mobile.source.commit,candidate.manifest.zipSha256]),
   journal=resolve(out,id+'.events.jsonl'),c={lock,lockBytes,journal,journalBytes:bounded(journal,1024*1024),out,guard},
   sourceText=normalizedText(applicationRoot,'infra/aws-clinical-core/identity-api-extension.json');
  // Refuse a changed/unadmitted journal before constructing mutating ports.
  await verifyInterruptedRegisteredReleaseCustody(c,candidate,sourceText,Date.now(),async(file,kind)=>readRegisteredReleaseEvidence(out,candidate,file,kind));
  observers=createRegisteredRestorationObservers(root,mobileRoot,artifactDirectory,applicationRoot,candidate,operator,c);
  const report=await runRegisteredRoutingRestoration(candidate,operator,c,sourceText,{...observers.port,pid:process.pid,
   record:async event=>{guard.verify();const fd=openSync(journal,'a');try{writeFileSync(fd,JSON.stringify(event)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    return bounded(journal,1024*1024);},
   returnLatest:async()=>aws(['apigatewayv2','update-integration','--api-id',P.apiId,'--integration-id',R.integrationId,'--integration-uri',R.latestArn]),
   removePermission:async(sid,revision)=>{check(/^alp-care-intent-recovery-[a-f0-9]{32}$/.test(sid),'sid');
    return aws(['lambda','remove-permission','--function-name',P.functionName,'--qualifier','2','--statement-id',sid,'--revision-id',revision]);},
   waitLatest:async previous=>{const deadline=Date.now()+180000;while(Date.now()<deadline){
    guard.verify();check(equal(careRegisteredCurrent(root,mobileRoot),operator)&&equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'source_changed');
    const integration=aws(['apigatewayv2','get-integration','--api-id',P.apiId,'--integration-id',R.integrationId]);
    check([R.latestArn,R.latestArn+':2'].includes(integration.IntegrationUri),'foreign_routing');
    if(integration.IntegrationUri===R.latestArn){verifyRecoveryIntegration(integration,R.latestArn);
     const stage=aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']);
     if(stage.DeploymentId!==previous){verifyRecoveryStage(stage);const deployment=await observers.port.apiDeployment(stage.DeploymentId);
      if(deployment.DeploymentId===stage.DeploymentId&&deployment.DeploymentStatus==='DEPLOYED')return;}}
    await new Promise(done=>setTimeout(done,2000));}refuseRegistered('stopped_restoration_return_unconfirmed');},
  });
  check(stoppedUploadWriter(JSON.parse(lockBytes).pid),'writer_active');
  check(equal(careRegisteredCurrent(root,mobileRoot),operator)&&equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'source_changed');
  return {...report,...archiveRegisteredRestoredLock(c,report)};
 }finally{observers?.close();await guard.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>registeredRoutingRestorationArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory,applicationRoot})=>restoreRegisteredRouting(process.cwd(),mobileRoot,directory,applicationRoot))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
