/** Fixed synthetic routing rehearsal state machine. Injectable transports are tests only. */
import {CARE_RELEASE as P,sha256,refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {PERSONA_EMAILS,CARE_CONSUMER_CASES,verifyCareConsumerAnswer} from './verify-synthetic-care-consumer.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
export const CARE_RECOVERY_ROUTE=Object.freeze({integrationId:'2k0pka6',version:'1',
 latestArn:`arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}`,
 retainedArn:`arn:aws:lambda:${P.region}:${P.account}:function:${P.functionName}:1`,
 sourceArn:`arn:aws:execute-api:${P.region}:${P.account}:${P.apiId}/*/*/clinical-core/*`});
export const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const check=(ok,code)=>{if(!ok)fail('recovery_'+code);};
export function recoveryPermission(sid){
 check(typeof sid==='string'&&/^alp-care-recovery-[a-f0-9]{32}$/.test(sid),'statement_id');
 return {Sid:sid,Effect:'Allow',Principal:{Service:'apigateway.amazonaws.com'},Action:'lambda:InvokeFunction',
  Resource:CARE_RECOVERY_ROUTE.retainedArn,Condition:{StringEquals:{'AWS:SourceAccount':P.account},
   ArnLike:{'AWS:SourceArn':CARE_RECOVERY_ROUTE.sourceArn}}};
}
export function verifyRecoveryPolicy(response,sid,expected){
 if(response===null){check(!expected,'permission_absent');return;}
 check(typeof response?.Policy==='string'&&response.Policy.length<=65536&&typeof response.RevisionId==='string'&&response.RevisionId,'permission_shape');
 let policy;try{policy=JSON.parse(response.Policy);}catch{fail('recovery_permission_shape');}
 check(policy?.Version==='2012-10-17'&&Array.isArray(policy.Statement)&&policy.Statement.length===1
  &&canonical(policy.Statement[0])===canonical(recoveryPermission(sid))&&expected,'permission_scope');
}
export function verifyRecoveryIntegration(integration,uri){
 check(integration?.IntegrationId===CARE_RECOVERY_ROUTE.integrationId&&integration.IntegrationUri===uri
  &&integration.IntegrationType==='AWS_PROXY'&&integration.IntegrationMethod==='POST'&&integration.ConnectionType==='INTERNET'
  &&integration.PayloadFormatVersion==='2.0'&&integration.TimeoutInMillis===30000
  &&Object.keys(integration).every(k=>['IntegrationId','IntegrationUri','IntegrationType','IntegrationMethod','ConnectionType',
   'PayloadFormatVersion','TimeoutInMillis','ApiGatewayManaged'].includes(k))&&integration.ApiGatewayManaged!==true,'integration');
}
export function verifyRecoveryStage(stage){
 check(stage?.StageName==='$default'&&stage.AutoDeploy===true&&/^[a-z0-9]{1,20}$/.test(stage.DeploymentId??'')
  &&stage.LastDeploymentStatusMessage===`Successfully deployed stage with deployment ID '${stage.DeploymentId}'`
  &&Object.keys(stage.StageVariables??{}).length===0&&Object.keys(stage.RouteSettings??{}).length===0
  &&canonical(stage.DefaultRouteSettings)===canonical({DetailedMetricsEnabled:true,ThrottlingBurstLimit:20,ThrottlingRateLimit:10})
  &&stage.AccessLogSettings?.DestinationArn===`arn:aws:logs:${P.region}:${P.account}:log-group:/ai-clinical-core/synthetic-staging/api-access`
  &&stage.AccessLogSettings.Format==='{"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength"}',
 'stage');
}
const comparableStage=s=>{const copy=structuredClone(s);for(const k of ['DeploymentId','LastUpdatedDate','LastDeploymentStatusMessage'])delete copy[k];return copy;};
export function verifyRecoveryMetric(response,start,end,minimum){
 check(response?.Label==='Invocations'&&Array.isArray(response.Datapoints)&&response.Datapoints.length<=30,'metric_shape');
 const seen=new Set();let sum=0;
 for(const point of response.Datapoints){const t=Date.parse(point.Timestamp);
  check(Number.isFinite(t)&&t>=start&&t<end&&!seen.has(t)&&Number.isSafeInteger(point.Sum)&&point.Sum>=0
   &&point.Unit==='Count','metric_value');seen.add(t);sum+=point.Sum;
 }
 check(Number.isSafeInteger(sum)&&sum>=minimum,'version_not_observed');return sum;
}
function verifyPhase(observations){
 const modes=Object.keys(PERSONA_EMAILS),pairs=new Set(),requests=new Set();
 check(Array.isArray(observations)&&observations.length===20,'case_count');
 for(const o of observations){const spec=CARE_CONSUMER_CASES.find(c=>c.name===o.case),pair=`${o.persona}:${o.case}`;
  check(modes.includes(o.persona)&&spec&&!pairs.has(pair)&&typeof o.requestId==='string'&&/^[A-Za-z0-9_=+/-]{8,160}$/.test(o.requestId)
   &&!requests.has(o.requestId)&&/^[a-f0-9]{64}$/.test(o.bodySha256??'')&&o.status===spec.status&&o.verified===true,'case_observation');
  pairs.add(pair);requests.add(o.requestId);
 }
 return observations.map(o=>({...o}));
}
/** No flag/report can manufacture acceptance: the CLI supplies only actual observers.
 * UpdateIntegration has no service-side compare-and-swap. This requires a single
 * synthetic operator, checks before/after every switch and never overwrites unrelated drift. */
export async function rehearseCareRecovery(d,sid){
 recoveryPermission(sid);const events=[],observations={},started=d.now();let grantAttempted=false,switchAttempted=false,returned=false,returnedDeployment,error;
 const record=async(stage,detail={})=>{const event={stage,at:new Date(d.now()).toISOString(),...detail};await d.record(event);events.push(event);};
 const before=await d.inspect();await record('preflight');
 check(before?.source===D.desktop&&before.zip===D.zip&&before.s3Version===D.version&&before.artifactVerified===true
  &&before.iamVerified===true&&before.loggingVerified===true&&before.harness?.clean===true
  &&/^[a-f0-9]{40}$/.test(before.harness.commit??'')&&/^[a-f0-9]{64}$/.test(before.harness.sha256??'')
  &&before.database?.liveCount===46&&before.database.sourceCount===45&&before.database.tableCount===87
  &&before.database.liveLedger===P.liveBefore&&before.database.referenceLedger===P.reference
  &&Number.isSafeInteger(before.database.rows)&&before.database.rows>=0&&/^[a-f0-9]{64}$/.test(before.database.dataSha256??''),'preflight_binding');
 const initial=await d.transport();verifyRecoveryIntegration(initial.integration,CARE_RECOVERY_ROUTE.latestArn);verifyRecoveryStage(initial.stage);
 check(initial.policy===null,'preexisting_version_permission');
 check(typeof initial.revisionId==='string'&&initial.revisionId.length>0
  &&['routesSha256','authorizersSha256','otherIntegrationsSha256','latestPolicySha256'].every(k=>/^[a-f0-9]{64}$/.test(initial[k]??'')), 'transport_binding');
 const guard=(value,uri)=>{verifyRecoveryIntegration(value.integration,uri);verifyRecoveryStage(value.stage);
  check(canonical(comparableStage(value.stage))===canonical(comparableStage(initial.stage))&&value.revisionId===initial.revisionId
   &&value.routesSha256===initial.routesSha256&&value.authorizersSha256===initial.authorizersSha256
   &&value.otherIntegrationsSha256===initial.otherIntegrationsSha256&&value.latestPolicySha256===initial.latestPolicySha256,'control_drift');};
 try{
  observations.baseline=verifyPhase(await d.consumerPhase('baseline'));
  const fresh=await d.transport();guard(fresh,CARE_RECOVERY_ROUTE.latestArn);check(fresh.policy===null,'permission_changed');
  await record('permission_admitted');grantAttempted=true;await d.addPermission(sid);
  const granted=await d.transport();guard(granted,CARE_RECOVERY_ROUTE.latestArn);verifyRecoveryPolicy(granted.policy,sid,true);
  await record('switch_admitted');switchAttempted=true;await d.switchUri(CARE_RECOVERY_ROUTE.retainedArn);
  const retained=await d.waitDeployment(initial.stage.DeploymentId,CARE_RECOVERY_ROUTE.retainedArn);guard(retained,CARE_RECOVERY_ROUTE.retainedArn);
  check(retained.stage.DeploymentId!==initial.stage.DeploymentId,'deployment_not_changed');verifyRecoveryPolicy(retained.policy,sid,true);
  const windowStart=Math.floor(d.now()/60000)*60000;
  observations.retained=verifyPhase(await d.consumerPhase('retained'));
  const afterRetained=await d.transport();guard(afterRetained,CARE_RECOVERY_ROUTE.retainedArn);verifyRecoveryPolicy(afterRetained.policy,sid,true);
  check(afterRetained.stage.DeploymentId===retained.stage.DeploymentId,'retained_deployment_changed');
  await record('retained_cases_verified',{deploymentId:retained.stage.DeploymentId,caseCount:20});
  await record('return_admitted');await d.switchUri(CARE_RECOVERY_ROUTE.latestArn);
  const restored=await d.waitDeployment(retained.stage.DeploymentId,CARE_RECOVERY_ROUTE.latestArn);guard(restored,CARE_RECOVERY_ROUTE.latestArn);
  check(restored.stage.DeploymentId!==retained.stage.DeploymentId,'return_not_deployed');returned=true;returnedDeployment=restored.stage.DeploymentId;
  observations.returned=verifyPhase(await d.consumerPhase('returned'));
  const end=Math.ceil(d.now()/60000)*60000;
  const metric=await d.waitMetric(windowStart,end,20);verifyRecoveryMetric(metric,windowStart,end,20);
  await record('return_cases_and_metric_verified',{deploymentId:restored.stage.DeploymentId,caseCount:20});
 }catch(cause){error=cause;}
 finally{
  // Even a lost add/switch response is reconciled before deciding what to undo.
  // Never retry a mutating request solely because its response was lost.
  if(grantAttempted||switchAttempted){
   try{
    let current=await d.transport();
    if(switchAttempted&&!returned){
     check([CARE_RECOVERY_ROUTE.latestArn,CARE_RECOVERY_ROUTE.retainedArn].includes(current.integration.IntegrationUri),'unexpected_restoration_target');
     guard(current,current.integration.IntegrationUri);verifyRecoveryPolicy(current.policy,sid,true);
     // A compensating return is a distinct operation, not a blind replay of
     // the failed switch. Its own deployment must be observed before cleanup.
     await d.switchUri(CARE_RECOVERY_ROUTE.latestArn);
     const previousDeployment=current.stage.DeploymentId;
     current=await d.waitDeployment(previousDeployment,CARE_RECOVERY_ROUTE.latestArn);
     check(current.stage.DeploymentId!==previousDeployment,'return_not_deployed');returned=true;returnedDeployment=current.stage.DeploymentId;
    }
    guard(current,CARE_RECOVERY_ROUTE.latestArn);
    // If a switch response was lost, a fresh successful deployment read must
    // prove the original route before its version permission can be removed.
    check(!switchAttempted||returned,'return_unconfirmed');
    check(!switchAttempted||current.stage.DeploymentId===returnedDeployment,'returned_deployment_changed');
    if(current.policy!==null){verifyRecoveryPolicy(current.policy,sid,true);await d.removePermission(sid,current.policy.RevisionId);}
    const clean=await d.transport();guard(clean,CARE_RECOVERY_ROUTE.latestArn);check(clean.policy===null,'permission_cleanup_unconfirmed');
    check(!switchAttempted||clean.stage.DeploymentId===returnedDeployment,'returned_deployment_changed');
    await record('routing_and_permission_restored');
   }catch{fail('recovery_restoration_unconfirmed');}
  }
 }
 if(error)throw error;
 const after=await d.inspect();
 check(canonical(after)===canonical(before),'postflight_drift');
 const all=Object.values(observations).flat();check(new Set(all.map(o=>o.requestId)).size===60,'repeated_phase_request');
 await record('completed');
 return {contract:'synthetic-care-retained-routing-rehearsal/1',scope:'preupgrade-retained-routing-only',execution:'synthetic-staging',
  account:P.account,retainedVersion:CARE_RECOVERY_ROUTE.version,baselineDatabase:before.database,
  verdict:'pass',observations,events,functionalRoutingRecoveryVerified:true,returnToCandidateVerified:true,
  temporaryPermissionRemoved:true,originalRoutingRestored:true,awsMutationPerformed:true,
  schemaChanged:false,afterUpgradeVerified:false,terminalReceiptRecoveryVerified:false,upgradeAuthorized:false,
  fullJourneyAcceptance:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false,startedAt:new Date(started).toISOString()};
}
export function verifyRecoveryResponse(spec,response,value){verifyCareConsumerAnswer(spec,response.status,value);
 const requestId=response.headers.get('apigw-requestid');check(typeof requestId==='string','request_id');
 return {case:spec.name,status:response.status,requestId,bodySha256:sha256(canonical(value)),verified:true};}
