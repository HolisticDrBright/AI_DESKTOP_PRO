/** Current registered release preflight. Verification only; no upload, execute,
 * schema replay, custody retirement, fixture write or activation port exists. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,assertCareRegisteredCurrent,verifyCareRegisteredCandidate,verifyCareRegisteredArtifactBinding,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {CARE_CANONICAL as M} from './care-canonical-migrations.mjs';
import {CARE_INTENT_POSTCOMMIT as B} from './care-intent-postcommit.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage} from './care-recovery-routing.mjs';
import {verifyRecoveryLatestPolicy} from './rehearse-synthetic-care-routing.mjs';
import {verifyDeployedCareRole} from './verify-deployed-synthetic-care.mjs';
import {careIntentFunctionConfig} from './care-intent-release.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('preflight_'+code);};
export const CARE_REGISTERED_PREDECESSOR=Object.freeze({
 stackId:'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-synthetic-staging-authenticated-api/ce395280-9696-11f1-bb00-06d23d41b203',
 retainedVersion:'2',apiRouteCount:112});
const parameterValues=()=>({ClinicalApiId:P.apiId,DatabaseName:P.database,DatabaseClusterArn:P.cluster,DatabaseSecretArn:'****',
 ConsumerUserPoolId:P.consumerPool,ConsumerUserPoolClientId:P.consumerClient,WorkforceUserPoolId:P.workforcePool,
 WorkforceUserPoolClientId:P.workforceClient,ClinicalCoreKeyArn:P.keyArn,LambdaCodeBucket:P.bucket,
 LambdaCodeKey:`clinical-core/authenticated-api/care-intent-release/${C.predecessorDesktop}/${C.predecessorZip}.zip`});
const map=(items,k,v)=>{
 check(Array.isArray(items)&&items.every(x=>typeof x?.[k]==='string'&&typeof x?.[v]==='string')
  &&new Set(items.map(x=>x[k])).size===items.length,'entries');
 return Object.fromEntries(items.map(x=>[x[k],x[v]]));
};
const inventory=(o,key,id)=>{
 const rows=o?.[key];check(Array.isArray(rows)&&rows.length<=2000&&!o.NextToken&&!o.nextToken
  &&rows.every(r=>typeof r?.[id]==='string'&&r[id].length>0)
  &&new Set(rows.map(r=>r[id])).size===rows.length,'inventory');return rows;
};
export function careRegisteredPredecessorTemplate(source){
 const expected=structuredClone(source);
 for(const key of P.absentRoutes){check(expected.Resources?.[key],'source_route');delete expected.Resources[key];}
 check(expected.Outputs?.RoutesEnabled&&expected.Resources?.IdentityApiFunction?.Properties?.Code,'source_template');
 expected.Outputs.RoutesEnabled.Value='51';
 expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=C.predecessorVersion;return expected;
}
export function verifyCareRegisteredFunction(fn,retained=false){
 return verifyRegisteredFunctionProfile(fn,C.predecessorZip,C.predecessorBytes,retained?'2':'$LATEST');
}
/** Successor bytes are checked as successor bytes, never rewritten to pass the
 * known predecessor check. This is verification only, not execution admission. */
