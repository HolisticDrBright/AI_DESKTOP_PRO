/** Current-schema recovery to the exact older intent-aware version, then back
 * to current bytes. No migration, erasure, report loader or CLI is exposed. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,assertCareRegisteredCurrent,verifyCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCareRegisteredRoutingControl,verifyCareRegisteredFunction,verifyCareRegisteredSuccessorFunction,
 verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryPhase,verifyPostParentReceiptPhase,verifyRecoveryMetric} from './care-recovery-routing.mjs';
import {intentRecoveryPermission,verifyIntentRecoveryPolicy} from './care-intent-routing.mjs';
import {PERSONA_EMAILS} from './verify-synthetic-care-consumer.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('routing_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const keys=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&equal(Object.keys(v).sort(),[...n].sort());
const stageConfig=v=>{const s=structuredClone(v);for(const k of ['DeploymentId','LastUpdatedDate','LastDeploymentStatusMessage'])delete s[k];return s;};
const databaseInventory=v=>{const s=structuredClone(v);delete s.observedAt;return s;};
export const CARE_REGISTERED_RECOVERY_VERSION='2';

/** A permission operation can change Lambda's revision and modification time.
 * This exception belongs to one durably admitted operation, not to every read.
 * All other raw configuration, code bytes and policy remain exact. */
function retainedPermissionTransition(before,after,policy,start,end){
 check(equal(after.policy,policy),'retained_permission_policy');
 const immutable=value=>{const copy=structuredClone(value);delete copy.policy;
  delete copy.configuration.RevisionId;delete copy.configuration.LastModified;return copy;};
 check(equal(immutable(before),immutable(after)),'retained_permission_configuration');
 const old=before.configuration,next=after.configuration,
  revisionChanged=old.RevisionId!==next.RevisionId,timeChanged=old.LastModified!==next.LastModified;
 check(revisionChanged===timeChanged,'retained_permission_metadata');
 if(revisionChanged){
  const oldTime=Date.parse(old.LastModified),newTime=Date.parse(next.LastModified);
  check(Number.isFinite(start)&&Number.isFinite(end)&&end>=start
   &&typeof old.LastModified==='string'&&typeof next.LastModified==='string'
   &&Number.isFinite(oldTime)&&Number.isFinite(newTime)&&newTime>=oldTime&&newTime>=start&&newTime<=end
   &&typeof next.RevisionId==='string'&&next.RevisionId.length>0&&next.RevisionId.length<=160,'retained_permission_window');
 }
 return structuredClone(after);
}

/** Revalidate the full snapshots, not caller-supplied "verified" flags. */
export function verifyRegisteredRetainedPermissionLineage(lineage,started,completed,expectedSid){
 check(keys(lineage,['sid','operations'])&&(!expectedSid||lineage.sid===expectedSid),'retained_lineage_identity');
 intentRecoveryPermission(lineage.sid,CARE_REGISTERED_RECOVERY_VERSION);
 check(Array.isArray(lineage.operations)&&lineage.operations.length===2,'retained_lineage_count');
 let previous;
 for(const [index,operation] of lineage.operations.entries()){
  check(keys(operation,['action','startedAt','observedAt','before','after'])
   &&operation.action===(index===0?'add':'remove'),'retained_lineage_operation');
  check(keys(operation.before,['configuration','sha256','bytes','policy'])
   &&keys(operation.after,['configuration','sha256','bytes','policy'])
   &&operation.before.sha256===C.predecessorZip&&operation.before.bytes===C.predecessorBytes,'retained_lineage_bytes');
  verifyCareRegisteredFunction(operation.before.configuration,true);
  verifyCareRegisteredFunction(operation.after.configuration,true);
  const start=Date.parse(operation.startedAt),end=Date.parse(operation.observedAt);
  check(Number.isFinite(start)&&Number.isFinite(end)&&start>=started&&end<=completed
   &&(!previous||start>=Date.parse(previous.observedAt)),'retained_lineage_time');
  if(index===0){check(operation.before.policy===null,'retained_lineage_initial_policy');
   verifyIntentRecoveryPolicy(operation.after.policy,lineage.sid,CARE_REGISTERED_RECOVERY_VERSION,true);
  }else{check(equal(operation.before,previous.after)&&operation.after.policy===null,'retained_lineage_chain');
   verifyIntentRecoveryPolicy(operation.before.policy,lineage.sid,CARE_REGISTERED_RECOVERY_VERSION,true);
  }
  retainedPermissionTransition(operation.before,operation.after,index===0?operation.after.policy:null,start,end);
  previous=operation;
 }
 return {before:structuredClone(lineage.operations[0].before),after:structuredClone(previous.after)};
}

