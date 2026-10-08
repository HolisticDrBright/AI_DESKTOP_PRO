/** Read-only reconciliation of a stopped admitted registered execution.
 * The journal locates admissions, never supplies current AWS authority. This
 * command cannot execute, reroute, grant permissions or certify recovery. */
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,normalizedText,sha256} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,assertCareRegisteredCurrent,readCareRegisteredCandidate,verifyCareRegisteredCandidate,
 inspectCareRegisteredArtifact,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical,verifyRecoveryStage} from './care-recovery-routing.mjs';
import {careRegisteredCodeTemplateInputs,careRegisteredChangeSetBinding,verifyCareRegisteredUnexecutedProposalViews} from './care-registered-code-change.mjs';
import {verifyCareRegisteredBeforeExecution,verifyCareRegisteredReconciledDeployment} from './care-registered-deployment.mjs';
import {verifyCareRegisteredDatabase,verifyCareRegisteredFunction,verifyCareRegisteredSuccessorFunction,verifyCareRegisteredPredecessorControl} from './care-registered-preflight.mjs';
import {acquireRegisteredUploadReconciliationGuard,stoppedUploadWriter,inspectRegisteredUploadObject} from './reconcile-synthetic-care-registered-upload.mjs';
import {buildCareRegisteredDatabaseObserver,readCareRegisteredPredecessor,registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {observeIntentControlRaw,downloadIntentFunction,intentPolicyAbsent} from './care-intent-live.mjs';
import {REGISTERED_UPLOAD_TRANSPORT} from './upload-synthetic-care-registered-release.mjs';
import {collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {observeSyntheticMemberIdentity,assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {splitRegisteredRestorationJournal} from './care-registered-restoration-custody.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('release_reconciliation_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const exact=(o,n)=>o&&typeof o==='object'&&!Array.isArray(o)&&equal(Object.keys(o).sort(),[...n].sort());
const frozenCurrent=c=>Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,c.manifest[k]]));
export function registeredReleaseReconciliationArguments(a){
 check(a.length===7&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--application-root'
  &&a[6]==='--reconcile-fictional-registered-execution-only'
  &&[a[1],a[3],a[5]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3]),applicationRoot:resolve(a[5])};
}
const fields={
 registered_upload_started:['runId'],registered_live_preflight_verified:['observedAt'],
 registered_artifact_put_admitted:['key','sha256'],registered_artifact_exact_version_verified:['artifact'],
 registered_change_set_create_admitted:['stackId','name','clientToken'],registered_change_set_observed:['id','name','reused'],
 registered_change_set_verified_unexecuted:['id','summarySha256','propertyValuesSha256'],
 registered_execution_before_archived:['file','sha256'],
 registered_change_execute_admitted:['stackId','changeSetId','clientToken','admissionFile','admissionSha256'],
 registered_change_execute_reply_unconfirmed:['changeSetId'],registered_change_execute_terminal:['changeSetId','replyLost'],
 registered_deployed_bytes_control_verified:['changeSetId','revision','zipSha256'],registered_deployment_readback_archived:['file'],
 registered_recovery_permission_admitted:['version','sid'],registered_recovery_switch_admitted:['version'],
 registered_recovery_return_admitted:['version'],registered_recovery_compensating_return_admitted:['version'],
 registered_recovery_cases_verified:['caseCount','version'],registered_recovery_permission_cleanup_admitted:['version'],
 registered_recovery_route_permission_restored:[],registered_compatible_routing_completed:['version'],
 registered_code_recovery_completed:['file'],registered_upload_completed:['receipt'],registered_upload_finding:['code','writeAdmitted'],
};
const sha=v=>/^[a-f0-9]{64}$/.test(v??'');
/** Exact post-execution journal profile. Earlier upload/proposal interruptions
 * remain held for their distinct observers; unknown stages never get filtered
 * into a successful prefix. A hard crash need not have a terminal finding. */
