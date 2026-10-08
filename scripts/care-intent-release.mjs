/** In-lock successor continuation. Ports are live observers in the eventual
 * fixed-target runner; injected values exist solely for credential-free tests.
 * There is deliberately no report-loading, approval flag or standalone CLI. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {INTENT_RELEASE,verifyCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {verifyIntentUploadPreparation} from './upload-synthetic-care-intent-release.mjs';
import {verifyCareIntentDependencyViews} from './prepare-synthetic-care-intent-code-change.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage,
 verifyRecoveryPhase,verifyPostParentReceiptPhase,verifyRecoveryMetric} from './care-recovery-routing.mjs';
import {PERSONA_EMAILS} from './verify-synthetic-care-consumer.mjs';
import {verifyCareIntentResumedDeployment,verifyCareIntentResumptionBindings} from './care-intent-resumption-deployment.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('continuation_'+code);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const functionFields=['FunctionName','Runtime','Handler','MemorySize','Timeout','Role','Environment','Architectures',
 'Layers','VpcConfig','KMSKeyArn','PackageType','EphemeralStorage','TracingConfig','LoggingConfig','FileSystemConfigs',
 'DeadLetterConfig','SnapStart','ImageConfigResponse','MasterArn','SigningProfileVersionArn','SigningJobArn','RuntimeVersionConfig',
 'CapacityProviderConfig','DurableConfig','TenancyConfig'];
export const careIntentFunctionConfig=v=>Object.fromEntries(functionFields.map(k=>[k,v?.[k]]));
const config=careIntentFunctionConfig;
const stageConfig=v=>{const s=structuredClone(v);for(const k of ['DeploymentId','LastUpdatedDate','LastDeploymentStatusMessage'])delete s[k];return s;};
const resourceIds=value=>{
 check(Array.isArray(value?.StackResources)&&!value.NextToken,'resource_inventory');
 const seen=new Set();return value.StackResources.map(r=>{
  check(typeof r.LogicalResourceId==='string'&&!seen.has(r.LogicalResourceId)
   &&typeof r.PhysicalResourceId==='string'&&typeof r.ResourceType==='string'
   &&['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(r.ResourceStatus),'resource_identity');
  seen.add(r.LogicalResourceId);return {logical:r.LogicalResourceId,physical:r.PhysicalResourceId,type:r.ResourceType};
 }).sort((a,b)=>a.logical.localeCompare(b.logical));
};
function sameControl(actual,expected){
 for(const k of ['routesSha256','authorizersSha256','roleSha256','policySha256'])
  check(hash(actual?.[k])&&actual[k]===expected[k],'authority_drift');
 check(actual?.routeCount===51&&actual.iamVerified===true&&actual.loggingVerified===true&&actual.phiAllowed===false,'authority_scope');
}
/** Prove actual deployed bytes and the complete preserved configuration. A
 * classified proposal alone is never sufficient. No execute call lives here. */