/** The parser is compiled from the bound application contract by the live
 * observer. This verifies real answers rather than accepting a verified flag. */
export function verifyRegisteredIntentAnswer(action,status,value,expectedId,parse){
 check(typeof parse==='function'&&['discover_erasure_requests','prepare_erasure'].includes(action),'intent_action');
 if(action==='prepare_erasure'){
  check(status===400&&keys(value,['error'])&&value.error==='request_invalid','idless_prepare_refusal');
 }else{
  check(status===200&&keys(value,['data']),'discovery_status');
  const data=parse({action,limit:100},value.data);
  check(equal(data,value.data)&&data.action===action&&data.next===null
   &&data.coverage==='committed_owner_records_not_global_clearance'
   &&data.items.filter(v=>v.requestId===expectedId&&v.outcome==='cancelled'&&v.receipt===null).length===1,'discovery_receipt');
 }
 return {status,bodySha256:sha256(canonical(value))};
}
export function verifyRegisteredIntentPhase(values,phase,receipts,parse){
 check(Array.isArray(values)&&values.length===10,'intent_count');
 const seen=new Set(),requests=new Set();
 for(const v of values){
  check(keys(v,['persona','phase','action','requestId','status','value','bodySha256','expectedRequestId'])
   &&Object.hasOwn(PERSONA_EMAILS,v.persona)&&v.phase===phase,'intent_shape');
  const receipt=receipts.find(r=>r.persona===v.persona),pair=v.persona+':'+v.action;
  check(receipt&&receipt.erasureRequestId===v.expectedRequestId&&!seen.has(pair)
   &&/^[A-Za-z0-9_=+/-]{8,160}$/.test(v.requestId??'')&&!requests.has(v.requestId),'intent_identity');
  const answer=verifyRegisteredIntentAnswer(v.action,v.status,v.value,v.expectedRequestId,parse);
  check(answer.bodySha256===v.bodySha256,'intent_body');seen.add(pair);requests.add(v.requestId);
 }
 return structuredClone(values);
}
/** All mutating ports must flush admission before the request. An incomplete
 * observation or failed restoration leaves admitted operator custody intact. */