export function verifyCareRegisteredSuccessorFunction(fn,candidate,current){
 verifyCareRegisteredCandidate(candidate,current);
 return verifyRegisteredFunctionProfile(fn,candidate.manifest.zipSha256,candidate.zip.length,'$LATEST');
}
function verifyRegisteredFunctionProfile(fn,zip,bytes,version){
 check(fn?.FunctionName===P.functionName&&fn.FunctionArn===R.latestArn+(version==='$LATEST'?'':':'+version)
  &&fn.Version===version&&fn.State==='Active'&&fn.LastUpdateStatus==='Successful'
  &&fn.CodeSha256===Buffer.from(zip,'hex').toString('base64')&&fn.CodeSize===bytes
  &&typeof fn.RevisionId==='string'&&fn.RevisionId.length>0&&fn.RevisionId.length<=128,'function_identity');
 const environment={CLINICAL_DATABASE_CLUSTER_ARN:P.cluster,CLINICAL_DATABASE_SECRET_ARN:P.secret,CLINICAL_DATABASE_NAME:P.database,
  CLINICAL_CONSUMER_ISSUER:`https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`,CLINICAL_CONSUMER_AUDIENCE:P.consumerClient,
  CLINICAL_WORKFORCE_ISSUER:`https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`,CLINICAL_WORKFORCE_AUDIENCE:P.workforceClient};
 check(fn.Runtime==='nodejs22.x'&&fn.Handler==='index.handler'&&fn.MemorySize===256&&fn.Timeout===29
  &&canonical(fn.Architectures)===canonical(['arm64'])&&fn.PackageType==='Zip'
  &&canonical(fn.Environment)===canonical({Variables:environment})&&canonical(fn.EphemeralStorage)===canonical({Size:512})
  &&canonical(fn.TracingConfig)===canonical({Mode:'PassThrough'})
  &&canonical(fn.LoggingConfig)===canonical({LogGroup:'/ai-clinical-core/synthetic-staging/identity-api',LogFormat:'JSON',
   ApplicationLogLevel:'WARN',SystemLogLevel:'WARN'})
  &&(!fn.Layers||Array.isArray(fn.Layers)&&fn.Layers.length===0)
  &&(!fn.FileSystemConfigs||Array.isArray(fn.FileSystemConfigs)&&fn.FileSystemConfigs.length===0)
  &&!fn.KMSKeyArn&&!fn.MasterArn&&!fn.SigningProfileVersionArn&&!fn.SigningJobArn&&!fn.ImageConfigResponse
  &&!fn.CapacityProviderConfig&&!fn.DurableConfig&&!fn.TenancyConfig
  &&(!fn.DeadLetterConfig||canonical(fn.DeadLetterConfig)==='{}')
  &&(!fn.VpcConfig||canonical(fn.VpcConfig)===canonical({SubnetIds:[],SecurityGroupIds:[],VpcId:'',Ipv6AllowedForDualStack:false}))
  &&(!fn.SnapStart||canonical(fn.SnapStart)===canonical({ApplyOn:'None',OptimizationStatus:'Off'}))
  &&(!fn.RuntimeVersionConfig||Object.keys(fn.RuntimeVersionConfig).length===1
   &&/^arn:aws:lambda:us-east-2::runtime:[a-f0-9]{64}$/.test(fn.RuntimeVersionConfig.RuntimeVersionArn??'')),'function_configuration');
 return structuredClone(careIntentFunctionConfig(fn));
}
/** Exact known predecessor and complete live authority, with no normalization
 * to an older code generation and no acceptance of missing inventory pages. */
export function verifyCareRegisteredPredecessorControl(o,source){
 return verifyRegisteredControlInventory(o,source,careRegisteredPredecessorTemplate(source),parameterValues(),verifyCareRegisteredFunction);
}
export function verifyCareRegisteredSuccessorControl(o,source,candidate,current,artifact){
 return verifyCareRegisteredRoutingControl(o,source,candidate,current,artifact);
}
/** The one retained predecessor is admitted only for a temporary recovery
 * route. Actual responses remain intact; all other inventory checks are shared. */
export function verifyCareRegisteredRoutingControl(o,source,candidate,current,artifact,retainedVersion){
 check(retainedVersion===undefined||retainedVersion===CARE_REGISTERED_PREDECESSOR.retainedVersion,'routing_version');
 verifyCareRegisteredArtifactBinding(candidate,current,artifact);
 const expected=careRegisteredPredecessorTemplate(source);
 expected.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=artifact.versionId;
 return verifyRegisteredControlInventory(o,source,expected,{...parameterValues(),LambdaCodeKey:artifact.key},
  fn=>verifyCareRegisteredSuccessorFunction(fn,candidate,current),
  retainedVersion?`${R.latestArn}:${retainedVersion}`:R.latestArn);
}
/** Both profiles exhaust the same actual inventory; no raw response is patched
 * or reduced before the common authority and configuration checks. */
