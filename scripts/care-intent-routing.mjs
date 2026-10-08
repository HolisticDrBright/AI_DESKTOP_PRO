/** Separate intent-aware routing profile. Historical version 1 is never an
 * eligible successor. Ports below are bound live observers in the fixed runner;
 * no saved report, CLI qualifier, target or approval is an admission input. */
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {verifyCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage,
 verifyRecoveryPhase,verifyPostParentReceiptPhase,verifyRecoveryMetric} from './care-recovery-routing.mjs';
import {careIntentFunctionConfig,verifyCareIntentRecovery} from './care-intent-release.mjs';
import {PERSONA_EMAILS} from './verify-synthetic-care-consumer.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('routing_'+code);};
export function verifyIntentRetainedCode(value,bytes,latest,candidate){
 check(typeof value?.Version==='string'&&/^[1-9][0-9]{0,19}$/.test(value.Version)&&value.Version!=='1'
  &&value.FunctionArn===`${R.latestArn}:${value.Version}`&&value.State==='Active'
  &&(!value.LastUpdateStatus||value.LastUpdateStatus==='Successful')
  &&value.CodeSha256===latest.CodeSha256&&value.CodeSize===candidate.zip.length
  &&canonical(careIntentFunctionConfig(value))===canonical(careIntentFunctionConfig(latest))
  &&Buffer.isBuffer(bytes)&&bytes.equals(candidate.zip),'retained_code');
 return value.Version;
}
export function intentRecoveryPermission(sid,version){
 check(/^alp-care-intent-recovery-[a-f0-9]{32}$/.test(sid??'')
  &&/^[1-9][0-9]{0,19}$/.test(version??'')&&version!=='1','permission_binding');
 return {Sid:sid,Effect:'Allow',Principal:{Service:'apigateway.amazonaws.com'},Action:'lambda:InvokeFunction',
  Resource:`${R.latestArn}:${version}`,Condition:{StringEquals:{'AWS:SourceAccount':P.account},
   ArnLike:{'AWS:SourceArn':R.sourceArn}}};
}
export function verifyIntentRecoveryPolicy(response,sid,version,expected){
 if(response===null){check(!expected,'permission_absent');return;}
 check(typeof response?.Policy==='string'&&response.Policy.length<=65536
  &&typeof response.RevisionId==='string'&&response.RevisionId.length>0,'permission_shape');
 let policy;try{policy=JSON.parse(response.Policy);}catch{refuseIntent('routing_permission_shape');}
 check(expected&&policy?.Version==='2012-10-17'&&Array.isArray(policy.Statement)&&policy.Statement.length===1
  &&canonical(policy.Statement[0])===canonical(intentRecoveryPermission(sid,version)),'permission_scope');
}
const stageConfig=value=>{const s=structuredClone(value);for(const k of ['DeploymentId','LastUpdatedDate','LastDeploymentStatusMessage'])delete s[k];return s;};
export function verifyIntentDenialPhase(values,phase){
 const seen=new Set(),requests=new Set();check(Array.isArray(values)&&values.length===10,'denial_count');
 for(const v of values){const key=`${v.persona}:${v.action}`;
  check(v.phase===phase&&Object.hasOwn(PERSONA_EMAILS,v.persona)&&['prepare_erasure','discover_erasure_requests'].includes(v.action)
   &&v.status===503&&v.error==='service_unavailable'&&v.verified===true&&!seen.has(key)
   &&/^[A-Za-z0-9_=+/-]{8,160}$/.test(v.requestId??'')&&!requests.has(v.requestId)&&/^[a-f0-9]{64}$/.test(v.bodySha256??''),'denial_case');
  seen.add(key);requests.add(v.requestId);
 }return structuredClone(values);
}
export async function rehearseCareIntentRouting(input,d,sid){
 const {candidate,current,latest,baseline}=input;
 verifyCareIntentCandidate(candidate.manifest,candidate.release,candidate.bundle,candidate.zip,current);
 check(latest?.FunctionArn===R.latestArn&&latest.Version==='$LATEST'&&latest.State==='Active'&&latest.LastUpdateStatus==='Successful'
  &&latest.CodeSha256===Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64')&&latest.CodeSize===candidate.zip.length,'latest_code');
 const start=d.now(),events=[],observations={},preSchemaDenials=[];
 const record=async(stage,detail={})=>{const e={stage,at:new Date(d.now()).toISOString(),...detail};await d.record(e);events.push(e);};
 const guardSource=async()=>check(canonical(await d.current())===canonical(current),'source_drift');
 await guardSource();
 const before=await d.inspect();check(canonical(before)===canonical(baseline),'preflight_database');
 const retained=await d.retain();
 const version=verifyIntentRetainedCode(retained.configuration,retained.codeBytes,latest,candidate),uri=`${R.latestArn}:${version}`;
 intentRecoveryPermission(sid,version);
 const initial=await d.transport(version);verifyRecoveryIntegration(initial.integration,R.latestArn);verifyRecoveryStage(initial.stage);
 check(initial.policy===null&&initial.revisionId===latest.RevisionId,'preflight_transport');
 const guard=(value,target)=>{
  verifyRecoveryIntegration(value.integration,target);verifyRecoveryStage(value.stage);
  check(value.revisionId===initial.revisionId&&canonical(stageConfig(value.stage))===canonical(stageConfig(initial.stage))
   &&['routesSha256','authorizersSha256','otherIntegrationsSha256','latestPolicySha256'].every(k=>
    /^[a-f0-9]{64}$/.test(value[k]??'')&&value[k]===initial[k]),'transport_drift');
 };
 const phase=async name=>{
  await guardSource();const consumer=verifyRecoveryPhase(await d.consumerPhase(name));
  const receipts=verifyPostParentReceiptPhase(await d.receiptPhase(name));
  if(name!=='baseline')check(receipts.every(v=>observations.baseline.some(b=>b.persona===v.persona
   &&b.case===v.case&&b.erasureRequestId===v.erasureRequestId&&b.bodySha256===v.bodySha256)),'receipt_changed');
  if(name!=='returned')preSchemaDenials.push(...verifyIntentDenialPhase(await d.denialPhase(name),name));
  return [...consumer,...receipts];
 };
 let grantAttempted=false,switchAttempted=false,returned=false,retainedDeployment,returnedDeployment,metricWitness,error;
 try{
  observations.baseline=await phase('baseline');
  const fresh=await d.transport(version);guard(fresh,R.latestArn);check(fresh.policy===null,'preexisting_permission');
  await guardSource();await d.admit({stage:'intent_permission_admitted',version,sid});grantAttempted=true;
  await d.addPermission(sid,version);
  const granted=await d.transport(version);guard(granted,R.latestArn);verifyIntentRecoveryPolicy(granted.policy,sid,version,true);
  await guardSource();await d.admit({stage:'intent_retained_switch_admitted',version});switchAttempted=true;
  await d.switchUri(uri);
  const switched=await d.waitDeployment(initial.stage.DeploymentId,uri,version);guard(switched,uri);
  check(switched.stage.DeploymentId!==initial.stage.DeploymentId,'retained_not_deployed');
  verifyIntentRecoveryPolicy(switched.policy,sid,version,true);retainedDeployment=switched.stage.DeploymentId;
  const metricStart=Math.floor(d.now()/60000)*60000;
  observations.retained=await phase('retained');
  const afterRetained=await d.transport(version);guard(afterRetained,uri);verifyIntentRecoveryPolicy(afterRetained.policy,sid,version,true);
  check(afterRetained.stage.DeploymentId===retainedDeployment,'retained_deployment_drift');
  await guardSource();await d.admit({stage:'intent_latest_return_admitted',version});await d.switchUri(R.latestArn);
  const back=await d.waitDeployment(retainedDeployment,R.latestArn,version);guard(back,R.latestArn);
  check(back.stage.DeploymentId!==retainedDeployment,'return_not_deployed');returned=true;returnedDeployment=back.stage.DeploymentId;
  observations.returned=await phase('returned');
  const end=Math.ceil(d.now()/60000)*60000,response=await d.waitMetric(metricStart,end,25,version);
  verifyRecoveryMetric(response,metricStart,end,25);
  metricWitness={start:metricStart,end,minimum:25,functionName:P.functionName,qualifier:version,response};
  await record('intent_routing_cases_verified',{version,caseCount:75,preSchemaDenialCount:20});
 }catch(cause){error=cause;}
 finally{
  if(grantAttempted||switchAttempted){
   try{
    let actual=await d.transport(version);
    if(switchAttempted&&!returned){
     check([R.latestArn,uri].includes(actual.integration.IntegrationUri),'unexpected_restoration_target');
     guard(actual,actual.integration.IntegrationUri);verifyIntentRecoveryPolicy(actual.policy,sid,version,true);
     // Distinct compensating operation, not a replay of the lost switch.
     await d.admit({stage:'intent_compensating_return_admitted',version});await d.switchUri(R.latestArn);
     const prior=actual.stage.DeploymentId;actual=await d.waitDeployment(prior,R.latestArn,version);guard(actual,R.latestArn);
     check(actual.stage.DeploymentId!==prior,'compensating_return_unconfirmed');returned=true;returnedDeployment=actual.stage.DeploymentId;
    }
    guard(actual,R.latestArn);
    check(!switchAttempted||(returned&&actual.stage.DeploymentId===returnedDeployment),'return_unconfirmed');
    if(actual.policy!==null){verifyIntentRecoveryPolicy(actual.policy,sid,version,true);
     await d.admit({stage:'intent_permission_cleanup_admitted',version});await d.removePermission(sid,version,actual.policy.RevisionId);}
    const clean=await d.transport(version);guard(clean,R.latestArn);check(clean.policy===null,'permission_cleanup_unconfirmed');
    check(!switchAttempted||clean.stage.DeploymentId===returnedDeployment,'returned_deployment_drift');
    await record('intent_routing_and_permission_restored');
   }catch{refuseIntent('routing_restoration_unconfirmed');}
  }
 }
 if(error)throw error;
 await guardSource();const after=await d.inspect();check(canonical(after)===canonical(before),'postflight_database_drift');
 const restored=await d.transport(version);guard(restored,R.latestArn);
 check(restored.policy===null&&restored.stage.DeploymentId===returnedDeployment,'final_transport_drift');
 const report={contract:'synthetic-care-intent-routing-rehearsal/1',scope:'intent-code-before-schema',execution:'synthetic-staging',
  account:P.account,current,zipSha256:candidate.manifest.zipSha256,verdict:'pass',retained,databaseBefore:before,databaseAfter:after,
  observations,preSchemaDenials,metricWitness,transportWitness:{originalDeployment:initial.stage.DeploymentId,retainedDeployment,returnedDeployment,restored},
  functionalRoutingRecoveryVerified:true,returnToCandidateVerified:true,temporaryPermissionRemoved:true,originalRoutingRestored:true,
  schemaChanged:false,canonicalRegistered:false,hostedAcceptance:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false,
  startedAt:new Date(start).toISOString(),completedAt:new Date(d.now()).toISOString(),events};
 verifyCareIntentRecovery(report,{current,latest,zipSha256:candidate.manifest.zipSha256,transport:restored},candidate,baseline,start,d.now());
 await record('intent_compatible_routing_completed',{version});return report;
}
