/** Fixed-target live release. One upload custody covers code execution, actual
 * compatible recovery and the guarded schema continuation. No report-loading,
 * target/version override, approval flag, production or mobile build surface. */
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {CognitoIdentityProviderClient,InitiateAuthCommand} from '@aws-sdk/client-cognito-identity-provider';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {careIntentCurrent,refuseIntent} from './synthetic-care-intent-release.mjs';
import {runCareIntentUpload,verifyIntentUploadPreparation,intentFailureCode} from './upload-synthetic-care-intent-release.mjs';
import {proposeCareIntentDependencyCodeChange,careIntentCodeChangeInputs,verifyCareIntentDependencyViews} from './prepare-synthetic-care-intent-code-change.mjs';
import {releaseCareIntent,verifyCareIntentDeployment} from './care-intent-release.mjs';
import {rehearseCareIntentRouting,intentRecoveryPermission} from './care-intent-routing.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage,verifyRecoveryMetric,verifyRecoveryResponse} from './care-recovery-routing.mjs';
import {intentAws as aws,observeIntentControlRaw,verifyIntentLiveControl,downloadIntentFunction,retainIntentFunction} from './care-intent-live.mjs';
import {verifyCancellationControlPlane} from './verify-synthetic-care-cancellation.mjs';
import {verifyCareIntentInspector} from './prepare-synthetic-care-intent-release.mjs';
import {CARE_CONSUMER_CASES,verifyPersonaRecords,verifyPersonaClaims,boundedCareJson} from './verify-synthetic-care-consumer.mjs';
import {verifyCancellationAnswer,verifyCancellationStoredReceipt} from './care-erasure-cancellation.mjs';
import {RECOVERY_AUTH_TRANSPORT} from './rehearse-synthetic-care-routing.mjs';
import {SYNTHETIC_MEMBER_PROFILE as profile,observeSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('runner_'+code);};
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const secretArn='arn:aws:secretsmanager:us-east-2:588966314750:secret:ai-longevity-pro/synthetic-staging/testflight-personas-piSA7p';
export function intentReleaseArgs(args){
 check(args.length===5&&args[0]==='--v2-root'&&args[2]==='--candidate'
  &&args[4]==='--release-fictional-intent-with-fresh-recovery'&&!args[1].startsWith('--')&&!args[3].startsWith('--'),'arguments');
 return {mobileRoot:resolve(args[1]),directory:resolve(args[3])};
}
export function verifyIntentReleasePort(manifest,bytes,current){
 check(manifest?.contract==='care-intent-release-database-build/1'&&manifest.sourceCommit===current.desktop.commit&&manifest.clean===true
  &&manifest.sha256===sha256(bytes)&&manifest.execution==='synthetic-staging'&&manifest.phiAllowed===false
  &&['embeddedMigrations','embeddedReferenceMigrations','embeddedOverlay','mandatoryFreshCompatibleRecovery','mandatoryDeploymentReadback','mandatoryRollbackRehearsal']
   .every(k=>manifest[k]===true)&&['targetOverrides','standaloneUpgradeAvailable','canonicalRegistered','migrationPerformed','hostedAcceptance'].every(k=>manifest[k]===false)
  &&canonical(manifest.releaseMapping)===canonical(current.migrations),'database_port');
}
function loadDatabasePort(root,current){
 try{execFileSync(process.execPath,[resolve(root,'scripts/build-care-erasure-intent-release.mjs')],
  {cwd:root,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});}
 catch{refuseIntent('runner_database_build');}
 const dir=resolve(root,'dist/aws-clinical-core/care-erasure-intent-release'),file=resolve(dir,'index.cjs');
 verifyIntentReleasePort(JSON.parse(readFileSync(resolve(dir,'artifact-manifest.json'),'utf8')),readFileSync(file),current);
 const port=createRequire(import.meta.url)(file).runCareIntentReleaseDatabase;
 check(typeof port==='function','database_export');return command=>port(command,current.desktop.commit);
}
/** Execute once. On a lost response, observe the SAME stack/change-set until
 * terminal; no retry, no replacement proposal, no manual Lambda rollback. */