function verifyRegisteredControlInventory(o,source,expected,expectedParameters,verifyFunction,uri=R.latestArn){
 const foundation=o.foundation?.Stacks?.[0],stack=o.stack?.Stacks?.[0];
 check(o.foundation?.Stacks?.length===1&&foundation.StackName===P.foundation
  &&['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(foundation.StackStatus)
  &&foundation.StackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.foundation}/`),'foundation_identity');
 const outputs=map(foundation.Outputs,'OutputKey','OutputValue');
 for(const [key,value] of Object.entries({PhiAllowed:'false',Environment:'synthetic-staging',DataClassification:'synthetic_only',
  DatabaseName:P.database,ClinicalApiId:P.apiId,DatabaseClusterArn:P.cluster,DatabaseSecretArn:P.secret}))check(outputs[key]===value,'foundation_boundary');
 check(o.stack?.Stacks?.length===1&&stack.StackName===P.stack&&stack.StackId===CARE_REGISTERED_PREDECESSOR.stackId
  &&stack.StackStatus==='UPDATE_COMPLETE'&&canonical(map(stack.Parameters,'ParameterKey','ParameterValue'))===canonical(expectedParameters)
  &&canonical(o.template)===canonical(expected),'stack_template_parameters');
 const resources=inventory(o.resources,'StackResources','LogicalResourceId');
 check(resources.length===Object.keys(expected.Resources).length
  &&resources.every(r=>expected.Resources[r.LogicalResourceId]?.Type===r.ResourceType
   &&['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(r.ResourceStatus)
   &&typeof r.PhysicalResourceId==='string'&&r.PhysicalResourceId.length>0),'resources');
 const physical=name=>resources.find(r=>r.LogicalResourceId===name)?.PhysicalResourceId;
 check(physical('IdentityApiFunction')===P.functionName&&physical('IdentityApiIntegration')===R.integrationId,'physical_target');
 const fnConfig=verifyFunction(o.fn);verifyDeployedCareRole(o,source);
 inventory(o.logGroups,'logGroups','logGroupName');
 const integrations=inventory(o.integrations,'Items','IntegrationId'),routes=inventory(o.routes,'Items','RouteId'),authorizers=inventory(o.authorizers,'Items','AuthorizerId');
 check(integrations.filter(x=>x.IntegrationId===R.integrationId).length===1,'identity_integration');
 verifyRecoveryIntegration(integrations.find(x=>x.IntegrationId===R.integrationId),uri);
 verifyRecoveryStage(o.stage);verifyRecoveryLatestPolicy(o.latestPolicy);
 const policy=JSON.parse(o.latestPolicy.Policy);
 check(physical('IdentityApiInvokePermission')===policy.Statement[0].Sid,'invoke_physical');
 const owned=routes.filter(r=>r.Target===`integrations/${R.integrationId}`);
 const declared=Object.entries(expected.Resources).filter(([,r])=>r.Type==='AWS::ApiGatewayV2::Route');
 check(routes.length===CARE_REGISTERED_PREDECESSOR.apiRouteCount&&new Set(routes.map(r=>r.RouteKey)).size===routes.length
  &&owned.length===51&&declared.length===51,'route_inventory');
 for(const [name,resource] of declared){
  const p=resource.Properties,route=owned.find(r=>r.RouteKey===p.RouteKey),authorizerName=p.AuthorizerId?.Ref;
  const pool=authorizerName==='ConsumerJwtAuthorizer'?[P.consumerPool,P.consumerClient]
   :authorizerName==='WorkforceJwtAuthorizer'?[P.workforcePool,P.workforceClient]:undefined;
  const a=authorizers.find(v=>v.AuthorizerId===route?.AuthorizerId);
  check(pool&&route?.RouteId===physical(name)&&route.AuthorizationType==='JWT'&&route.ApiKeyRequired!==true
   &&(!route.AuthorizationScopes||Array.isArray(route.AuthorizationScopes)&&route.AuthorizationScopes.length===0)
   &&a?.AuthorizerId===physical(authorizerName)&&a.AuthorizerType==='JWT'
   &&canonical(a.IdentitySource)===canonical(['$request.header.Authorization'])
   &&a.JwtConfiguration?.Issuer===`https://cognito-idp.${P.region}.amazonaws.com/${pool[0]}`
   &&canonical(a.JwtConfiguration?.Audience)===canonical([pool[1]]),'route_authority');
 }
 const role=structuredClone(o.role);delete role.Role.RoleLastUsed;
 const logs=structuredClone(o.logGroups);for(const group of logs.logGroups)delete group.storedBytes;
 const identities=resources.map(({LogicalResourceId,PhysicalResourceId,ResourceType,ResourceStatus})=>
  ({LogicalResourceId,PhysicalResourceId,ResourceType,ResourceStatus})).sort((a,b)=>a.LogicalResourceId.localeCompare(b.LogicalResourceId));
 return {stackId:stack.StackId,revision:o.fn.RevisionId,codeSha256:o.fn.CodeSha256,codeSize:o.fn.CodeSize,
  functionConfigurationSha256:sha256(canonical(fnConfig)),resourcesSha256:sha256(canonical(identities)),
  templateSha256:sha256(canonical(o.template)),parametersSha256:sha256(canonical(map(stack.Parameters,'ParameterKey','ParameterValue'))),
  routesSha256:sha256(canonical(o.routes)),authorizersSha256:sha256(canonical(o.authorizers)),integrationsSha256:sha256(canonical(o.integrations)),
  stageSha256:sha256(canonical(o.stage)),policySha256:sha256(canonical(o.latestPolicy)),
  roleSha256:sha256(canonical({role,attached:o.attached,inline:o.inline,policies:o.policies,logs})),
  identityRouteCount:51,apiRouteCount:routes.length,iamVerified:true,loggingVerified:true,phiAllowed:false};
}
export function verifyCareRegisteredDatabase(r,current,started,now){
 assertCareRegisteredCurrent(current);const h=r?.historicalInspection,t=Date.parse(r?.observedAt);
 check(Number.isFinite(started)&&Number.isFinite(now)&&Number.isFinite(t)&&t>=started&&t<=now&&now-t<=300000,'database_freshness');
 check(r?.contract==='care-intent-canonical-registration-inspection/1'&&r.execution==='synthetic-staging'
  &&r.canonicalRegistered===true&&r.alreadyApplied===true&&r.sourceMigrationCount===47&&r.liveMigrationCount===48
  &&r.sourceLedgerSha256===M.sourceSha256&&r.liveLedgerSha256===M.liveSha256&&r.referenceLedgerSha256===M.referenceSha256
  &&r.historicalAliasPreserved===true&&r.repeatedReadbackVerified===true&&r.reportIsNotAuthority===true
  &&r.awsAccountId===P.account&&r.foundation===P.foundation
  &&canonical(r.operatorSource)===canonical({sourceCommit:current.desktop.commit,clean:true})
  &&['schemaReplayPerformed','ledgerRewritePerformed','apiDeploymentPerformed','erasureAccepted','releaseAccepted',
   'physicalDeviceAcceptance','activationApproved','phiAllowed'].every(k=>r[k]===false),'database_boundary');
 check(h?.contract==='care-erasure-intent-upgrade/1'&&h.command==='inspect'&&h.execution==='synthetic-staging'&&h.phiAllowed===false
  &&h.observedMigrationCount===48&&h.sourceMigrationCount===47&&h.tableCount===89
  &&h.rowCount===B.rowCount&&h.originalRowCount===B.rowCount&&h.completeRowCount===B.rowCount&&h.intentRowCount===0
  &&h.originalDataSha256===B.originalDataSha256&&h.completeDataSha256===B.completeDataSha256
  &&h.dataSha256===B.completeDataSha256&&h.schemaSha256===B.schemaSha256&&h.dataPreserved===true&&h.schemaPreserved===true
  &&h.applied===false&&h.alreadyApplied===true&&h.rolledBack===false&&h.fromLedgerSha256===P.liveAfter
  &&h.toLedgerSha256===M.liveSha256&&h.referenceLedgerSha256===M.referenceSha256
  &&['canonicalRegistered','hostedAcceptance','recoveryAcceptance','activationApproved'].every(k=>h[k]===false),'database_inventory');
 return structuredClone(r);
}
/** Injectable observers are credential-free tests only. The public runner
 * binds each to its own in-process AWS/Git observation, not a report file. */