export function verifyCareIntentDeployment(w,candidate,current,artifact,preparation,started,now){
 verifyCareIntentCandidate(candidate.manifest,candidate.release,candidate.bundle,candidate.zip,current);
 const observed=Date.parse(w?.observedAt);
 check(Number.isFinite(started)&&Number.isFinite(now)&&observed>=started&&observed<=now&&now-observed<=120000,'deployment_freshness');
 // Preparation is historical by the time CFN settles; validate it at its own
 // observed instant, then bind it to the separately fresh raw observations.
 verifyIntentUploadPreparation(preparation,candidate.manifest,current,Date.parse(preparation.observedAt));
 check(canonical(w.current)===canonical(current)&&canonical(w.artifact)===canonical(artifact),'deployment_source');
 const b=w.before,a=w.after;
 verifyCareIntentDependencyViews(b?.summary,b?.detailed,b?.proposedTemplate,b?.input,b?.binding,b?.live);
 check(b.live.fn.RevisionId===preparation.control.revision
  &&sha256(canonical(b.live.template))===preparation.control.templateSha256,'deployment_predecessor');
 check(artifact.bucket===P.bucket&&artifact.key===candidate.manifest.key&&artifact.sha256===candidate.manifest.zipSha256
  &&artifact.bytes===candidate.zip.length&&artifact.encryption==='aws:kms'&&artifact.kmsKeyArn===P.keyArn
  &&artifact.exactVersionReadbackVerified===true&&typeof artifact.versionId==='string'&&artifact.versionId!=='null'
  &&artifact.versionId.length>0&&artifact.versionId.length<=1024,'deployment_artifact');
 const code=b.input.template.Resources.IdentityApiFunction.Properties.Code;
 check(canonical(code.S3Bucket)===canonical({Ref:'LambdaCodeBucket'})&&code.S3ObjectVersion===artifact.versionId
  &&b.input.parameters.find(p=>p.ParameterKey==='LambdaCodeKey')?.ParameterValue===artifact.key,'deployment_code_pointer');
 check(a?.stack?.Stacks?.length===1&&a.stack.Stacks[0].StackId===b.binding.stackId
  &&a.stack.Stacks[0].StackName===P.stack&&a.stack.Stacks[0].StackStatus==='UPDATE_COMPLETE'
  &&a.changeSet?.ChangeSetId===b.binding.id&&a.changeSet.StackId===b.binding.stackId
  &&a.changeSet.Status==='CREATE_COMPLETE'&&a.changeSet.ExecutionStatus==='EXECUTE_COMPLETE'
  &&!a.changeSet.NextToken,'deployment_terminal');
 const parameterMap=items=>Object.fromEntries(items.map(p=>[p.ParameterKey,p.ParameterValue]));
 check(Array.isArray(a.stack.Stacks[0].Parameters)&&a.stack.Stacks[0].Parameters.length===11&&new Set(a.stack.Stacks[0].Parameters.map(p=>p.ParameterKey)).size===11
  &&canonical(parameterMap(a.stack.Stacks[0].Parameters))===canonical(parameterMap(b.summary.Parameters)),'deployment_parameters');
 check(canonical(a.template)===canonical(b.input.template)
  &&canonical(resourceIds(a.resources))===canonical(resourceIds(b.live.resources)),'deployment_template_resources');
 check(a.fn?.FunctionArn===R.latestArn&&a.fn.Version==='$LATEST'&&a.fn.State==='Active'&&a.fn.LastUpdateStatus==='Successful'
  &&typeof a.fn.RevisionId==='string'&&a.fn.RevisionId.length>0&&a.fn.RevisionId!==b.live.fn.RevisionId
  &&a.fn.CodeSha256===Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64')&&a.fn.CodeSize===candidate.zip.length
  &&canonical(config(a.fn))===canonical(config(b.live.fn)),'deployment_function');
 check(Buffer.isBuffer(w.codeBytes)&&w.codeBytes.equals(candidate.zip),'deployment_download');
 verifyRecoveryIntegration(a.integration,R.latestArn);verifyRecoveryStage(a.stage);
 verifyRecoveryStage(b.stage);
 check(canonical(a.integration)===canonical(b.live.integration)&&canonical(stageConfig(a.stage))===canonical(stageConfig(b.stage)),
  'deployment_integration_stage');
 sameControl(a.control,preparation.control);
 check(a.control.integrationsSha256===preparation.control.integrationsSha256
  &&a.control.templateSha256===sha256(canonical(a.template))&&a.control.revision===a.fn.RevisionId
  &&a.control.codeSha256===a.fn.CodeSha256,'deployment_control');
 verifyRestoredTransport(a.transport,a.transport,a.fn);
 check(canonical(a.transport.integration)===canonical(a.integration)&&canonical(a.transport.stage)===canonical(a.stage)
  &&a.transport.routesSha256===a.control.routesSha256&&a.transport.authorizersSha256===a.control.authorizersSha256
  &&a.transport.latestPolicySha256===a.control.policySha256,'deployment_transport_binding');
 return {current:structuredClone(current),latest:structuredClone(a.fn),transport:structuredClone(a.transport),
  observedAt:w.observedAt,zipSha256:candidate.manifest.zipSha256,codeVersion:artifact.versionId};
}
function verifyRestoredTransport(actual,expected,latest){
 verifyRecoveryIntegration(actual?.integration,R.latestArn);verifyRecoveryStage(actual?.stage);
 check(actual.policy===null&&actual.revisionId===latest.RevisionId
  &&['routesSha256','authorizersSha256','otherIntegrationsSha256','latestPolicySha256'].every(k=>hash(actual[k]))
  &&canonical(actual)===canonical(expected),'restored_transport');
}
/** Distinct profile: the retained version must be intent-aware, exact-byte
 * matched and freshly exercised. Historical version 1 cannot satisfy this. */