export async function executeIntentChange(before,context,d){
 const {binding}=before;await d.guard();
 await context.admit({stage:'intent_change_execute_admitted',stackId:binding.stackId,changeSetId:binding.id});
 let replyLost=false;
 try{await d.execute(binding,sha256(canonical({binding,source:context.current,kind:'intent-code-execution/1'})));}
 catch{replyLost=true;await context.record({stage:'intent_change_execute_reply_unconfirmed',changeSetId:binding.id});}
 for(let n=0;n<120;n++){
  const observed=await d.observe(binding),stack=observed.stack?.Stacks?.[0],set=observed.changeSet;
  check(observed.stack?.Stacks?.length===1&&stack.StackId===binding.stackId&&set?.ChangeSetId===binding.id
   &&set.StackId===binding.stackId&&!set.NextToken,'execution_identity');
  if(stack.StackStatus==='UPDATE_COMPLETE'&&set.Status==='CREATE_COMPLETE'&&set.ExecutionStatus==='EXECUTE_COMPLETE'){
   await context.record({stage:'intent_change_execute_terminal',replyLost,changeSetId:binding.id});return observed;}
  check(!['UPDATE_ROLLBACK_COMPLETE','UPDATE_ROLLBACK_FAILED','ROLLBACK_COMPLETE','DELETE_COMPLETE','DELETE_FAILED'].includes(stack.StackStatus)
   &&!['FAILED','OBSOLETE'].includes(set.Status)&&set.ExecutionStatus!=='OBSOLETE','execution_failed');
  await d.pause(2000);
 }
 // This observation budget is not a declaration that AWS stopped. Custody
 // remains admitted and subsequent work must inspect this exact execution.
 refuseIntent('runner_execution_observation_unconfirmed');
}
function parseTemplate(raw){const t=raw.TemplateBody;return typeof t==='string'?JSON.parse(t):t;}
function transportFrom(raw,version){
 const identity=raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId);
 return {integration:identity,stage:raw.stage,revisionId:raw.fn.RevisionId,
  routesSha256:sha256(canonical(raw.routes)),authorizersSha256:sha256(canonical(raw.authorizers)),
  otherIntegrationsSha256:sha256(canonical(raw.integrations.Items.filter(v=>v.IntegrationId!==R.integrationId))),
  latestPolicySha256:sha256(canonical(raw.latestPolicy)),
  policy:version?aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier',version],version):null};
}
async function runLiveRecovery(root,context,before,input,source,latest,schema,started){
 const {candidate,current,preparation,unchanged,record}=context;
 const credentials=fromIni({profile}),secrets=new SecretsManagerClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT}),
  cognito=new CognitoIdentityProviderClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT}),
  rds=new RDSDataClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT});
 let rows=[],currentLatest=latest;const receiptIds=new Map(),authenticationIds=new Set();
 const transport=async version=>{
  unchanged();const raw=observeIntentControlRaw(),uri=raw.integrations.Items.find(i=>i.IntegrationId===R.integrationId)?.IntegrationUri;
  verifyIntentLiveControl(raw,source,input,candidate,before,preparation,uri===R.latestArn?undefined:version);
  check(raw.fn.RevisionId===currentLatest.RevisionId,'transport_revision');
  return transportFrom(raw,version);
 };
 const authenticate=async row=>{
  unchanged();observeSyntheticMemberIdentity();
  const auth=await cognito.send(new InitiateAuthCommand({ClientId:P.consumerClient,AuthFlow:'USER_PASSWORD_AUTH',
   AuthParameters:{USERNAME:row.email,PASSWORD:row.password}}),{abortSignal:AbortSignal.timeout(30000)});
  const token=auth.AuthenticationResult?.IdToken,id=auth.$metadata?.requestId;
  check(typeof token==='string'&&typeof id==='string'&&/^[A-Za-z0-9-]{8,128}$/.test(id)&&!authenticationIds.has(id),'authentication');
  authenticationIds.add(id);verifyPersonaClaims(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')),row);return token;
 };
 const request=async(token,spec)=>{
  const response=await fetch(`https://${P.apiId}.execute-api.${P.region}.amazonaws.com${spec.path??'/clinical-core/consumer/care-data'}`,
   {method:spec.body?'POST':'GET',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:spec.body?JSON.stringify(spec.body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  return {response,value:await boundedCareJson(response)};
 };
 try{
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:secretArn}),{abortSignal:AbortSignal.timeout(30000)});
  check(secret.ARN===secretArn&&typeof secret.SecretString==='string'&&Buffer.byteLength(secret.SecretString)<=65536,'persona_secret');
  rows=JSON.parse(secret.SecretString);verifyPersonaRecords(rows);
  const ports={now:Date.now,current:async()=>careIntentCurrent(root,context.mobileRoot),inspect:()=>schema('inspect'),record,admit:context.admit,
   retain:async()=>{
    const retained=await retainIntentFunction(latest,candidate,context);
    currentLatest=retained.latestConfiguration;return retained;
   },transport,
   consumerPhase:async phase=>{
    const observations=[];
    for(const row of rows){let token=await authenticate(row);
     try{for(const spec of CARE_CONSUMER_CASES){const {response,value}=await request(token,spec);
      const observed={persona:row.mode,...verifyRecoveryResponse(spec,response,value)};observations.push(observed);
      record({stage:'intent_consumer_case_verified',phase,...observed});}}
     finally{token=undefined;}}
    return observations;
   },
   receiptPhase:async phase=>{
    const observations=[];
    for(const row of rows){
     unchanged();observeSyntheticMemberIdentity();
     const found=await rds.send(new ExecuteStatementCommand({resourceArn:P.cluster,secretArn:P.secret,database:P.database,
      sql:"select request_id::text,scope,outcome,receipt is null as receipt_absent from clinical_core.care_data_erasure_requests where owner_id=cast(:owner as uuid) and scope='domain' and outcome='cancelled' and receipt is null order by request_id limit 2",
      parameters:[{name:'owner',value:{stringValue:row.personId}}]}),{abortSignal:AbortSignal.timeout(30000)});
     check(found.numberOfRecordsUpdated===0&&found.records?.length===1&&found.records[0].length===4,'receipt_inventory');
     const c=found.records[0];check(c.slice(0,3).every(v=>typeof v.stringValue==='string')&&typeof c[3].booleanValue==='boolean','receipt_shape');
     verifyCancellationStoredReceipt([{scope:c[1].stringValue,outcome:c[2].stringValue,receiptAbsent:c[3].booleanValue}]);
     const id=c[0].stringValue;if(phase==='baseline')receiptIds.set(row.mode,id);else check(receiptIds.get(row.mode)===id,'receipt_changed');
     let token=await authenticate(row);
     try{const body={action:'erase_receipt',scope:'domain',requestId:id},{response,value}=await request(token,{body});
      const observed={persona:row.mode,case:'existing_cancelled_receipt',erasureRequestId:id,
       ...verifyCancellationAnswer(body,'cancelled',response,value),bodySha256:sha256(canonical(value))};
      observations.push(observed);record({stage:'intent_receipt_case_verified',phase,...observed});}
     finally{token=undefined;}
    }return observations;
   },
   denialPhase:async phase=>{
    const observations=[];
    for(const row of rows){let token=await authenticate(row);
     try{for(const action of ['prepare_erasure','discover_erasure_requests']){
      const body=action==='prepare_erasure'?{action,scope:'domain',requestId:randomUUID()}:{action,limit:1};
      const {response,value}=await request(token,{body});
      check(response.status===503&&value?.error==='service_unavailable'&&!Object.hasOwn(value,'data'),'preschema_refusal');
      const observed={persona:row.mode,phase,action,status:response.status,error:value.error,verified:true,
       requestId:response.headers.get('apigw-requestid'),bodySha256:sha256(canonical(value))};
      observations.push(observed);record({stage:'intent_preschema_denial_verified',...observed});}}
     finally{token=undefined;}
    }return observations;
   },
   addPermission:async(sid,version)=>{
    unchanged();observeSyntheticMemberIdentity();const statement=intentRecoveryPermission(sid,version);
    const answer=aws(['lambda','add-permission','--function-name',P.functionName,'--qualifier',version,'--statement-id',sid,
     '--action','lambda:InvokeFunction','--principal','apigateway.amazonaws.com','--source-arn',R.sourceArn,'--source-account',P.account]);
    check(canonical(JSON.parse(answer.Statement))===canonical(statement),'permission_reply');
   },
   removePermission:async(sid,version,revision)=>{unchanged();observeSyntheticMemberIdentity();
    aws(['lambda','remove-permission','--function-name',P.functionName,'--qualifier',version,'--statement-id',sid,'--revision-id',revision]);},
   switchUri:async uri=>{unchanged();observeSyntheticMemberIdentity();check(uri===R.latestArn
    ||new RegExp(`^${R.latestArn}:(?:[2-9]|[1-9][0-9]+)$`).test(uri),'switch_target');
    aws(['apigatewayv2','update-integration','--api-id',P.apiId,'--integration-id',R.integrationId,'--integration-uri',uri]);},
   waitDeployment:async(previous,uri,version)=>{
    const deadline=Date.now()+180000;
    while(Date.now()<deadline){
     unchanged();observeSyntheticMemberIdentity();
     const integration=aws(['apigatewayv2','get-integration','--api-id',P.apiId,'--integration-id',R.integrationId]);
     verifyRecoveryIntegration(integration,uri);
     const stage=aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']);
     if(stage.DeploymentId!==previous){
      try{verifyRecoveryStage(stage);const deployed=aws(['apigatewayv2','get-deployment','--api-id',P.apiId,'--deployment-id',stage.DeploymentId]);
       if(deployed.DeploymentId===stage.DeploymentId&&deployed.DeploymentStatus==='DEPLOYED')return await transport(version);}
      catch(e){if(!e.message?.endsWith(':recovery_stage'))throw e;}}
     await pause(2000);}
    refuseIntent('runner_route_observation_unconfirmed');
   },
   waitMetric:async(start,end,minimum,version)=>{
    const deadline=Date.now()+240000;
    while(Date.now()<deadline){const metric=aws(['cloudwatch','get-metric-statistics','--namespace','AWS/Lambda','--metric-name','Invocations',
     '--dimensions',`Name=FunctionName,Value=${P.functionName}`,`Name=Resource,Value=${P.functionName}:${version}`,
     '--start-time',new Date(start).toISOString(),'--end-time',new Date(end).toISOString(),'--period','60','--statistics','Sum']);
     try{verifyRecoveryMetric(metric,start,end,minimum);return metric;}
     catch(e){if(!e.message?.endsWith(':recovery_version_not_observed'))throw e;}
     await pause(10000);}
    refuseIntent('runner_metric_observation_unconfirmed');
   }};
  const recovery=await rehearseCareIntentRouting({candidate,current,latest,baseline:preparation.database},ports,
   'alp-care-intent-recovery-'+randomBytes(16).toString('hex'));
  check(Date.parse(recovery.startedAt)>=started,'recovery_start');return {recovery,transport:()=>transport(recovery.retained.configuration.Version)};
 }finally{for(const row of rows)if(row&&typeof row==='object')delete row.password;rows=[];
  secrets.destroy();cognito.destroy();rds.destroy();}
}
export async function runCareIntentRelease(root,mobileRoot,directory){
 const started=Date.now(),current=careIntentCurrent(root,mobileRoot),schema=loadDatabasePort(root,current);
 observeSyntheticMemberIdentity();
 const uploaded=await runCareIntentUpload(root,mobileRoot,directory,async supplied=>{
  const context={...supplied,mobileRoot};const {candidate,preparation,artifact,unchanged,record}=context;
  record({stage:'intent_live_release_started',desktop:current.desktop.commit,mobile:current.mobile.source.commit});
  const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
  const proposal=await proposeCareIntentDependencyCodeChange(root,directory,context);
  const binding={stackId:proposal.stackId,name:proposal.changeSetName,id:proposal.changeSetId};
  const input=careIntentCodeChangeInputs(source,preparation,candidate.manifest,artifact,current);
  const raw=observeIntentControlRaw();check(canonical(verifyCancellationControlPlane(raw,source))===canonical(preparation.control),'predecessor_control');
  const before={binding,input,live:{template:raw.template,fn:raw.fn,integration:raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId),resources:raw.resources},
   stage:raw.stage,summary:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--no-include-property-values','--no-paginate']),
   detailed:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--include-property-values','--no-paginate']),
   proposedTemplate:parseTemplate(aws(['cloudformation','get-template','--stack-name',binding.stackId,'--change-set-name',binding.id,'--template-stage','Original']))};
  verifyCareIntentDependencyViews(before.summary,before.detailed,before.proposedTemplate,input,binding,before.live);
  const liveDatabase=verifyCareIntentInspector(await schema('inspect'),current);
  check(canonical(liveDatabase)===canonical(preparation.database),'predecessor_database');
  await executeIntentChange(before,context,{
   guard:async()=>{unchanged();observeSyntheticMemberIdentity();verifyIntentUploadPreparation(preparation,candidate.manifest,current,Date.parse(preparation.observedAt));
    const fresh=observeIntentControlRaw();check(canonical(verifyCancellationControlPlane(fresh,source))===canonical(preparation.control),'execution_drift');
    verifyCareIntentDependencyViews(aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--no-include-property-values','--no-paginate']),
     aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--include-property-values','--no-paginate']),
     parseTemplate(aws(['cloudformation','get-template','--stack-name',binding.stackId,'--change-set-name',binding.id,'--template-stage','Original'])),input,binding,before.live);},
   execute:async(b,token)=>aws(['cloudformation','execute-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--client-request-token',token]),
   observe:async b=>{unchanged();observeSyntheticMemberIdentity();return {
    stack:aws(['cloudformation','describe-stacks','--stack-name',b.stackId]),
    changeSet:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate'])};},pause});
  const observeDeployment=async version=>{
   unchanged();const live=observeIntentControlRaw(),control=verifyIntentLiveControl(live,source,input,candidate,before,preparation);
   const codeBytes=await downloadIntentFunction(live.fn,candidate);
   const transport=transportFrom(live,version);
   const witness={observedAt:new Date().toISOString(),current,artifact,codeBytes,before,
    after:{stack:live.stack,template:live.template,fn:live.fn,resources:live.resources,
     integration:transport.integration,stage:live.stage,control,transport,
     changeSet:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--no-include-property-values','--no-paginate'])}};
   verifyCareIntentDeployment(witness,candidate,current,artifact,preparation,started,Date.now());return witness;
  };
  const deployed=await observeDeployment();record({stage:'intent_deployed_bytes_control_verified',revision:deployed.after.fn.RevisionId});
  const {recovery,transport}=await runLiveRecovery(root,context,before,input,source,deployed.after.fn,schema,started);
  // The returned stage is a new observed deployment. Refresh the deployment
  // witness from services, never patch a saved pre-recovery report to match it.
  const deployment=await observeDeployment(recovery.retained.configuration.Version);
  const evidenceOut=resolve(directory,'live-observations');mkdirSync(evidenceOut,{recursive:true});
  const {codeBytes,...deploymentMetadata}=deployment;
  const {codeBytes:retainedBytes,...retainedMetadata}=recovery.retained;
  const evidence={contract:'synthetic-care-intent-live-observations/1',deployment:deploymentMetadata,
   deployedDownloadSha256:sha256(codeBytes),recovery:{...recovery,retained:retainedMetadata},retainedDownloadSha256:sha256(retainedBytes),
   reportIsNotAuthority:true,phiAllowed:false};
  const evidenceFile=resolve(evidenceOut,sha256(canonical(evidence))+'.json');
  writeFileSync(evidenceFile,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  record({stage:'intent_raw_release_observations_archived',evidenceFile});
  const result=await releaseCareIntent({candidate,current,artifact,preparation,deployment,recovery},
   {started,now:Date.now,current:async()=>careIntentCurrent(root,mobileRoot),transport,schema,record,admit:context.admit});
  const out=resolve(directory,'releases');mkdirSync(out,{recursive:true});
  const report=resolve(out,sha256(canonical(result))+'.json');writeFileSync(report,JSON.stringify({...result,evidenceFile},null,2)+'\n',{flag:'wx'});
  record({stage:'intent_live_release_completed',report});return {report,evidenceFile,...result};
 });
 // Upload/proposal receipts keep their own nonexecuting scope. Actual release
 // fields are reported separately; do not relabel an upload as hosted acceptance.
 return {contract:'synthetic-care-intent-live-run/1',upload:uploaded,release:uploaded.proposal,
  operatorCustodySettled:uploaded.operatorCustodySettled,phiAllowed:false,paidMobileBuildStarted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>intentReleaseArgs(process.argv.slice(2))).then(({mobileRoot,directory})=>runCareIntentRelease(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(intentFailureCode(e));process.exitCode=1;});
}