export async function verifyInterruptedRegisteredReleaseCustody(c,candidate,sourceText,now,readEvidence){
 const current=frozenCurrent(candidate);verifyCareRegisteredCandidate(candidate,current);
 const suffix=splitRegisteredRestorationJournal(c?.journalBytes,current,now);
 if(suffix.restoration){
  const base=await verifyInterruptedRegisteredReleaseCustody({...c,journalBytes:suffix.originalJournalBytes},candidate,sourceText,now,readEvidence);
  check(base.scope==='execution'&&base.sid,'restoration_without_admission');
  return {...base,originalJournalSha256:base.journalSha256,journalSha256:sha256(c.journalBytes),restoration:suffix.restoration};
 }
 check(Buffer.isBuffer(c?.lockBytes)&&c.lockBytes.length<=16384&&Buffer.isBuffer(c.journalBytes)
  &&c.journalBytes.length<=1024*1024&&c.journalBytes.at(-1)===10,'custody_bytes');
 let lock,events;
 try{lock=JSON.parse(c.lockBytes.toString('utf8'));events=c.journalBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);}
 catch{refuseRegistered('release_reconciliation_custody_json');}
 check(exact(lock,['desktop','mobile','pid','purpose','runId'])&&lock.purpose==='registered-artifact-upload-release'
  &&/^[a-f0-9]{32}$/.test(lock.runId)&&Number.isSafeInteger(lock.pid)&&lock.pid>0
  &&equal(lock.desktop,current.desktop)&&equal(lock.mobile,current.mobile)
  &&c.lockBytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))
  &&c.journalBytes.equals(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')),'custody_binding');
 check(events.length>=1&&events.length<=40&&typeof readEvidence==='function','journal_scope');
 let prior=-Infinity;
 for(const e of events){
  check(Object.hasOwn(fields,e.stage)&&exact(e,['at','stage',...fields[e.stage]]),'journal_fields');
  const t=Date.parse(e.at);check(Number.isFinite(t)&&t>=prior&&t<=now,'journal_time');prior=t;
 }
 check(Number.isFinite(now)&&now-prior>=60000,'writer_settlement');
 const finding=events.at(-1).stage==='registered_upload_finding'?events.at(-1):undefined;
 if(finding)check(typeof finding.writeAdmitted==='boolean'&&/^synthetic_care_registered_release_refused:[a-z0-9_]{1,180}$/.test(finding.code),'failure');
 const rows=finding?events.slice(0,-1):events;let i=0;
 const take=stage=>{const e=rows[i++];check(e?.stage===stage,'journal_order');return e;};
 check(take('registered_upload_started').runId===lock.runId,'run_id');
 const result={lock,events,current,evidenceReferences:[],journalSha256:sha256(c.journalBytes),
  originalRunOutcome:finding?'failed':'interrupted',originalFailure:finding?.code??null};
 const early=()=>{if(finding)check(finding.writeAdmitted===rows.some(e=>['registered_artifact_put_admitted','registered_change_set_create_admitted'].includes(e.stage)),'failure_admission');
  return {...result,scope:'before_execution'};};
 if(i===rows.length)return early();
 const preflight=take('registered_live_preflight_verified');
 check(Number.isFinite(Date.parse(preflight.observedAt))&&Date.parse(preflight.observedAt)<=Date.parse(preflight.at)
  &&Date.parse(preflight.at)-Date.parse(preflight.observedAt)<=120000,'preflight_time');
 if(i===rows.length)return early();
 if(rows[i]?.stage==='registered_artifact_put_admitted'){
  const put=take('registered_artifact_put_admitted');check(put.key===candidate.manifest.key&&put.sha256===candidate.manifest.zipSha256,'put_binding');
  if(i===rows.length)return early();
 }
 const artifact=take('registered_artifact_exact_version_verified').artifact,
  input=careRegisteredCodeTemplateInputs(sourceText,candidate,current,artifact),fixed=careRegisteredChangeSetBinding(input,current,artifact);
 Object.assign(result,{artifact,input,fixed});if(i===rows.length)return early();
 let created=false;
 if(rows[i]?.stage==='registered_change_set_create_admitted'){
  const a=take('registered_change_set_create_admitted');check(a.stackId===fixed.stackId&&a.name===fixed.name&&a.clientToken===fixed.digest,'create_binding');created=true;
  result.createAdmitted=true;if(i===rows.length)return early();
 }
 const observed=take('registered_change_set_observed'),binding={...fixed,id:observed.id};
 check(observed.name===fixed.name&&observed.reused===!created&&typeof observed.id==='string'
  &&new RegExp('^arn:aws:cloudformation:'+P.region+':'+P.account+':changeSet/'+fixed.name+'/[A-Za-z0-9-]{1,128}$').test(observed.id),'proposal_binding');
 Object.assign(result,{binding,proposalObserved:true});if(i===rows.length)return early();
 const verified=take('registered_change_set_verified_unexecuted');
 check(verified.id===binding.id&&sha(verified.summarySha256)&&sha(verified.propertyValuesSha256),'verified_binding');
 if(i===rows.length)return early();
 const befores=[],archiveTimes=[];
 while(rows[i]?.stage==='registered_execution_before_archived'){
  const e=take('registered_execution_before_archived');check(befores.length<2&&sha(e.sha256),'before_count');
  const bytes=await readEvidence(e.file,'before');check(Buffer.isBuffer(bytes)&&sha256(bytes)===e.sha256,'before_bytes');
  result.evidenceReferences.push({file:e.file,kind:'before',sha256:sha256(bytes)});
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{refuseRegistered('release_reconciliation_before_json');}
  check(bytes.equals(Buffer.from(JSON.stringify(value,null,2)+'\n'))&&equal(value.input,input)&&equal(value.binding,binding),'before_binding');
  befores.push(value);archiveTimes.push(Date.parse(e.at));
  verifyCareRegisteredBeforeExecution(value,candidate,current,sourceText,artifact,Date.parse(value.observedAt),Date.parse(e.at));
 }
 if(i===rows.length)return early();
 check(befores.length===2,'before_count');
 const execute=take('registered_change_execute_admitted'),before=befores.at(-1),
  token=sha256(canonical({contract:'care-registered-execution-input/1',binding,current,artifact}));
 check(execute.stackId===binding.stackId&&execute.changeSetId===binding.id&&execute.clientToken===token&&sha(execute.admissionSha256),'execution_binding');
 const bytes=await readEvidence(execute.admissionFile,'admission');let admission;
 result.evidenceReferences.push({file:execute.admissionFile,kind:'admission',sha256:sha256(bytes)});
 try{admission=JSON.parse(bytes.toString('utf8'));}catch{refuseRegistered('release_reconciliation_admission_json');}
 check(exact(admission,['at','stage','stackId','changeSetId','clientToken','beforeSha256','artifact','current'])
  &&bytes.equals(Buffer.from(JSON.stringify(admission,null,2)+'\n'))&&sha256(canonical(admission))===execute.admissionSha256
  &&equal(admission,{at:execute.at,stage:execute.stage,stackId:execute.stackId,changeSetId:execute.changeSetId,
   clientToken:execute.clientToken,beforeSha256:sha256(canonical(before)),artifact,current}),'admission_bytes');
 for(let n=0;n<befores.length;n++){
  const b=befores[n];verifyCareRegisteredBeforeExecution(b,candidate,current,sourceText,artifact,Date.parse(b.observedAt),archiveTimes[n]);
 }
 verifyCareRegisteredBeforeExecution(before,candidate,current,sourceText,artifact,Date.parse(before.observedAt),Date.parse(execute.at));
 check(verified.summarySha256===sha256(canonical(before.summary))&&verified.propertyValuesSha256===sha256(canonical(before.detailed)),'verified_projection');
 // Validate every permitted suffix as a state transition, not a whitelist.
 let state='execute',sid;
 const next={execute:['registered_change_execute_reply_unconfirmed','registered_change_execute_terminal'],
  registered_change_execute_reply_unconfirmed:['registered_change_execute_terminal'],
  registered_change_execute_terminal:['registered_deployed_bytes_control_verified'],
  registered_deployed_bytes_control_verified:['registered_deployment_readback_archived'],
  registered_deployment_readback_archived:['registered_recovery_permission_admitted'],
  registered_recovery_permission_admitted:['registered_recovery_switch_admitted','registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
  registered_recovery_switch_admitted:['registered_recovery_return_admitted','registered_recovery_compensating_return_admitted'],
  registered_recovery_return_admitted:['registered_recovery_cases_verified','registered_recovery_compensating_return_admitted','registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
  registered_recovery_compensating_return_admitted:['registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
  registered_recovery_cases_verified:['registered_recovery_permission_cleanup_admitted','registered_recovery_route_permission_restored'],
  registered_recovery_permission_cleanup_admitted:['registered_recovery_route_permission_restored'],
  registered_recovery_route_permission_restored:['registered_compatible_routing_completed'],
  registered_compatible_routing_completed:['registered_code_recovery_completed'],registered_code_recovery_completed:['registered_upload_completed']};
 for(;i<rows.length;i++){
  const e=rows[i];check(next[state]?.includes(e.stage),'journal_transition');state=e.stage;
  if(Object.hasOwn(e,'changeSetId'))check(e.changeSetId===binding.id,'suffix_binding');
  if(Object.hasOwn(e,'version'))check(e.version==='2','recovery_version');
  if(e.stage==='registered_recovery_permission_admitted'){check(/^alp-care-intent-recovery-[a-f0-9]{32}$/.test(e.sid),'permission_identity');sid=e.sid;}
  if(e.stage==='registered_change_execute_terminal')check(typeof e.replyLost==='boolean','reply_lost');
  if(e.stage==='registered_deployed_bytes_control_verified')check(e.zipSha256===candidate.manifest.zipSha256&&typeof e.revision==='string'&&e.revision,'successor_binding');
  if(e.stage==='registered_recovery_cases_verified')check(e.caseCount===105,'case_count');
 }
 if(finding)check(finding.writeAdmitted===true,'failure_admission');
 return {...result,scope:'execution',before,execute,sid};
}
const inventory=r=>{const copy=structuredClone(r);delete copy.observedAt;return copy;};
/** Credentials-free ports below are tests only; the public observer constructs
 * every port from the fixed account, source and actual AWS clients. */
export async function runRegisteredReleaseReconciliation(candidate,operator,custody,sourceText,d){
 assertCareRegisteredCurrent(operator);const started=d.now(),saved=await verifyInterruptedRegisteredReleaseCustody(custody,candidate,sourceText,started,d.evidence);
 check(equal(operator.mobile,saved.current.mobile)&&equal(operator.migrations,saved.current.migrations)
  &&operator.templateSha256===saved.current.templateSha256,'operator_binding');
 const caller=await d.identity();assertSyntheticMemberIdentity(caller);
 const guard=async()=>{
  check(equal(await d.current(),operator)&&equal(await d.applicationCurrent(),saved.current),'source_changed');
  check(await d.writerStopped(saved.lock.pid)===true,'writer_active');
  if(saved.restoration)check(started-saved.restoration.lastAt>=60000&&await d.writerStopped(saved.restoration.pid)===true,'restoration_writer_active');
  const bytes=await d.custody();check(bytes.lockBytes.equals(custody.lockBytes)&&bytes.journalBytes.equals(custody.journalBytes),'custody_changed');
  for(const e of saved.evidenceReferences){const actual=await d.evidence(e.file,e.kind);
   check(Buffer.isBuffer(actual)&&sha256(actual)===e.sha256,'archived_evidence_changed');}
  const who=await d.identity();assertSyntheticMemberIdentity(who);check(equal(who,caller),'principal_changed');
 };
 await guard();const rebuilt=await d.rebuild();
 check(rebuilt?.byteVerified===true&&rebuilt.sourceRebuilt===true&&rebuilt.zipSha256===candidate.manifest.zipSha256
  &&rebuilt.desktopCommit===saved.current.desktop.commit&&rebuilt.mobileCommit===saved.current.mobile.source.commit
  &&rebuilt.liveTargetObserved===false&&rebuilt.deployed===false&&rebuilt.phiAllowed===false,'independent_rebuild');
 if(saved.scope==='before_execution')return reconcileUnexecutedRelease(candidate,operator,saved,sourceText,d,guard,started);
 const observe=async()=>{
  await guard();const database=await d.database(),raw=await d.control(),views=await d.proposal(saved.binding),
   bytes=await d.latest(raw.fn),policy=await d.retainedPolicy(),retained=await d.retained();
  // An admitted permission or routing reply cannot prove it is absent now.
  check(policy===null&&retained.policy===null,'temporary_permission_present');
  check(retained.sha256===candidate.release.predecessor.zipSha256&&retained.bytes===candidate.release.predecessor.bytes
   &&equal(verifyCareRegisteredFunction(retained.configuration,true),verifyCareRegisteredSuccessorFunction(raw.fn,candidate,saved.current)),
   'retained_binding');
  verifyRecoveryStage(raw.stage);const deployedStage=await d.apiDeployment(raw.stage.DeploymentId);
  check(deployedStage?.DeploymentId===raw.stage.DeploymentId&&deployedStage.DeploymentStatus==='DEPLOYED','api_deployment');
  const after={observedAt:new Date(d.now()).toISOString(),raw,database,...views},witness={
   contract:'synthetic-care-registered-deployment-observation/1',current:saved.current,artifact:saved.artifact,
   executionAdmittedAt:saved.execute.at,before:saved.before,after,codeBytes:bytes};
  const deployment=verifyCareRegisteredReconciledDeployment(witness,candidate,saved.current,sourceText,saved.artifact,operator,started,d.now());
  verifyCareRegisteredDatabase(database,operator,started,d.now());
  const storage=await d.storage();check(storage?.state==='stored_exact_version'&&storage.bytesVerified===true
   &&storage.versionId===saved.artifact.versionId&&storage.sha256===candidate.manifest.zipSha256
   &&storage.bytes===candidate.manifest.zipBytes&&storage.deletionCertified===false,'storage_binding');
  await guard();return {deployment,storage,database,retained,apiDeployment:deployedStage,raw};
 };
 const first=await observe(),second=await observe();
 check(equal(inventory(first.database),inventory(second.database))&&equal(first.storage,second.storage)
  &&equal(first.retained,second.retained)&&equal(first.apiDeployment,second.apiDeployment)
  &&equal(first.deployment.control,second.deployment.control)&&equal(first.raw.fn,second.raw.fn),'observation_changed');
 await guard();
 return {contract:'synthetic-care-registered-release-reconciliation/1',observedAt:new Date(d.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,scope:'execution',runId:saved.lock.runId,
  applicationSource:saved.current,operatorSource:operator,applicationSourceRebuilt:true,writerStopped:true,
  journalSha256:saved.journalSha256,originalRunOutcome:saved.originalRunOutcome,originalFailure:saved.originalFailure,
  deployment:second.deployment,databaseBefore:first.database,databaseAfter:second.database,storage:second.storage,
  retained:second.retained,apiDeployment:second.apiDeployment,repeatedReadbackVerified:true,
  exactBytesVerified:true,databasePreserved:true,routeRestoredAtObservation:true,temporaryPermissionAbsentAtObservation:true,
  originalExecutionReplyConfirmed:false,reportIsNotAuthority:true,executionAdmissible:false,retryPerformed:false,
  awsMutationPerformed:false,deletionCertified:false,deployed:true,recoveryRehearsed:false,schemaChanged:false,
  hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}
async function reconcileUnexecutedRelease(candidate,operator,saved,sourceText,d,guard,started){
 const observe=async()=>{
  await guard();const database=verifyCareRegisteredDatabase(await d.database(),operator,started,d.now()),raw=await d.control(),
   control=verifyCareRegisteredPredecessorControl(raw,JSON.parse(sourceText)),bytes=await d.predecessor(raw.fn),retained=await d.retained();
  check(bytes?.exactBytesVerified===true&&bytes.sha256===candidate.release.predecessor.zipSha256&&bytes.bytes===candidate.release.predecessor.bytes,'predecessor_bytes');
  check(await d.retainedPolicy()===null&&retained.policy===null&&retained.sha256===candidate.release.predecessor.zipSha256
   &&retained.bytes===candidate.release.predecessor.bytes&&equal(verifyCareRegisteredFunction(retained.configuration,true),verifyCareRegisteredFunction(raw.fn)),
   'retained_binding');
  const apiDeployment=await d.apiDeployment(raw.stage.DeploymentId);
  check(apiDeployment?.DeploymentId===raw.stage.DeploymentId&&apiDeployment.DeploymentStatus==='DEPLOYED','api_deployment');
  const storage=await d.storage();
  check(storage&&['stored_exact_version','absent_at_observation'].includes(storage.state)&&storage.deletionCertified===false,'storage_state');
  if(storage.state==='stored_exact_version')check(storage.bytesVerified===true&&storage.sha256===candidate.manifest.zipSha256
   &&storage.bytes===candidate.manifest.zipBytes&&typeof storage.versionId==='string'&&storage.versionId,'storage_binding');
  if(saved.artifact)check(storage.state==='stored_exact_version'&&storage.versionId===saved.artifact.versionId,'recorded_storage_missing');
  let proposal=null,listingSha256=null;
  if(saved.fixed){
   const listing=await d.list(saved.fixed);check(Array.isArray(listing?.Summaries)&&listing.Summaries.length<=2000&&!listing.NextToken
    &&listing.Summaries.every(s=>typeof s.ChangeSetName==='string'&&typeof s.ChangeSetId==='string')
    &&new Set(listing.Summaries.map(s=>s.ChangeSetId)).size===listing.Summaries.length,'proposal_listing');
   listingSha256=sha256(canonical(listing));const matches=listing.Summaries.filter(s=>s.ChangeSetName===saved.fixed.name);
   check(matches.length<=1&&(!(saved.createAdmitted||saved.proposalObserved)||matches.length===1),'proposal_unconfirmed');
   if(matches.length){
    const binding={...saved.fixed,id:matches[0].ChangeSetId};if(saved.binding)check(equal(binding,saved.binding),'proposal_identity');
    const views=await d.proposal(binding);proposal=verifyCareRegisteredUnexecutedProposalViews(views.summary,views.detailed,views.template,
     saved.input,binding,raw,sourceText,control,saved.current,candidate,saved.artifact,d.now());
   }
  }
  await guard();return {database,raw,control,storage,retained,apiDeployment,proposal,listingSha256};
 };
 const first=await observe(),second=await observe();check(equal(inventory(first.database),inventory(second.database))
  &&equal(first.control,second.control)&&equal(first.storage,second.storage)&&equal(first.retained,second.retained)
  &&equal(first.apiDeployment,second.apiDeployment)&&equal(first.proposal,second.proposal)&&first.listingSha256===second.listingSha256,'observation_changed');
 await guard();return {contract:'synthetic-care-registered-release-reconciliation/1',observedAt:new Date(d.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,scope:'before_execution',runId:saved.lock.runId,
  applicationSource:saved.current,operatorSource:operator,applicationSourceRebuilt:true,writerStopped:true,
  journalSha256:saved.journalSha256,originalRunOutcome:saved.originalRunOutcome,originalFailure:saved.originalFailure,
  predecessorControl:second.control,proposal:second.proposal,listingSha256:second.listingSha256,
  databaseBefore:first.database,databaseAfter:second.database,storage:second.storage,retained:second.retained,
  apiDeployment:second.apiDeployment,repeatedReadbackVerified:true,exactBytesVerified:true,databasePreserved:true,
  routeRestoredAtObservation:true,temporaryPermissionAbsentAtObservation:true,originalPutOutcome:'unknown',
  originalExecutionReplyConfirmed:false,reportIsNotAuthority:true,executionAdmissible:false,retryPerformed:false,
  awsMutationPerformed:false,deletionCertified:false,deployed:false,recoveryRehearsed:false,schemaChanged:false,
  hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}
export function readRegisteredReleaseBounded(file,max=4*1024*1024){
 const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'file');const bytes=readFileSync(file),b=lstatSync(file);
 check(a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&bytes.length===a.size,'file_changed');return bytes;
}
const bounded=readRegisteredReleaseBounded;
export function registeredReleaseDirectory(root,parts){let d=realpathSync(root);for(const p of parts){d=resolve(d,p);const s=lstatSync(d);
 check(s.isDirectory()&&!s.isSymbolicLink(),'directory');}return d;}
const directory=registeredReleaseDirectory;
export function readRegisteredReleaseEvidence(out,candidate,file,kind){
 check(['before','admission'].includes(kind)&&typeof file==='string'&&resolve(file)===resolve(out,basename(file)),'evidence_path');
 const pattern=kind==='before'?new RegExp('^'+candidate.manifest.zipSha256+'\\.before-[a-f0-9]{64}\\.json$')
  :new RegExp('^'+candidate.manifest.zipSha256+'\\.execution-admission-[a-f0-9]{64}\\.json$');
 check(pattern.test(basename(file)),'evidence_name');const bytes=bounded(file);let value;
 try{value=JSON.parse(bytes);}catch{refuseRegistered('release_reconciliation_evidence_json');}
 check(basename(file).endsWith('-'+sha256(canonical(value))+'.json'),'evidence_digest_name');return bytes;
}
function save(file,bytes){let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
 catch(e){if(e?.code!=='EEXIST')throw e;}finally{if(fd!==undefined)closeSync(fd);}check(bounded(file).equals(bytes),'archive_readback');}
export function archiveReconciledReleaseLock(c,report){
 check(report.contract==='synthetic-care-registered-release-reconciliation/1'&&report.runId===JSON.parse(c.lockBytes).runId
  &&['before_execution','execution'].includes(report.scope)&&report.deployed===(report.scope==='execution')
  &&report.journalSha256===sha256(c.journalBytes)&&report.writerStopped===true&&report.applicationSourceRebuilt===true
  &&report.repeatedReadbackVerified===true&&report.exactBytesVerified===true&&report.databasePreserved===true
  &&report.routeRestoredAtObservation===true&&report.temporaryPermissionAbsentAtObservation===true
  &&report.reportIsNotAuthority===true&&report.executionAdmissible===false&&report.retryPerformed===false
  &&report.awsMutationPerformed===false&&report.recoveryRehearsed===false&&report.hostedAcceptance===false&&report.phiAllowed===false,'archive_report');
 check(c.guard&&typeof c.guard.verify==='function','guard_required');
 const unchanged=()=>{c.guard.verify();check(bounded(c.lock,16384).equals(c.lockBytes)&&bounded(c.journal,1024*1024).equals(c.journalBytes),'custody_changed');};
 unchanged();const archive=resolve(c.out,report.runId+'.release-settled-lock.json'),
  receipt=resolve(c.out,report.runId+'.release-reconciliation-'+sha256(canonical(report))+'.json');
 save(archive,c.lockBytes);save(receipt,Buffer.from(JSON.stringify(report,null,2)+'\n'));unchanged();unlinkSync(c.lock);
 return {archive,receipt,operatorCustodySettled:true};
}
/** Finite diagnostics only: never provider stderr, tokens, URLs or stacks. */
export function registeredReconciliationAwsDiagnostic(args,error){
 const phases={'lambda/get-policy':'retained_policy','lambda/get-function-configuration':'retained_configuration',
  'apigatewayv2/get-deployment':'api_deployment','cloudformation/list-change-sets':'proposal_listing',
  'cloudformation/get-template':'proposal_template','cloudformation/describe-change-set':'proposal_projection'};
 const phase=phases[Array.isArray(args)?args.slice(0,2).join('/'):'']??'unknown';
 const stderr=Buffer.isBuffer(error?.stderr)?error.stderr.toString('utf8'):error?.stderr;
 const denied=typeof stderr==='string'&&stderr.length<=65536
  &&/^(?:aws: \[ERROR\]: )?An error occurred \((?:AccessDenied|AccessDeniedException|UnauthorizedOperation)\) when calling the [A-Za-z]+ operation(?: \(reached max retries: 0\))?:/.test(stderr.trim());
 const reason=error?.code==='ENOBUFS'?'output_limit':error?.code==='ETIMEDOUT'?'timeout'
  :error?.signal==='SIGTERM'?'terminated':error?.name==='SyntaxError'?'json'
   :denied?'access_denied':'unknown';
 return 'release_reconciliation_aws_'+phase+'_'+reason+'_unconfirmed';
}
function aws(args,missingPolicyVersion){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 try{const text=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return text.trim()?JSON.parse(text):{};
 }catch(e){if(intentPolicyAbsent(args,missingPolicyVersion,e))return null;refuseRegistered(registeredReconciliationAwsDiagnostic(args,e));}
}
/** Shared actual read-only observers for the separate compensating operator.
 * Source roots are independently bound; no transport or report can be supplied
 * through either public command. The returned clients must always be closed. */
export function createRegisteredRestorationObservers(root,mobileRoot,artifactDirectory,applicationRoot,candidate,operator,c){
 const database=buildCareRegisteredDatabaseObserver(root,operator),predecessor=readCareRegisteredPredecessor(root),
  client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
 const unchangedArtifact=()=>{const fresh=readCareRegisteredCandidate(artifactDirectory);
  check(['zip','bundle','releaseBytes','manifestBytes'].every(k=>fresh[k].equals(candidate[k])),'artifact_changed');};
 return {close:()=>client.destroy(),port:{now:Date.now,
  evidence:async(file,kind)=>readRegisteredReleaseEvidence(c.out,candidate,file,kind),
  current:async()=>{unchangedArtifact();return careRegisteredCurrent(root,mobileRoot);},
  applicationCurrent:async()=>careRegisteredCurrent(applicationRoot,mobileRoot),identity:async()=>observeSyntheticMemberIdentity(),
  writerStopped:async pid=>stoppedUploadWriter(pid),custody:async()=>{c.guard.verify();return {
   lockBytes:bounded(c.lock,16384),journalBytes:bounded(c.journal,1024*1024)};},
  rebuild:()=>inspectCareRegisteredArtifact(applicationRoot,mobileRoot,artifactDirectory),database,control:async()=>observeIntentControlRaw(),
  latest:fn=>downloadIntentFunction(fn,candidate),
  retainedPolicy:async()=>aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'],'2'),
  retained:async()=>{const configuration=aws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier','2']),
   bytes=await downloadIntentFunction(configuration,predecessor),policy=aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'],'2');
   return {configuration,sha256:sha256(bytes),bytes:bytes.length,policy};},
  apiDeployment:async id=>aws(['apigatewayv2','get-deployment','--api-id',P.apiId,'--deployment-id',id]),
  storage:()=>inspectRegisteredUploadObject(candidate,(command,options={})=>client.send(command,
   {...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)})),
  proposal:async b=>{const t=aws(['cloudformation','get-template','--stack-name',b.stackId,'--change-set-name',b.id,'--template-stage','Original']).TemplateBody;
   return {summary:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate']),
    detailed:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--include-property-values','--no-paginate']),
    template:typeof t==='string'?JSON.parse(t):t};},
 }};
}
export async function reconcileRegisteredRelease(root,mobileRoot,artifactDirectory,applicationRoot){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 const operator=careRegisteredCurrent(root,mobileRoot),candidate=readCareRegisteredCandidate(artifactDirectory),current=frozenCurrent(candidate);
 verifyCareRegisteredCandidate(candidate,current);check(equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'application_source');observeSyntheticMemberIdentity();
 const shared=directory(root,['dist','synthetic-care-routing']),guard=acquireRegisteredUploadReconciliationGuard(shared,operator);let client;
 try{
  const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),id=JSON.parse(lockBytes).runId;check(/^[a-f0-9]{32}$/.test(id),'run_id');
  const out=directory(root,['dist','synthetic-care-registered-operations',current.desktop.commit,current.mobile.source.commit,candidate.manifest.zipSha256]),
   journal=resolve(out,id+'.events.jsonl'),journalBytes=bounded(journal,1024*1024),c={lock,lockBytes,journal,journalBytes,out,guard},
   sourceText=normalizedText(applicationRoot,'infra/aws-clinical-core/identity-api-extension.json');
  const evidence=async(file,kind)=>readRegisteredReleaseEvidence(out,candidate,file,kind);
  await verifyInterruptedRegisteredReleaseCustody(c,candidate,sourceText,Date.now(),evidence);
  const database=buildCareRegisteredDatabaseObserver(root,operator),predecessor=readCareRegisteredPredecessor(root);
  client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
  const unchangedArtifact=()=>{const fresh=readCareRegisteredCandidate(artifactDirectory);
   check(['zip','bundle','releaseBytes','manifestBytes'].every(k=>fresh[k].equals(candidate[k])),'artifact_changed');};
  const report=await runRegisteredReleaseReconciliation(candidate,operator,c,sourceText,{
   now:Date.now,evidence,current:async()=>{unchangedArtifact();return careRegisteredCurrent(root,mobileRoot);},
   applicationCurrent:async()=>careRegisteredCurrent(applicationRoot,mobileRoot),identity:async()=>observeSyntheticMemberIdentity(),
   writerStopped:async pid=>stoppedUploadWriter(pid),custody:async()=>{guard.verify();return {lockBytes:bounded(lock,16384),journalBytes:bounded(journal,1024*1024)};},
   rebuild:()=>inspectCareRegisteredArtifact(applicationRoot,mobileRoot,artifactDirectory),database,control:async()=>observeIntentControlRaw(),
   latest:fn=>downloadIntentFunction(fn,candidate),
   predecessor:async fn=>{const bytes=await downloadIntentFunction(fn,predecessor);
    return {sha256:sha256(bytes),bytes:bytes.length,exactBytesVerified:bytes.equals(predecessor.zip)};},
   retainedPolicy:async()=>aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'],'2'),
   retained:async()=>{const configuration=aws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier','2']),
    bytes=await downloadIntentFunction(configuration,predecessor),policy=aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'],'2');
    return {configuration,sha256:sha256(bytes),bytes:bytes.length,policy};},
   apiDeployment:async id=>aws(['apigatewayv2','get-deployment','--api-id',P.apiId,'--deployment-id',id]),
   storage:()=>inspectRegisteredUploadObject(candidate,(command,options={})=>client.send(command,{...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)})),
   list:async b=>collectCancellationInventory(aws,['cloudformation','list-change-sets','--stack-name',b.stackId],'Summaries','NextToken'),
   proposal:async b=>{const t=aws(['cloudformation','get-template','--stack-name',b.stackId,'--change-set-name',b.id,'--template-stage','Original']).TemplateBody;
    return {summary:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate']),
     detailed:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--include-property-values','--no-paginate']),
     template:typeof t==='string'?JSON.parse(t):t};},
  });
  unchangedArtifact();check(stoppedUploadWriter(JSON.parse(lockBytes).pid),'writer_active');
  check(equal(careRegisteredCurrent(root,mobileRoot),operator)&&equal(careRegisteredCurrent(applicationRoot,mobileRoot),current),'source_changed');
  return {...report,...archiveReconciledReleaseLock(c,report)};
 }finally{client?.destroy();guard.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>registeredReleaseReconciliationArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory,applicationRoot})=>reconcileRegisteredRelease(process.cwd(),mobileRoot,directory,applicationRoot))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
