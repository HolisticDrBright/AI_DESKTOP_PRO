/** Fresh independently admitted functional rehearsal after a failed release.
 * The public runner constructs fixed observers and durable custody. Its
 * ports cannot execute a proposal, write code/schema or launch a mobile build. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {canonical,verifyRecoveryStage,verifyRecoveryPhase,verifyPostParentReceiptPhase,verifyRecoveryMetric} from './care-recovery-routing.mjs';
import {assertCareRegisteredCurrent,verifyCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyInterruptedRegisteredReleaseCustody} from './reconcile-synthetic-care-registered-release.mjs';
import {verifyRegisteredStandaloneLock,verifyRegisteredStandaloneCustody} from './care-registered-standalone-custody.mjs';
import {verifyCareRegisteredRestorationDeployment} from './care-registered-deployment.mjs';
import {verifyCareRegisteredDatabase,verifyCareRegisteredFunction,verifyCareRegisteredSuccessorFunction} from './care-registered-preflight.mjs';
import {verifyRegisteredIntentPhase,verifyRegisteredRetainedPermissionLineage} from './care-registered-routing.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,c)=>{if(!ok)refuseRegistered('standalone_'+c);};
const equal=(a,b)=>canonical(a)===canonical(b);
const inventory=v=>{const copy=structuredClone(v);delete copy.observedAt;return copy;};
const databaseContents=v=>{const copy=inventory(v);delete copy.operatorSource;return copy;};
const falseFlags=['schemaChanged','hostedAcceptance','erasureAccepted','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'];
/** Usage observations are not configuration. Admit only the two fields already
 * excluded by the authority verifier, after checking their service shapes.
 * Everything else, including unknown fields and the complete returned stage,
 * must remain exact. This does not admit Lambda permission metadata drift. */
function usageComparable(raw,now){
 const copy=structuredClone(raw),last=copy?.role?.Role?.RoleLastUsed;
 if(last!==undefined){
  check(last!==null&&typeof last==='object'&&!Array.isArray(last)
   &&Object.keys(last).every(k=>['LastUsedDate','Region'].includes(k)),'usage_observation');
  if(last.LastUsedDate!==undefined)check(typeof last.LastUsedDate==='string'
   &&Number.isFinite(Date.parse(last.LastUsedDate))&&Date.parse(last.LastUsedDate)<=now,'usage_observation');
  if(last.Region!==undefined)check(typeof last.Region==='string'&&last.Region.length<=64
   &&/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/.test(last.Region),'usage_observation');
  delete copy.role.Role.RoleLastUsed;
 }
 check(Array.isArray(copy?.logGroups?.logGroups),'usage_observation');
 for(const group of copy.logGroups.logGroups){
  if(group.storedBytes!==undefined)check(Number.isSafeInteger(group.storedBytes)&&group.storedBytes>=0,'usage_observation');
  delete group.storedBytes;
 }
 return copy;
}
export function verifyRegisteredStandaloneRecovery(report,input,operator,started,now,parseIntent){
 const {candidate,current}=input;assertCareRegisteredCurrent(operator);const observerSource=input.observerSource??current;
 check(report?.contract==='synthetic-care-registered-routing-rehearsal/1'&&report.scope==='known-intent-predecessor-current-schema'
  &&report.execution==='synthetic-staging'&&report.account===P.account&&equal(report.current,current)&&equal(report.observerSource,observerSource)
  &&report.zipSha256===candidate.manifest.zipSha256&&report.predecessorZipSha256===candidate.release.predecessor.zipSha256
  &&report.retainedVersion==='2'&&report.verdict==='pass'&&report.functionalRoutingRecoveryVerified===true
  &&report.returnToCandidateVerified===true&&report.temporaryPermissionRemoved===true&&report.reportIsNotAuthority===true
  &&falseFlags.every(k=>report[k]===false),'recovery_report');
 const begin=Date.parse(report.startedAt),end=Date.parse(report.completedAt);
 check(Number.isFinite(begin)&&Number.isFinite(end)&&begin>=started&&end>=begin&&end<=now,'recovery_time');
 verifyCareRegisteredDatabase(report.databaseBefore,observerSource,begin,Date.parse(report.databaseBefore?.observedAt));
 verifyCareRegisteredDatabase(report.databaseAfter,observerSource,begin,end);
 check(equal(inventory(report.databaseBefore),inventory(report.databaseAfter)),'recovery_database');
 check(equal(Object.keys(report.observations??{}).sort(),['baseline','retained','returned'])
  &&equal(Object.keys(report.intents??{}).sort(),['baseline','retained','returned']),'recovery_phases');
 const ids=new Set();let total=0;
 for(const phase of ['baseline','retained','returned']){
  const rows=report.observations[phase];check(Array.isArray(rows)&&rows.length===25,'recovery_count');
  const consumer=verifyRecoveryPhase(rows.filter(r=>r.case!=='existing_cancelled_receipt')),
   receipts=verifyPostParentReceiptPhase(rows.filter(r=>r.case==='existing_cancelled_receipt')),
   intents=verifyRegisteredIntentPhase(report.intents[phase],phase,receipts,parseIntent);
  if(phase!=='baseline')check(receipts.every(r=>report.observations.baseline.some(b=>b.case===r.case&&b.persona===r.persona
   &&b.erasureRequestId===r.erasureRequestId&&b.bodySha256===r.bodySha256)),'recovery_receipts');
  for(const r of [...consumer,...receipts,...intents]){check(!ids.has(r.requestId),'recovery_replay');ids.add(r.requestId);total++;}
 }
 check(total===105,'recovery_count');const metric=report.metricWitness;
 check(metric?.version==='2'&&metric.minimum===35&&metric.start===Math.floor(metric.start/60000)*60000
  &&metric.end===Math.ceil(metric.end/60000)*60000&&metric.start>=Math.floor(begin/60000)*60000
  &&metric.end<=Math.ceil(end/60000)*60000,'recovery_metric_window');
 verifyRecoveryMetric(metric.response,metric.start,metric.end,metric.minimum);
 check(Array.isArray(report.events)&&report.events.length===3&&report.events[0].stage==='registered_recovery_cases_verified'
  &&report.events[0].caseCount===105&&report.events[0].version==='2'
  &&report.events[1].stage==='registered_recovery_route_permission_restored'
  &&report.events[2].stage==='registered_compatible_routing_completed'&&report.events[2].version==='2','recovery_events');
 verifyRegisteredRetainedPermissionLineage(report.retainedPermissionLineage,begin,end);
 return report;
}
/** Tests supply fictional transports. The public runner must construct
 * every port from the fixed target and actual service, never from a report. */