export async function runCareRegisteredPreflight(candidate,current,source,port){
 const c=structuredClone(current),started=port.now();assertCareRegisteredCurrent(c);
 verifyCareRegisteredCandidate(candidate,c);
 check(sha256(port.sourceText)===c.templateSha256&&canonical(JSON.parse(port.sourceText))===canonical(source),'source_template');
 const local=await port.rebuild();
 check(local?.byteVerified===true&&local.sourceRebuilt===true&&local.zipSha256===candidate.manifest.zipSha256
  &&local.desktopCommit===c.desktop.commit&&local.mobileCommit===c.mobile.source.commit
  &&local.liveTargetObserved===false&&local.deployed===false&&local.phiAllowed===false,'independent_rebuild');
 const unchanged=async()=>check(canonical(await port.current())===canonical(c),'source_changed');
 await unchanged();const caller=await port.identity();assertSyntheticMemberIdentity(caller);
 const before=verifyCareRegisteredDatabase(await port.database(),c,started,port.now());
 await unchanged();const first=await port.control(),control=verifyCareRegisteredPredecessorControl(first,source);
 const downloads=await port.downloads(first.fn);
 check(downloads?.managedSha256===C.predecessorZip&&downloads.managedBytes===C.predecessorBytes
  &&downloads.storedSha256===C.predecessorZip&&downloads.storedBytes===C.predecessorBytes
  &&downloads.version===C.predecessorVersion&&downloads.exactBytesVerified===true,'predecessor_download');
 const retained=await port.retained();
 check(canonical(verifyCareRegisteredFunction(retained?.configuration,true))===canonical(verifyCareRegisteredFunction(first.fn))
  &&retained.policy===null&&retained.sha256===C.predecessorZip&&retained.bytes===C.predecessorBytes,'retained');
 const after=verifyCareRegisteredDatabase(await port.database(),c,started,port.now());
 const comparable=r=>{const copy=structuredClone(r);delete copy.observedAt;return copy;};
 check(canonical(comparable(before))===canonical(comparable(after)),'database_changed');
 const returned=await port.control();
 check(canonical(verifyCareRegisteredPredecessorControl(returned,source))===canonical(control),'control_changed');
 const finalRetained=await port.retained();check(canonical(finalRetained)===canonical(retained),'retained_changed');
 const finalCaller=await port.identity();assertSyntheticMemberIdentity(finalCaller);
 check(canonical(finalCaller)===canonical(caller),'principal_changed');await unchanged();
 return {contract:'synthetic-care-registered-preflight/1',observedAt:new Date(port.now()).toISOString(),current:c,
  execution:'synthetic-staging',account:P.account,candidateZipSha256:candidate.manifest.zipSha256,
  localArtifact:local,control,databaseBefore:before,databaseAfter:after,predecessorDownload:downloads,
  retained:{version:'2',sha256:retained.sha256,bytes:retained.bytes,invokePermissionAbsent:true},
  liveTargetObserved:true,independentSourceRebuildVerified:true,predecessorBytesVerified:true,repeatedReadbackVerified:true,
  reportIsNotAuthority:true,deployAuthorized:false,awsMutationPerformed:false,schemaReplayPerformed:false,
  recoveryRehearsed:false,erasureAccepted:false,hostedAcceptance:false,releaseAccepted:false,physicalDeviceAcceptance:false,
  phiAllowed:false,paidMobileBuildStarted:false};
}
