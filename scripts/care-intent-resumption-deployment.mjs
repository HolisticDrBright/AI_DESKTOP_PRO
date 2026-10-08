/** Fresh service reconciliation for an interrupted, already executed intent
 * deployment. No saved report, custody operation or AWS mutation lives here. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {refuseIntent,verifyCareIntentCandidate} from './synthetic-care-intent-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage} from './care-recovery-routing.mjs';
import {careIntentFunctionConfig} from './care-intent-release.mjs';
import {verifyCareIntentExecutedDependencyViews} from './prepare-synthetic-care-intent-code-change.mjs';
import {verifyCancellationControlPlane} from './verify-synthetic-care-cancellation.mjs';
import {verifyIntentRetainedCode} from './care-intent-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('resumption_'+code);};
const snapshot=v=>v?.clean===true&&/^[a-f0-9]{40}$/.test(v.commit??'')
 &&/^[a-f0-9]{64}$/.test(v.sha256??'')&&Number.isSafeInteger(v.files)&&v.files>0;
/** Called on the managed Lambda stream by the fixed live observer, not on a
 * saved JSON report. Historical code is never selected as a recovery target. */
export function verifyCareIntentHistoricalDownload(bytes){
 check(Buffer.isBuffer(bytes)&&bytes.length===D.bytes&&sha256(bytes)===D.zip,'historical_download');
 return {sha256:D.zip,bytes:D.bytes,exactBytesVerified:true};
}
/** This structural check is not a substitute for the live runner's Git/blob
 * reconstruction and API rebuild. It disallows every other source difference. */