export function verifyCareIntentRecovery(r,deployed,candidate,baseline,started,now){
 const begin=Date.parse(r?.startedAt),end=Date.parse(r?.completedAt);
 check(r?.contract==='synthetic-care-intent-routing-rehearsal/1'&&r.scope==='intent-code-before-schema'
  &&r.execution==='synthetic-staging'&&r.account===P.account&&r.verdict==='pass'
  &&canonical(r.current)===canonical(deployed.current)&&r.zipSha256===deployed.zipSha256
  &&Number.isFinite(begin)&&Number.isFinite(end)&&begin>=started&&end>=begin&&end<=now&&now-end<=300000,'recovery_scope_freshness');
 const v=r.retained?.configuration,version=v?.Version;
 check(typeof version==='string'&&/^[1-9][0-9]{0,19}$/.test(version)&&version!=='1'
  &&v.FunctionArn===`${R.latestArn}:${version}`&&v.State==='Active'
  &&(!v.LastUpdateStatus||v.LastUpdateStatus==='Successful')&&canonical(config(v))===canonical(config(deployed.latest))
  &&v.CodeSha256===deployed.latest.CodeSha256&&v.CodeSize===candidate.zip.length
  &&Buffer.isBuffer(r.retained.codeBytes)&&r.retained.codeBytes.equals(candidate.zip),'compatible_retained_version');
 for(const k of ['functionalRoutingRecoveryVerified','returnToCandidateVerified','temporaryPermissionRemoved','originalRoutingRestored'])check(r[k]===true,'recovery_unfinished');
 for(const k of ['schemaChanged','canonicalRegistered','hostedAcceptance','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])check(r[k]===false,'recovery_claims');
 check(canonical(r.databaseBefore)===canonical(baseline)&&canonical(r.databaseAfter)===canonical(baseline),'recovery_database_drift');
 const ids=[],receipts=[];
 for(const phase of ['baseline','retained','returned']){
  const observations=r.observations?.[phase];check(Array.isArray(observations)&&observations.length===25,'recovery_cases');
  const consumer=verifyRecoveryPhase(observations.filter(v=>v.case!=='existing_cancelled_receipt'));
  const phaseReceipts=verifyPostParentReceiptPhase(observations.filter(v=>v.case==='existing_cancelled_receipt'));
  ids.push(...consumer.map(v=>v.requestId),...phaseReceipts.map(v=>v.requestId));
  receipts.push(phaseReceipts.map(({requestId:_request,...rest})=>rest));
 }
 check(new Set(ids).size===75&&receipts.every(v=>canonical(v)===canonical(receipts[0])),'recovery_request_or_receipt_replay');
 const metric=r.metricWitness;
 check(Number.isSafeInteger(metric?.start)&&Number.isSafeInteger(metric.end)&&metric.minimum===25
  &&metric.functionName===P.functionName&&metric.qualifier===version
  &&metric.start>=Math.floor(begin/60000)*60000&&metric.end<=Math.ceil(end/60000)*60000&&metric.end>metric.start,'recovery_metric_window');
 verifyRecoveryMetric(metric.response,metric.start,metric.end,25);
 const t=r.transportWitness;
 check(t&&[t.originalDeployment,t.retainedDeployment,t.returnedDeployment].every(v=>/^[a-z0-9]{1,20}$/.test(v??''))
  &&new Set([t.originalDeployment,t.retainedDeployment,t.returnedDeployment]).size===3
  &&t.restored?.stage?.DeploymentId===t.returnedDeployment,'recovery_deployments');
 verifyRestoredTransport(t.restored,deployed.transport,deployed.latest);
 // Missing-function denial is independently exercised through Gateway for all
 // five subjects, and both code versions, before any lasting schema release.
 const denials=r.preSchemaDenials,seen=new Set();
 check(Array.isArray(denials)&&denials.length===20,'preschema_denials');
 for(const x of denials){const key=`${x.phase}:${x.persona}:${x.action}`;
  check(['baseline','retained'].includes(x.phase)&&Object.keys(PERSONA_EMAILS).includes(x.persona)
   &&['prepare_erasure','discover_erasure_requests'].includes(x.action)&&!seen.has(key)
   &&x.status===503&&x.error==='service_unavailable'&&x.verified===true
   &&/^[A-Za-z0-9_=+/-]{8,160}$/.test(x.requestId??'')&&!ids.includes(x.requestId)
   &&hash(x.bodySha256),'preschema_denial');seen.add(key);ids.push(x.requestId);
 }
 return structuredClone(t.restored);
}
function schemaResult(r,command,current,baseline){
 const successor=command==='upgrade'||command==='postinspect',mode=command==='postinspect'?'inspect':command;
 check(r?.contract==='care-erasure-intent-upgrade/1'&&r.command===mode&&r.execution==='synthetic-staging'
  &&r.awsAccountId===P.account&&r.foundation===P.foundation&&r.phiAllowed===false
  &&canonical(r.operatorSource)===canonical({sourceCommit:current.desktop.commit,clean:true})
  &&r.observedMigrationCount===(successor?48:47)&&r.sourceMigrationCount===(successor?47:46)
  &&r.tableCount===(successor?89:88)&&r.rowCount===baseline.rowCount
  &&r.originalRowCount===baseline.rowCount&&r.originalDataSha256===baseline.dataSha256
  &&r.completeRowCount===baseline.rowCount&&r.intentRowCount===0&&hash(r.completeDataSha256)
  &&r.dataSha256===(command==='postinspect'?r.completeDataSha256:baseline.dataSha256)
  &&(successor||r.completeDataSha256===baseline.dataSha256)
  &&r.schemaSha256===baseline.schemaSha256&&r.dataPreserved===true&&r.schemaPreserved===true
  &&r.applied===(command==='upgrade')&&r.alreadyApplied===(command==='postinspect')&&r.rolledBack===(command==='rehearse')
  &&r.fromLedgerSha256===current.migrations.liveBefore&&r.toLedgerSha256===INTENT_RELEASE.liveAfter
  &&r.referenceLedgerSha256===current.migrations.reference
  &&['canonicalRegistered','hostedAcceptance','recoveryAcceptance','activationApproved'].every(k=>r[k]===false),'schema_'+command);
 return structuredClone(r);
}
/** Recovery and deployment witnesses are supplied only by an in-process live
 * pipeline under its shared custody. Snapshot them before calling any port.
 * An unknown commit is independently inspected once, never blindly retried. */
export async function releaseCareIntent(supplied,d){
 check(Buffer.isBuffer(supplied?.candidate?.bundle)&&Buffer.isBuffer(supplied?.candidate?.zip)
  &&Buffer.isBuffer(supplied?.deployment?.codeBytes)&&Buffer.isBuffer(supplied?.recovery?.retained?.codeBytes),'binary_observers');
 const {candidate,current,artifact,preparation,deployment,recovery}=structuredClone(supplied);
 // structuredClone turns Node Buffers into Uint8Arrays; only binary fields are
 // restored, never arbitrary caller-provided report fields or approval values.
 for(const key of ['bundle','zip'])candidate[key]=Buffer.from(candidate[key]);
 deployment.codeBytes=Buffer.from(deployment.codeBytes);
 recovery.retained.codeBytes=Buffer.from(recovery.retained.codeBytes);
 const unchanged=async()=>check(canonical(await d.current())===canonical(current),'source_changed');
 await unchanged();const deployed=verifyCareIntentDeployment(deployment,candidate,current,artifact,preparation,d.started,d.now());
 const baseline=preparation.database;
 return continueIntentSchema({candidate,current,operatorCurrent:current,deployed,baseline,recovery},d);
}
/** The resumed runner supplies freshly reconstructed source identities and
 * actual executed deployment observations in-process. There is no report-load
 * or operator override in the CLI. Historical application metadata remains
 * immutable; the database port must identify the current clean operator. */
export async function releaseResumedCareIntent(supplied,d){
 check(Buffer.isBuffer(supplied?.candidate?.bundle)&&Buffer.isBuffer(supplied?.candidate?.zip)
  &&Buffer.isBuffer(supplied?.deployment?.codeBytes)
  &&Buffer.isBuffer(supplied?.deployment?.retained?.codeBytes)&&Buffer.isBuffer(supplied?.recovery?.retained?.codeBytes),'resumed_binary_observers');
 const {candidate,current,operatorCurrent,deployment,baseline,recovery}=structuredClone(supplied);
 for(const key of ['bundle','zip'])candidate[key]=Buffer.from(candidate[key]);
 deployment.codeBytes=Buffer.from(deployment.codeBytes);
 deployment.retained.codeBytes=Buffer.from(deployment.retained.codeBytes);recovery.retained.codeBytes=Buffer.from(recovery.retained.codeBytes);
 verifyCareIntentResumptionBindings(current,operatorCurrent);
 check(canonical(await d.current())===canonical(operatorCurrent),'source_changed');
 const deployed=verifyCareIntentResumedDeployment(deployment,candidate,current,operatorCurrent,d.started,d.now());
 return continueIntentSchema({candidate,current,operatorCurrent,deployed,baseline,recovery},d);
}
async function continueIntentSchema({candidate,current,operatorCurrent,deployed,baseline,recovery},d){
 verifyCareIntentResumptionBindings(current,operatorCurrent);
 const unchanged=async()=>check(canonical(await d.current())===canonical(operatorCurrent),'source_changed');
 const restored=verifyCareIntentRecovery(recovery,deployed,candidate,baseline,d.started,d.now());
 const guard=async()=>{await unchanged();verifyCareIntentRecovery(recovery,deployed,candidate,baseline,d.started,d.now());
  verifyRestoredTransport(await d.transport(),restored,deployed.latest);};
 const invoke=async(command)=>schemaResult(await d.schema(command==='postinspect'?'inspect':command),command,operatorCurrent,baseline);
 await guard();const before=await invoke('inspect');
 await d.record({stage:'intent_rollback_admitted'});const rehearsal=await invoke('rehearse');
 await guard();await d.admit({stage:'intent_schema_commit_admitted',liveBefore:current.migrations.liveBefore,liveAfter:current.migrations.liveAfter});
 let committed,commitResponseLost=false,receipt;
 try{receipt=await d.schema('upgrade');}
 catch(error){
  // Only the actual database port's unresolved COMMIT transport observation
  // permits reconciliation. Invalid receipts and known rejections are findings.
  check(error?.category==='upgrade_failed'&&error.commitOutcomeUnknown===true,'commit_not_reconcilable');
  const reconciled=await invoke('postinspect');
  committed={status:'reconciled_without_commit_receipt',successorSnapshot:reconciled};commitResponseLost=true;
  await d.record({stage:'intent_schema_commit_reconciled',receiptVerified:false});
 }
 if(!commitResponseLost)committed=schemaResult(receipt,'upgrade',operatorCurrent,baseline);
 await unchanged();const after=await invoke('postinspect');
 const completed=commitResponseLost?committed.successorSnapshot:committed;
 check(after.completeDataSha256===completed.completeDataSha256,'schema_successor_snapshot');
 verifyRestoredTransport(await d.transport(),restored,deployed.latest);
 await d.record({stage:'intent_schema_independent_readback',liveAfter:current.migrations.liveAfter,commitResponseLost});
 return {contract:'synthetic-care-intent-schema-release/1',execution:'synthetic-staging',account:P.account,current,operatorCurrent,
  before,rehearsal,committed,after,commitResponseLost,compatibleRecoveryVerified:true,schemaChanged:true,
  preservationVerified:true,canonicalRegistered:false,preparedErasedJourneyVerified:false,
  lostReplyJourneyVerified:false,secondDeviceJourneyVerified:false,fullJourneyAcceptance:false,
  physicalDeviceAcceptance:false,qualificationEvidence:false,activationEvidence:false,phiAllowed:false,paidMobileBuildStarted:false};
}
