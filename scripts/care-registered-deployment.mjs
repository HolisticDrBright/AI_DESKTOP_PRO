/** Current registered-history execution/readback primitives. No public CLI,
 * saved-report loader or AWS transport is exposed. The eventual live runner
 * binds all observers itself, keeps durable custody and completes recovery. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {verifyCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical,CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyCareRegisteredPredecessorControl,verifyCareRegisteredSuccessorControl,verifyCareRegisteredRoutingControl,
 verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {careRegisteredCodeTemplateInputs,verifyCareRegisteredUnexecutedProposalViews,
 verifyCareRegisteredExecutedProposalViews} from './care-registered-code-change.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
import {verifyRegisteredUploadPreflight} from './upload-synthetic-care-registered-release.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('deployment_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const keys=(o,names)=>o&&typeof o==='object'&&!Array.isArray(o)&&equal(Object.keys(o).sort(),[...names].sort());
const stageConfig=value=>{const copy=structuredClone(value);
 for(const k of ['DeploymentId','LastUpdatedDate','LastDeploymentStatusMessage'])delete copy[k];return copy;};
const physicalResources=raw=>raw.StackResources.map(({LogicalResourceId,PhysicalResourceId,ResourceType})=>
 ({LogicalResourceId,PhysicalResourceId,ResourceType})).sort((a,b)=>a.LogicalResourceId.localeCompare(b.LogicalResourceId));
const databaseInventory=value=>{const copy=structuredClone(value);delete copy.observedAt;return copy;};

export function verifyCareRegisteredBeforeExecution(before,candidate,current,sourceText,artifact,started,now){
 verifyCareRegisteredCandidate(candidate,current);
 check(keys(before,['observedAt','raw','database','input','binding','summary','detailed','template']),'before_shape');
 const observed=Date.parse(before.observedAt);
 check(Number.isFinite(started)&&Number.isFinite(now)&&Number.isFinite(observed)
  &&observed>=started&&observed<=now&&now-observed<=120000,'before_freshness');
 const input=careRegisteredCodeTemplateInputs(sourceText,candidate,current,artifact);
 check(equal(input,before.input),'before_input');
 const control=verifyCareRegisteredPredecessorControl(before.raw,JSON.parse(sourceText));
 verifyCareRegisteredDatabase(before.database,current,started,observed);
 const projection=verifyCareRegisteredUnexecutedProposalViews(before.summary,before.detailed,before.template,input,
  before.binding,before.raw,sourceText,control,current,candidate,artifact,now);
 return {control,projection};
}

/** Exhaust actual post-execution observations. A completed change set is not
 * a byte proof, a byte proof is not an authority proof, and none is recovery. */
export function verifyCareRegisteredDeployment(w,candidate,current,sourceText,artifact,started,now){
 return verifyRegisteredDeploymentObservation(w,candidate,current,sourceText,artifact,started,now,current);
}
/** A stopped writer's historical admission remains historical. A new clean
 * operator inspects the database under its own source identity; neither raw
 * observation is rewritten to impersonate the other source. This profile
 * proves present deployment state, not completion of recovery or acceptance. */
export function verifyCareRegisteredReconciledDeployment(w,candidate,current,sourceText,artifact,operator,started,now){
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'reconciliation_operator_binding');
 check(Date.parse(w.after?.observedAt)>=started,'reconciliation_observation');
 // The database is read before the enclosing control-plane snapshot is
 // finished. Keep both historical timestamps intact and retain the database
 // age bound against that enclosing snapshot and the admission instant.
 const beforeStarted=Date.parse(w.before?.database?.observedAt);
 const result=verifyRegisteredDeploymentObservation(w,candidate,current,sourceText,artifact,beforeStarted,now,operator);
 return {...result,contract:'synthetic-care-registered-reconciled-deployment/1',operatorSource:structuredClone(operator),
  originalExecutionOutcome:'unconfirmed',retryPerformed:false};
}
/** Restoration observes the admitted retained route as itself. No observed
 * response is rewritten to impersonate LATEST, nor is recovery certified. */