export function verifyCareIntentResumptionBindings(application,operator){
 check(snapshot(application?.desktop)&&snapshot(operator?.desktop)&&snapshot(application.mobile?.source)
  &&snapshot(operator.mobile?.source),'source_snapshots');
 const rebound=structuredClone(operator);rebound.desktop=structuredClone(application.desktop);
 rebound.mobile.source=structuredClone(application.mobile.source);
 check(canonical(rebound)===canonical(application),'source_bindings');
 return {applicationCurrent:structuredClone(application),operatorCurrent:structuredClone(operator)};
}
export function careIntentHistoricalTemplate(source){
 const template=structuredClone(source);
 for(const name of P.absentRoutes){check(template.Resources?.[name],'source_routes');delete template.Resources[name];}
 check(template.Outputs?.RoutesEnabled&&template.Resources?.IdentityApiFunction?.Properties?.Code,'source_template');
 template.Outputs.RoutesEnabled.Value='51';
 template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 return template;
}
export function careIntentResumptionInput(source,candidate,artifact){
 check(artifact?.bucket===P.bucket&&artifact.key===candidate.manifest.key
  &&artifact.sha256===candidate.manifest.zipSha256&&artifact.bytes===candidate.zip.length
  &&artifact.encryption==='aws:kms'&&artifact.kmsKeyArn===P.keyArn&&artifact.exactVersionReadbackVerified===true
  &&typeof artifact.versionId==='string'&&artifact.versionId.length>0&&artifact.versionId.length<=1024
  &&artifact.versionId!=='null','artifact');
 const template=careIntentHistoricalTemplate(source);
 template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=artifact.versionId;
 const keys=Object.keys(template.Parameters);check(keys.length===11&&keys.includes('LambdaCodeKey'),'parameters');
 return {template,parameters:keys.map(ParameterKey=>ParameterKey==='LambdaCodeKey'
  ?{ParameterKey,ParameterValue:candidate.manifest.key}:{ParameterKey,UsePreviousValue:true})};
}
function verifyResources(raw,template){
 const rows=raw?.StackResources,expected=Object.keys(template.Resources).sort();
 check(Array.isArray(rows)&&!raw.NextToken&&rows.length===expected.length
  &&new Set(rows.map(r=>r.LogicalResourceId)).size===rows.length
  &&canonical(rows.map(r=>r.LogicalResourceId).sort())===canonical(expected),'resources');
 for(const r of rows)check(r.ResourceType===template.Resources[r.LogicalResourceId].Type
  &&typeof r.PhysicalResourceId==='string'&&r.PhysicalResourceId.length>0
  &&['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(r.ResourceStatus),'resource_status');
}
/** All raw observations are supplied by the fixed in-process service observer,
 * never by a JSON-loading CLI. Version 1 proves historical configuration only;
 * the freshly downloaded intent version is the sole recovery candidate. */
export function verifyCareIntentResumedDeployment(w,candidate,application,operator,started,now){
 verifyCareIntentResumptionBindings(application,operator);
 verifyCareIntentCandidate(candidate.manifest,candidate.release,candidate.bundle,candidate.zip,application);
 const observed=Date.parse(w?.observedAt);
 check(w?.contract==='synthetic-care-intent-resumption-observations/1'
  &&Number.isFinite(started)&&Number.isFinite(now)&&observed>=started&&observed<=now&&now-observed<=120000
  &&canonical(w.applicationCurrent)===canonical(application)&&canonical(w.operatorCurrent)===canonical(operator),'fresh_source');
 const {raw,source,predecessor,retained,artifact,binding,summary,detailed,proposedTemplate}=w;
 check(typeof w.sourceText==='string'&&Buffer.byteLength(w.sourceText)<=1024*1024
  &&sha256(w.sourceText)===operator.templateSha256&&canonical(JSON.parse(w.sourceText))===canonical(source),'source_template_binding');
 const input=careIntentResumptionInput(source,candidate,artifact),historicalTemplate=careIntentHistoricalTemplate(source);
 // Exact source-template bytes are bound by the qualified current snapshot;
 // input.template is then independently compared with CloudFormation below.
 const old=predecessor?.configuration;
 check(old?.Version==='1'&&old.FunctionArn===R.retainedArn&&old.State==='Active'
  &&(!old.LastUpdateStatus||old.LastUpdateStatus==='Successful')&&old.CodeSha256===Buffer.from(D.zip,'hex').toString('base64')
  &&old.CodeSize===D.bytes&&typeof old.RevisionId==='string'&&old.RevisionId.length>0
  &&canonical(predecessor.download)===canonical({sha256:D.zip,bytes:D.bytes,exactBytesVerified:true}),
 'historical_configuration');
 const integration=raw?.integrations?.Items?.filter(i=>i.IntegrationId===R.integrationId);
 check(integration?.length===1,'integration_inventory');
 verifyRecoveryIntegration(integration[0],R.latestArn);verifyRecoveryStage(raw.stage);
 verifyResources(raw.resources,input.template);
 const name='care-intent-'+sha256(canonical({input,desktop:candidate.manifest.desktop,mobile:candidate.manifest.mobile,
  profile:'explicit-integration-arn-dependency/1'})).slice(0,32);
 check(binding?.stackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/`)
  &&binding.name===name,'execution_binding');
 const projections=verifyCareIntentExecutedDependencyViews(summary,detailed,proposedTemplate,input,binding,
  {template:historicalTemplate,fn:old,integration:integration[0],resources:raw.resources});
 check(raw.stack?.Stacks?.length===1&&raw.stack.Stacks[0].StackId===binding.stackId
  &&raw.stack.Stacks[0].StackName===P.stack&&raw.stack.Stacks[0].StackStatus==='UPDATE_COMPLETE'
  &&canonical(raw.template)===canonical(input.template),'executed_stack');
 const params=raw.stack.Stacks[0].Parameters;
 const parameterMap=items=>Object.fromEntries(items.map(p=>[p.ParameterKey,p.ParameterValue]));
 check(Array.isArray(params)&&params.length===11&&new Set(params.map(p=>p.ParameterKey)).size===11
  &&canonical(parameterMap(params))===canonical(parameterMap(summary.Parameters)),'executed_parameters');
 const latest=raw.fn;
 check(latest?.FunctionArn===R.latestArn&&latest.Version==='$LATEST'&&latest.State==='Active'&&latest.LastUpdateStatus==='Successful'
  &&latest.CodeSha256===Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64')&&latest.CodeSize===candidate.zip.length
  &&typeof latest.RevisionId==='string'&&latest.RevisionId.length>0&&latest.RevisionId!==old.RevisionId
  &&canonical(careIntentFunctionConfig(latest))===canonical(careIntentFunctionConfig(old))
  &&Buffer.isBuffer(w.codeBytes)&&w.codeBytes.equals(candidate.zip),'deployed_bytes_configuration');
 check(retained?.configuration?.Description===`ALP synthetic intent ${application.desktop.commit} ${candidate.manifest.zipSha256} PHI=off`,
  'retained_description');
 verifyIntentRetainedCode(retained.configuration,retained.codeBytes,latest,candidate);
 check(w.retainedPolicy===null,'existing_permission');
 // This is an explicit authority-only comparison with the original strict
 // guard. Only the known Code pointer/checksum differences are normalized;
 // it is not a claim that the predecessor is still deployed or executable.
 const authority=structuredClone(raw);
 authority.template=historicalTemplate;
 authority.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=
  `clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`;
 authority.fn.CodeSha256=Buffer.from(D.zip,'hex').toString('base64');authority.fn.CodeSize=D.bytes;
 const historicalCodeControl=verifyCancellationControlPlane(authority,source);
 const control={...historicalCodeControl,codeSha256:latest.CodeSha256,revision:latest.RevisionId,
  templateSha256:sha256(canonical(raw.template)),integrationsSha256:sha256(canonical(raw.integrations)),
  stageSha256:sha256(canonical(raw.stage))};
 const transport={integration:structuredClone(integration[0]),stage:structuredClone(raw.stage),policy:null,revisionId:latest.RevisionId,
  routesSha256:sha256(canonical(raw.routes)),authorizersSha256:sha256(canonical(raw.authorizers)),
  otherIntegrationsSha256:sha256(canonical(raw.integrations.Items.filter(i=>i.IntegrationId!==R.integrationId))),
  latestPolicySha256:sha256(canonical(raw.latestPolicy))};
 check(transport.routesSha256===control.routesSha256&&transport.authorizersSha256===control.authorizersSha256
  &&transport.latestPolicySha256===control.policySha256,'transport_binding');
 return {current:structuredClone(application),operatorCurrent:structuredClone(operator),latest:structuredClone(latest),
  transport,control,projections,observedAt:w.observedAt,zipSha256:candidate.manifest.zipSha256,codeVersion:artifact.versionId,
  deploymentReconciled:true,immutablePredecessorUsedForRouting:false,compatibleRecoveryVerified:false,
  schemaChanged:false,canonicalRegistered:false,hostedAcceptance:false,physicalDeviceAcceptance:false,
  phiAllowed:false,paidMobileBuildStarted:false};
}