export async function rehearseCareRegisteredRouting(input,d,sid){
 const {candidate,current,artifact,sourceText,latest}=input;
 const observerSource=input.observerSource??current;assertCareRegisteredCurrent(observerSource);
 check(equal(observerSource.mobile,current.mobile)&&equal(observerSource.migrations,current.migrations)
  &&observerSource.templateSha256===current.templateSha256,'observer_binding');
 check(equal(observerSource,current)||typeof d.observerCurrent==='function','observer_guard_required');
 verifyCareRegisteredCandidate(candidate,current);
 const source=JSON.parse(sourceText);check(sha256(sourceText)===current.templateSha256,'source_template');
 const version=CARE_REGISTERED_RECOVERY_VERSION,uri=R.latestArn+':'+version;
 intentRecoveryPermission(sid,version);verifyCareRegisteredSuccessorFunction(latest,candidate,current);
 const started=d.now(),events=[],observations={},intents={},requestIds=new Set();
 const record=async(stage,detail={})=>{const e={stage,at:new Date(d.now()).toISOString(),...detail};await d.record(e);events.push(e);};
 const caller=await d.identity();assertSyntheticMemberIdentity(caller);
 const sourceGuard=async()=>{check(equal(await d.current(),current),'source_changed');await d.custody();
  check(equal(await (d.observerCurrent??d.current)(),observerSource),'observer_source_changed');
  const fresh=await d.identity();assertSyntheticMemberIdentity(fresh);check(equal(fresh,caller),'principal_changed');};
 await sourceGuard();
 const before=verifyCareRegisteredDatabase(await d.inspect(),observerSource,started,d.now()),initial=await d.transport();
 const initialControl=verifyCareRegisteredRoutingControl(initial.raw,source,candidate,current,artifact);
 check(equal(initial.raw.fn,latest)&&initial.policy===null,'initial_transport');
 const retained=await d.retained();
 check(equal(verifyCareRegisteredFunction(retained.configuration,true),verifyCareRegisteredSuccessorFunction(latest,candidate,current))
  &&retained.policy===null&&retained.sha256===C.predecessorZip&&retained.bytes===C.predecessorBytes,'retained_predecessor');
 let expectedRetained=structuredClone(retained),permissionStarted,permissionObserved=false;
 const retainedPermissionLineage={sid,operations:[]};
 const permissionObservation=async(action,prior,actual,policy,start)=>{
  const end=d.now(),checked=retainedPermissionTransition(prior,actual,policy,start,end);
  retainedPermissionLineage.operations.push({action,startedAt:new Date(start).toISOString(),observedAt:new Date(end).toISOString(),
   before:structuredClone(prior),after:checked});
  return checked;
 };
 const guard=(o,target)=>{
  const proof=verifyCareRegisteredRoutingControl(o.raw,source,candidate,current,artifact,target===uri?version:undefined);
  check([R.latestArn,uri].includes(target)&&equal(o.raw.fn,latest)
   &&equal(stageConfig(o.raw.stage),stageConfig(initial.raw.stage)),'transport_drift');
  for(const k of ['functionConfigurationSha256','resourcesSha256','templateSha256','parametersSha256',
   'routesSha256','authorizersSha256','policySha256','roleSha256','identityRouteCount','apiRouteCount'])
   check(proof[k]===initialControl[k],'authority_drift');
  const foreign=o.raw.integrations.Items.filter(v=>v.IntegrationId!==R.integrationId),
   original=initial.raw.integrations.Items.filter(v=>v.IntegrationId!==R.integrationId);
  check(equal(foreign,original)&&equal(o.raw.foundation,initial.raw.foundation),'other_transport_drift');return o;
 };
 const phase=async name=>{
  await sourceGuard();const consumer=verifyRecoveryPhase(await d.consumerPhase(name)),
   receipts=verifyPostParentReceiptPhase(await d.receiptPhase(name));
  if(name!=='baseline')check(receipts.every(r=>observations.baseline.some(b=>b.case===r.case&&b.persona===r.persona
   &&b.erasureRequestId===r.erasureRequestId&&b.bodySha256===r.bodySha256)),'receipt_changed');
  const actual=verifyRegisteredIntentPhase(await d.intentPhase(name,receipts),name,receipts,d.parseIntent);
  for(const r of [...consumer,...receipts,...actual]){
   check(!requestIds.has(r.requestId),'request_reused');requestIds.add(r.requestId);
  }
  intents[name]=actual;return [...consumer,...receipts];
 };
 let granted=false,switched=false,returned=false,retainedDeployment,returnedDeployment,metricWitness,error;
 try{
  observations.baseline=await phase('baseline');
  const fresh=guard(await d.transport(),R.latestArn);check(fresh.policy===null,'preexisting_permission');
  check(equal(await d.retained(),expectedRetained),'retained_before_permission');
  await sourceGuard();await d.admit({stage:'registered_recovery_permission_admitted',version,sid});granted=true;
  permissionStarted=d.now();
  await d.addPermission(sid,version);
  const allowed=guard(await d.transport(),R.latestArn);verifyIntentRecoveryPolicy(allowed.policy,sid,version,true);
  expectedRetained=await permissionObservation('add',expectedRetained,await d.retained(),allowed.policy,permissionStarted);
  permissionObserved=true;
  await sourceGuard();await d.admit({stage:'registered_recovery_switch_admitted',version});switched=true;
  await d.switchUri(uri);const retainedRoute=guard(await d.waitDeployment(initial.raw.stage.DeploymentId,uri),uri);
  check(retainedRoute.raw.stage.DeploymentId!==initial.raw.stage.DeploymentId,'retained_not_deployed');
  verifyIntentRecoveryPolicy(retainedRoute.policy,sid,version,true);retainedDeployment=retainedRoute.raw.stage.DeploymentId;
  const metricStart=Math.floor(d.now()/60000)*60000;
  observations.retained=await phase('retained');
  const held=guard(await d.transport(),uri);verifyIntentRecoveryPolicy(held.policy,sid,version,true);
  check(held.raw.stage.DeploymentId===retainedDeployment,'retained_deployment_changed');
  await sourceGuard();await d.admit({stage:'registered_recovery_return_admitted',version});await d.switchUri(R.latestArn);
  const back=guard(await d.waitDeployment(retainedDeployment,R.latestArn),R.latestArn);
  check(back.raw.stage.DeploymentId!==retainedDeployment,'return_not_deployed');
  returned=true;returnedDeployment=back.raw.stage.DeploymentId;
  observations.returned=await phase('returned');
  const end=Math.ceil(d.now()/60000)*60000,response=await d.waitMetric(metricStart,end,35,version);
  verifyRecoveryMetric(response,metricStart,end,35);metricWitness={start:metricStart,end,minimum:35,version,response};
  await record('registered_recovery_cases_verified',{caseCount:105,version});
 }catch(cause){error=cause;}
 finally{
  if(granted||switched){try{
   await sourceGuard();let actual=await d.transport(),target=actual.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId)?.IntegrationUri;
   check([R.latestArn,uri].includes(target),'unexpected_restoration_target');guard(actual,target);
   if(switched&&!returned){
    verifyIntentRecoveryPolicy(actual.policy,sid,version,true);
    await d.admit({stage:'registered_recovery_compensating_return_admitted',version});await d.switchUri(R.latestArn);
    const prior=actual.raw.stage.DeploymentId;actual=guard(await d.waitDeployment(prior,R.latestArn),R.latestArn);
    check(actual.raw.stage.DeploymentId!==prior,'compensating_return_unconfirmed');returned=true;returnedDeployment=actual.raw.stage.DeploymentId;
   }
   guard(actual,R.latestArn);check(!switched||actual.raw.stage.DeploymentId===returnedDeployment,'return_unconfirmed');
   const cleanupRetained=await d.retained();
   try{
    if(!permissionObserved&&actual.policy!==null){
     verifyIntentRecoveryPolicy(actual.policy,sid,version,true);
     expectedRetained=await permissionObservation('add',expectedRetained,cleanupRetained,actual.policy,permissionStarted);
     permissionObserved=true;
    }else check(equal(cleanupRetained,expectedRetained),'retained_before_cleanup');
   }catch(cause){error??=cause;}
   if(actual.policy!==null){verifyIntentRecoveryPolicy(actual.policy,sid,version,true);await sourceGuard();
    await d.admit({stage:'registered_recovery_permission_cleanup_admitted',version});
    const cleanupStarted=d.now();
    await d.removePermission(sid,version,actual.policy.RevisionId);
    expectedRetained=await permissionObservation('remove',cleanupRetained,await d.retained(),null,cleanupStarted);
   }
   const clean=guard(await d.transport(),R.latestArn);
   check(clean.policy===null&&(!switched||clean.raw.stage.DeploymentId===returnedDeployment),'permission_cleanup_unconfirmed');
   await record('registered_recovery_route_permission_restored');
  }catch{refuseRegistered('routing_restoration_unconfirmed');}}
 }
 if(error)throw error;
 await sourceGuard();const after=verifyCareRegisteredDatabase(await d.inspect(),observerSource,started,d.now());
 check(equal(databaseInventory(before),databaseInventory(after)),'database_changed');
 const finalRetained=await d.retained();check(equal(finalRetained,expectedRetained),'retained_changed');
 verifyRegisteredRetainedPermissionLineage(retainedPermissionLineage,started,d.now(),sid);
 const restored=guard(await d.transport(),R.latestArn);
 check(restored.policy===null&&restored.raw.stage.DeploymentId===returnedDeployment,'final_transport_drift');
 const report={contract:'synthetic-care-registered-routing-rehearsal/1',scope:'known-intent-predecessor-current-schema',
  execution:'synthetic-staging',account:P.account,current,observerSource,zipSha256:candidate.manifest.zipSha256,
  predecessorZipSha256:C.predecessorZip,retainedVersion:version,verdict:'pass',databaseBefore:before,databaseAfter:after,
  observations,intents,metricWitness,initialControl,retainedPermissionLineage,transportWitness:{initial:initial.raw.stage.DeploymentId,
   retainedDeployment,returnedDeployment,restored},functionalRoutingRecoveryVerified:true,returnToCandidateVerified:true,
  temporaryPermissionRemoved:true,schemaChanged:false,hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,
  physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false,reportIsNotAuthority:true,
  startedAt:new Date(started).toISOString(),completedAt:new Date(d.now()).toISOString(),events};
 await record('registered_compatible_routing_completed',{version});return report;
}