export async function runRegisteredStandaloneRehearsal(candidate,operator,c,sourceText,d){
 assertCareRegisteredCurrent(operator);const observedStart=d.now(),started=c.initialEvent?Date.parse(c.initialEvent.at):observedStart,
  current=Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,candidate.manifest[k]]));
 check(Number.isFinite(started)&&started<=observedStart&&observedStart-started<=120000,'initialization_time');
 verifyCareRegisteredCandidate(candidate,current);
 const original=await d.originalCustody(),saved=await verifyInterruptedRegisteredReleaseCustody(original,candidate,sourceText,started,d.originalEvidence);
 check(saved.scope==='execution'&&!saved.events.some(e=>e.stage==='registered_upload_completed'),'original_incomplete_execution');
 const deployed=saved.events.find(e=>e.stage==='registered_deployed_bytes_control_verified');check(deployed,'original_deployment_admission');
 const origin={runId:saved.lock.runId,lockSha256:sha256(original.lockBytes),journalSha256:sha256(original.journalBytes)},
  lock=verifyRegisteredStandaloneLock(c.lockBytes,current,operator,origin);
 const firstEvent={at:new Date(started).toISOString(),stage:'registered_standalone_started',runId:lock.runId,
  originalRunId:origin.runId,originalLockSha256:origin.lockSha256,originalJournalSha256:origin.journalSha256};
 if(c.initialEvent){
  check(lock.pid===d.pid&&typeof d.verifyCreatedCustody==='function'&&equal(c.initialEvent,firstEvent)
   &&c.journalBytes.equals(Buffer.from(JSON.stringify(firstEvent)+'\n')),'fresh_initialization');
  d.verifyCreatedCustody();
 }else check(c.journalBytes.length===0,'fresh_custody_required');
 let journalBytes=Buffer.from(c.journalBytes),writeAdmitted=false;
 const ownEvidenceReferences=[];
 const caller=await d.identity();assertSyntheticMemberIdentity(caller);
 const guard=async()=>{
  check(equal(await d.current(),operator)&&equal(await d.applicationCurrent(),current),'source_changed');
  if(c.initialEvent)d.verifyCreatedCustody();
  check(await d.writerStopped(saved.lock.pid)===true,'original_writer_active');
  if(saved.restoration)check(started-saved.restoration.lastAt>=60000&&await d.writerStopped(saved.restoration.pid)===true,'original_restoration_active');
  const originBytes=await d.originalCustody(),own=await d.custody();
  check(originBytes.lockBytes.equals(original.lockBytes)&&originBytes.journalBytes.equals(original.journalBytes),'original_custody_changed');
  check(own.lockBytes.equals(c.lockBytes)&&own.journalBytes.equals(journalBytes),'custody_changed');
  for(const e of saved.evidenceReferences)check(sha256(await d.originalEvidence(e.file,e.kind))===e.sha256,'original_evidence_changed');
  for(const e of ownEvidenceReferences)check(sha256(await d.evidence(e.file,e.kind))===e.sha256,'own_evidence_changed');
  const identity=await d.identity();assertSyntheticMemberIdentity(identity);check(equal(identity,caller),'principal_changed');
 };
 const append=async(stage,detail={},at=new Date(d.now()).toISOString())=>{
  await guard();const event={at,stage,...detail},expected=Buffer.concat([journalBytes,Buffer.from(JSON.stringify(event)+'\n')]),actual=await d.record(event);
  check(Buffer.isBuffer(actual)&&actual.equals(expected),'journal_durability');journalBytes=expected;
  await verifyRegisteredStandaloneCustody({lockBytes:c.lockBytes,journalBytes},current,operator,origin,d.now(),d.evidence,{settled:false});
  await guard();return event;
 };
 const archive=async(kind,value)=>{
  await guard();const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),savedFile=await d.save(kind,bytes);
  check(typeof savedFile==='string'&&(await d.evidence(savedFile,kind)).equals(bytes),'archive_durability');
  ownEvidenceReferences.push({file:savedFile,kind,sha256:sha256(bytes)});await guard();return {file:savedFile,sha256:sha256(bytes)};
 };
 const observe=async()=>{
  await guard();const database=await d.database(),raw=await d.control(),views=await d.proposal(saved.binding),codeBytes=await d.latest(raw.fn),
   retained=await d.retained(),storage=await d.storage(),policy=await d.retainedPolicy();
  const witness={contract:'synthetic-care-registered-deployment-observation/1',current,artifact:saved.artifact,
   executionAdmittedAt:saved.execute.at,before:saved.before,after:{observedAt:new Date(d.now()).toISOString(),raw,database,...views},codeBytes},
   deployment=verifyCareRegisteredRestorationDeployment(witness,candidate,current,sourceText,saved.artifact,operator,started,d.now());
  check(raw.fn.RevisionId===deployed.revision&&retained.policy===null&&policy===null,'candidate_or_permission_changed');
  check(retained.sha256===candidate.release.predecessor.zipSha256&&retained.bytes===candidate.release.predecessor.bytes
   &&equal(verifyCareRegisteredFunction(retained.configuration,true),verifyCareRegisteredSuccessorFunction(raw.fn,candidate,current)),'retained_binding');
  check(storage?.state==='stored_exact_version'&&storage.bytesVerified===true&&storage.versionId===saved.artifact.versionId
   &&storage.sha256===candidate.manifest.zipSha256&&storage.bytes===candidate.manifest.zipBytes&&storage.deletionCertified===false,'storage_binding');
  verifyRecoveryStage(raw.stage);const apiDeployment=await d.apiDeployment(raw.stage.DeploymentId);
  check(apiDeployment?.DeploymentId===raw.stage.DeploymentId&&apiDeployment.DeploymentStatus==='DEPLOYED','api_deployment');
  await guard();return {observedAt:witness.after.observedAt,database,raw,deployment,retained,storage,apiDeployment,...views};
 };
 const same=(a,b,returned=false,lineage)=>{
  const retainedMatches=lineage?equal(a.retained,lineage.before)&&equal(b.retained,lineage.after):equal(a.retained,b.retained);
  check(equal(inventory(a.database),inventory(b.database))&&equal(a.raw.fn,b.raw.fn)&&equal(a.storage,b.storage)&&retainedMatches,'state_changed');
  for(const k of ['functionConfigurationSha256','resourcesSha256','templateSha256','parametersSha256','routesSha256','authorizersSha256',
   'integrationsSha256','policySha256','roleSha256','identityRouteCount','apiRouteCount'])check(a.deployment.control[k]===b.deployment.control[k],'authority_changed');
  const stage=v=>{const s=structuredClone(v);for(const k of ['DeploymentId','LastUpdatedDate','LastDeploymentStatusMessage'])delete s[k];return s;};
  check(equal(stage(a.raw.stage),stage(b.raw.stage))&&equal(a.summary,b.summary)&&equal(a.detailed,b.detailed)&&equal(a.template,b.template),'projection_changed');
  if(!returned)check(equal(a.apiDeployment,b.apiDeployment),'routing_changed');
 };
 if(c.initialEvent)await guard();
 else await append('registered_standalone_started',{runId:lock.runId,originalRunId:origin.runId,originalLockSha256:origin.lockSha256,originalJournalSha256:origin.journalSha256},new Date(started).toISOString());
 try{
  await guard();const rebuilt=await d.rebuild();check(rebuilt?.byteVerified===true&&rebuilt.sourceRebuilt===true
   &&rebuilt.zipSha256===candidate.manifest.zipSha256&&rebuilt.desktopCommit===current.desktop.commit&&rebuilt.mobileCommit===current.mobile.source.commit
   &&rebuilt.liveTargetObserved===false&&rebuilt.deployed===false&&rebuilt.phiAllowed===false,'source_rebuild');
  const first=await observe(),second=await observe();same(first,second);
  const before={contract:'synthetic-care-registered-standalone-before/1',runId:lock.runId,applicationSource:current,operatorSource:operator,
   original:origin,startedAt:new Date(started).toISOString(),observations:[first,second]},archived=await archive('standalone-before',before);
  await append('registered_standalone_before_archived',archived);await append('registered_standalone_rehearsal_admitted',{beforeSha256:archived.sha256});
  const input={candidate,current,observerSource:operator,artifact:saved.artifact,sourceText,latest:second.raw.fn};
  const recovery=await d.recovery(input,{
   recoverySid:'alp-care-intent-recovery-'+lock.runId,
   verify:()=>d.verifyLocal(journalBytes),
   record:async e=>{check(['registered_recovery_cases_verified','registered_recovery_route_permission_restored','registered_compatible_routing_completed'].includes(e.stage),'record_stage');
    const {stage,at,...detail}=e;await append(stage,detail,at);},
   admit:async e=>{const {stage,...detail}=e;check(['registered_recovery_permission_admitted','registered_recovery_switch_admitted',
    'registered_recovery_return_admitted','registered_recovery_compensating_return_admitted','registered_recovery_permission_cleanup_admitted'].includes(stage),'admission_stage');
    if(stage==='registered_recovery_permission_admitted')check(e.sid==='alp-care-intent-recovery-'+lock.runId,'sid');
    await append(stage,detail);if(stage==='registered_recovery_permission_admitted')writeAdmitted=true;},
  });
  verifyRegisteredStandaloneRecovery(recovery,input,operator,started,d.now(),d.parseIntent);
  // Preserve the real transport snapshots even if a later readback/binding
  // refuses completion. This is evidence, never deployment authority or a pass.
  await append('registered_standalone_recovery_archived',await archive('standalone-recovery',recovery));
  const retainedLineage=verifyRegisteredRetainedPermissionLineage(recovery.retainedPermissionLineage,
   Date.parse(recovery.startedAt),Date.parse(recovery.completedAt),'alp-care-intent-recovery-'+lock.runId);
  check(equal(databaseContents(recovery.databaseBefore),databaseContents(first.database))
   &&equal(databaseContents(recovery.databaseAfter),databaseContents(first.database)),'rehearsal_database_binding');
  const third=await observe(),fourth=await observe();same(first,third,true,retainedLineage);same(third,fourth);
  check(equal(recovery.initialControl,first.deployment.control)
   &&equal(usageComparable(recovery.transportWitness.restored.raw,d.now()),usageComparable(fourth.raw,d.now()))
   &&recovery.transportWitness.restored.policy===null&&recovery.transportWitness.initial===first.raw.stage.DeploymentId
   &&recovery.transportWitness.returnedDeployment===fourth.raw.stage.DeploymentId
   &&new Set([recovery.transportWitness.initial,recovery.transportWitness.retainedDeployment,recovery.transportWitness.returnedDeployment]).size===3,'recovery_transport_binding');
  const report={contract:'synthetic-care-registered-standalone-rehearsal/1',execution:'synthetic-staging',account:P.account,region:P.region,
   observedAt:new Date(d.now()).toISOString(),runId:lock.runId,applicationSource:current,operatorSource:operator,original:origin,
   originalRunOutcome:saved.originalRunOutcome,originalFailure:saved.originalFailure,originalResultPreserved:true,
   deploymentBefore:second.deployment,deploymentAfter:fourth.deployment,databaseBefore:first.database,databaseAfter:fourth.database,
   recovery,sourceRebuilt:true,repeatedReadbackVerified:true,exactBytesVerified:true,databasePreserved:true,recoveryRehearsed:true,
   routeRestoredAtObservation:true,temporaryPermissionAbsentAtObservation:true,reportIsNotAuthority:true,retryPerformed:false,
   proposalExecuted:false,codeUpdated:false,schemaChanged:false,hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,
   physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
  await append('registered_standalone_completed',await archive('standalone-completed',report));await guard();
  const parsed=await verifyRegisteredStandaloneCustody({lockBytes:c.lockBytes,journalBytes},current,operator,origin,d.now(),d.evidence,{settled:false});
  check(equal(parsed.completed,report),'completion_custody');return {...report,journalSha256:sha256(journalBytes)};
 }catch(error){
  // Do not let a failed disk/source guard fabricate a finding or clear custody.
  const message=error instanceof Error?error.message:'',code=/^synthetic_care_registered_release_refused:[a-z0-9_]{1,180}$/.test(message)
   ?message:'synthetic_care_registered_release_refused:standalone_rehearsal_failed';
  await append('registered_standalone_finding',{code,writeAdmitted});throw Error(code);
 }
}