export function verifyCareRegisteredRestorationDeployment(w,candidate,current,sourceText,artifact,operator,started,now,version){
 check(version===undefined||version==='2','restoration_version');
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'reconciliation_operator_binding');
 check(Date.parse(w.after?.observedAt)>=started,'reconciliation_observation');
 const result=verifyRegisteredDeploymentObservation(w,candidate,current,sourceText,artifact,Date.parse(w.before?.database?.observedAt),now,operator,version);
 return {...result,contract:'synthetic-care-registered-restoration-deployment/1',operatorSource:structuredClone(operator),
  observedRoutingVersion:version??'$LATEST',integrationNoOpProven:version===undefined,
  originalExecutionOutcome:'unconfirmed',retryPerformed:false};
}
function verifyRegisteredDeploymentObservation(w,candidate,current,sourceText,artifact,started,now,databaseCurrent,routingVersion){
 check(keys(w,['contract','current','artifact','executionAdmittedAt','before','after','codeBytes'])
  &&w.contract==='synthetic-care-registered-deployment-observation/1'
  &&equal(w.current,current)&&equal(w.artifact,artifact),'witness_binding');
 const admitted=Date.parse(w.executionAdmittedAt),beforeTime=Date.parse(w.before?.observedAt),afterTime=Date.parse(w.after?.observedAt);
 check(Number.isFinite(admitted)&&Number.isFinite(afterTime)&&admitted>=beforeTime&&admitted<=afterTime
  &&afterTime<=now&&now-afterTime<=120000,'after_freshness');
 // The pre-execution observation is historical after CFN settles. Validate it
 // at the recorded admission instant, not by rewriting its time to be fresh.
 const before=verifyCareRegisteredBeforeExecution(w.before,candidate,current,sourceText,artifact,started,admitted);
 const a=w.after,b=w.before;
 check(keys(a,['observedAt','raw','database','summary','detailed','template']),'after_shape');
 const projection=verifyCareRegisteredExecutedProposalViews(a.summary,a.detailed,a.template,b.input,b.binding,b.raw,
  sourceText,before.control,current,candidate,artifact,afterTime);
 for(const key of ['summary','detailed']){
  const expected=structuredClone(b[key]);expected.ExecutionStatus='EXECUTE_COMPLETE';
  check(equal(a[key],expected),'executed_projection_changed');
 }
 const control=routingVersion===undefined?verifyCareRegisteredSuccessorControl(a.raw,JSON.parse(sourceText),candidate,current,artifact)
  :verifyCareRegisteredRoutingControl(a.raw,JSON.parse(sourceText),candidate,current,artifact,routingVersion);
 check(a.raw.fn.RevisionId!==b.raw.fn.RevisionId,'revision_not_changed');
 const expectedFunction=structuredClone(b.raw.fn);
 for(const key of ['CodeSha256','CodeSize','RevisionId'])expectedFunction[key]=a.raw.fn[key];
 check(Object.hasOwn(a.raw.fn,'LastModified')===Object.hasOwn(b.raw.fn,'LastModified'),'function_metadata_changed');
 if(Object.hasOwn(a.raw.fn,'LastModified')){
  const oldModified=Date.parse(b.raw.fn.LastModified),newModified=Date.parse(a.raw.fn.LastModified);
  check(Number.isFinite(oldModified)&&Number.isFinite(newModified)&&newModified>=oldModified&&newModified<=now,'function_modified_time');
  expectedFunction.LastModified=a.raw.fn.LastModified;
 }
 check(equal(a.raw.fn,expectedFunction),'function_metadata_changed');
 for(const key of ['functionConfigurationSha256','routesSha256','authorizersSha256',
  'policySha256','roleSha256','identityRouteCount','apiRouteCount'])check(control[key]===before.control[key],'authority_changed');
 const expectedIntegrations=structuredClone(b.raw.integrations);
 if(routingVersion!==undefined){
  const owned=expectedIntegrations.Items.filter(v=>v.IntegrationId===R.integrationId);
  check(owned.length===1&&owned[0].IntegrationUri===R.latestArn,'restoration_integration');
  owned[0].IntegrationUri=R.latestArn+':'+routingVersion;
 }
 check(equal(a.raw.integrations,expectedIntegrations),'authority_changed');
 check(equal(physicalResources(a.raw.resources),physicalResources(b.raw.resources)),'resource_identity_changed');
 check(equal(a.raw.foundation,b.raw.foundation),'foundation_changed');
 check(equal(stageConfig(a.raw.stage),stageConfig(b.raw.stage)),'stage_configuration_changed');
 check(Buffer.isBuffer(w.codeBytes)&&w.codeBytes.equals(candidate.zip),'downloaded_bytes');
 const db=verifyCareRegisteredDatabase(a.database,databaseCurrent,admitted,afterTime);
 const beforeDatabase=databaseInventory(b.database),afterDatabase=databaseInventory(db);
 // Both identities were separately checked above. Compare the complete
 // database inventory excluding only the source attribution and read time.
 delete beforeDatabase.operatorSource;delete afterDatabase.operatorSource;
 check(equal(afterDatabase,beforeDatabase),'database_changed');
 return {contract:'synthetic-care-registered-deployment-readback/1',execution:'synthetic-staging',account:P.account,
  observedAt:a.observedAt,current:structuredClone(current),zipSha256:candidate.manifest.zipSha256,
  codeVersion:artifact.versionId,stackId:b.binding.stackId,changeSetId:b.binding.id,
  predecessorControl:before.control,control,latest:structuredClone(a.raw.fn),projection,
  exactBytesVerified:true,authorityPreserved:true,resourceIdentitiesPreserved:true,databasePreserved:true,
  integrationDependencyReadbackVerified:true,integrationNoOpProven:true,reportIsNotAuthority:true,
  deployed:true,compatibleRecoveryRequired:true,recoveryRehearsed:false,schemaChanged:false,
  hostedAcceptance:false,releaseAccepted:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}

/** One admitted execution, then observation of that exact target. Losing the
 * reply or reaching this poll budget never authorizes another execute call,
 * another proposal, a Lambda rollback, or retirement of admitted custody. */
export async function runCareRegisteredExecution(candidate,current,sourceText,artifact,port){
 const started=port.now();verifyCareRegisteredCandidate(candidate,current);
 const caller=await port.identity();assertSyntheticMemberIdentity(caller);
 const guard=async()=>{
  check(equal(await port.current(),current),'source_changed');
  const actual=await port.identity();assertSyntheticMemberIdentity(actual);check(equal(actual,caller),'principal_changed');
  await port.custody();
 };
 await guard();const preparation=await port.preflight();
 verifyRegisteredUploadPreflight(preparation,candidate,current,port.now());await guard();
 const storage=async()=>{const r=await port.storage();
  check(r?.state==='stored_exact_version'&&r.bytesVerified===true&&r.versionId===artifact.versionId
   &&r.sha256===candidate.manifest.zipSha256&&r.bytes===candidate.zip.length&&r.deletionCertified===false,'storage_binding');return r;};
 const firstStorage=await storage(),before=await port.before();
 const first=verifyCareRegisteredBeforeExecution(before,candidate,current,sourceText,artifact,started,port.now());await guard();
 // Two complete service/database observations can outlive the initial
 // preflight. Renew from the actual observer, not a saved report or timestamp
 // edit, before the final fresh observation and admission.
 const renewed=await port.preflight();
 verifyRegisteredUploadPreflight(renewed,candidate,current,port.now());
 check(equal(renewed.control,preparation.control)&&equal(first.control,renewed.control),'renewed_control_changed');await guard();
 // A final complete read is necessary after local preparation. Timestamp or
 // saved receipt flags cannot stand in for this observation.
 const finalBefore=await port.before();
 const last=verifyCareRegisteredBeforeExecution(finalBefore,candidate,current,sourceText,artifact,started,port.now());
 const comparable=b=>{const copy=structuredClone(b);delete copy.observedAt;delete copy.database.observedAt;
  delete copy.raw.role.Role.RoleLastUsed;for(const group of copy.raw.logGroups.logGroups)delete group.storedBytes;return copy;};
 check(equal(first,last)&&equal(comparable(before),comparable(finalBefore))&&equal(last.control,preparation.control),'before_changed');
 check(equal(await storage(),firstStorage),'storage_changed');await guard();
 verifyRegisteredUploadPreflight(renewed,candidate,current,port.now());
 const admitted=new Date(port.now()).toISOString();
 verifyCareRegisteredBeforeExecution(finalBefore,candidate,current,sourceText,artifact,started,port.now());
 const binding=finalBefore.binding,token=sha256(canonical({contract:'care-registered-execution-input/1',binding,current,artifact}));
 await port.admit({stage:'registered_change_execute_admitted',at:admitted,stackId:binding.stackId,changeSetId:binding.id,clientToken:token});
 let replyLost=false;
 try{await port.execute(binding,token);}catch{replyLost=true;
  await port.record({stage:'registered_change_execute_reply_unconfirmed',changeSetId:binding.id});}
 let terminal=false;
 for(let n=0;n<120;n++){
  await guard();const o=await port.execution(binding),stack=o.stack?.Stacks?.[0],set=o.changeSet;
  check(o.stack?.Stacks?.length===1&&stack.StackId===binding.stackId&&stack.StackName===P.stack
   &&set?.ChangeSetId===binding.id&&set.ChangeSetName===binding.name&&set.StackId===binding.stackId
   &&set.StackName===P.stack&&!set.NextToken,'execution_identity');
  check(['UPDATE_COMPLETE','UPDATE_IN_PROGRESS','UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'].includes(stack.StackStatus)
   &&set.Status==='CREATE_COMPLETE'&&['AVAILABLE','EXECUTE_IN_PROGRESS','EXECUTE_COMPLETE'].includes(set.ExecutionStatus),'execution_failed');
  if(stack.StackStatus==='UPDATE_COMPLETE'&&set.ExecutionStatus==='EXECUTE_COMPLETE'){terminal=true;break;}
  await port.pause(2000);
 }
 check(terminal,'execution_observation_unconfirmed');
 await port.record({stage:'registered_change_execute_terminal',changeSetId:binding.id,replyLost});await guard();
 const observed=await port.after(binding),w={contract:'synthetic-care-registered-deployment-observation/1',current,artifact,
  executionAdmittedAt:admitted,before:finalBefore,after:observed.after,codeBytes:observed.codeBytes};
 const result=verifyCareRegisteredDeployment(w,candidate,current,sourceText,artifact,started,port.now());
 await guard();await port.record({stage:'registered_deployed_bytes_control_verified',changeSetId:binding.id,
  revision:result.latest.RevisionId,zipSha256:result.zipSha256});
 return {...result,replyLost};
}
