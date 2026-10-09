/** Actual fixed-target retained-version traffic rehearsal. Never enables PHI or applies SQL. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {CognitoIdentityProviderClient,InitiateAuthCommand} from '@aws-sdk/client-cognito-identity-provider';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,careSourceSnapshot,normalizedText,sha256,refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D,verifyDeployedCareArtifact,verifyDeployedCareObservation} from './verify-deployed-synthetic-care.mjs';
import {verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {verifyCareVersionLatest,verifyRetainedCareVersion,runCareVersionChild} from './retain-synthetic-care-version.mjs';
import {PERSONA_EMAILS,CARE_CONSUMER_CASES,verifyPersonaRecords,verifyPersonaClaims,boundedCareJson} from './verify-synthetic-care-consumer.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,recoveryPermission,rehearseCareRecovery,rehearseCarePostParentRecovery,verifyRecoveryResponse,verifyRecoveryStage,
 verifyRecoveryIntegration,verifyRecoveryMetric} from './care-recovery-routing.mjs';
import {verifyCancellationDatabase,verifyCancellationAnswer,verifyCancellationStoredReceipt} from './care-erasure-cancellation.mjs';
import {collectCancellationInventory,verifyCancellationControlPlane} from './verify-synthetic-care-cancellation.mjs';
const secretArn='arn:aws:secretsmanager:us-east-2:588966314750:secret:ai-longevity-pro/synthetic-staging/testflight-personas-piSA7p';
const check=(ok,code)=>{if(!ok)fail('recovery_'+code);};
// Blocking AWS CLI inspections can leave an idle pooled socket's close event
// pending. Authentication gets a fresh connection, never a longer deadline or retry.
export const RECOVERY_AUTH_TRANSPORT=Object.freeze({httpsAgent:Object.freeze({keepAlive:false,maxSockets:1}),
 connectionTimeout:10000,requestTimeout:30000});
let phase='entry';
export function recoveryFailureCode(error,at){
 const phases=['entry','arguments','source','principal','lock','build','artifact','inspector','personas','rehearsal','write_report'];
 for(const name of ['baseline','retained','returned'])for(const mode of Object.keys(PERSONA_EMAILS)){
  phases.push(name+'_authenticate_'+mode);
  for(const spec of CARE_CONSUMER_CASES)phases.push(name+'_'+mode+'_'+spec.name);
 }
 const safePhase=phases.includes(at)?at:'entry';
 const known=/^synthetic_care_release_refused:([a-z0-9_]{1,140})$/.exec(error?.message??'');
 if(known)return 'synthetic_care_release_refused:'+known[1];
 if(error?.message==='synthetic_member_principal_refused')return 'synthetic_care_release_refused:recovery_'+safePhase+'_principal_refused';
 const consumer=/^synthetic_care_consumer_refused:([a-z0-9_]{1,80})$/.exec(error?.message??'');
 if(consumer)return 'synthetic_care_release_refused:recovery_consumer_'+consumer[1];
 const names={NotAuthorizedException:'not_authorized',TooManyRequestsException:'rate_limited',UserNotConfirmedException:'not_confirmed',
  PasswordResetRequiredException:'reset_required',TimeoutError:'timeout',AbortError:'aborted',SyntaxError:'invalid_json',TypeError:'transport_type_error'};
 if(Object.hasOwn(names,error?.name??''))return 'synthetic_care_release_refused:recovery_'+safePhase+'_'+names[error.name];
 return 'synthetic_care_release_refused:recovery_'+safePhase+(error?.code==='ETIMEDOUT'?'_timeout':'_failed');
}
export function recoveryArgs(args){check(args.length===1&&args[0]==='--rehearse-existing-fictional-version','arguments');}
export function postParentRecoveryArgs(args){check(args.length===1&&args[0]==='--rehearse-post-parent-fictional-receipts','arguments');}
export function recoveryAwsOutput(args,stdout){
 if(args[0]==='lambda'&&args[1]==='remove-permission'&&typeof stdout==='string'&&stdout.trim()==='')return {};
 try{return JSON.parse(stdout);}catch{fail('recovery_aws_outcome_unconfirmed');}
}
export function recoveryMissingPolicy(args,error,policyMayBeAbsent){
 const stderr=String(error?.stderr??'');
 return policyMayBeAbsent===true&&args[0]==='lambda'&&args[1]==='get-policy'&&args.at(-1)===R.version
  &&stderr.length<=4096&&/(?:^|\r?\n)(?:aws: \[ERROR\]: )?An error occurred \(ResourceNotFoundException\) when calling the GetPolicy operation:/.test(stderr);
}
function aws(args,policyMayBeAbsent=false){
 try{return recoveryAwsOutput(args,execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json'],
  {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}));}
 catch(error){
  if(recoveryMissingPolicy(args,error,policyMayBeAbsent))return null;
  fail('recovery_aws_outcome_unconfirmed');
 }
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function verifyRecoveryLatestPolicy(response){
 let p;try{p=JSON.parse(response?.Policy);}catch{fail('recovery_latest_policy');}
 check(p?.Version==='2012-10-17'&&Array.isArray(p.Statement)&&p.Statement.length===1&&typeof response.RevisionId==='string'&&response.RevisionId.length>0,'latest_policy');
 const s=p.Statement[0];check(typeof s.Sid==='string'&&s.Sid.startsWith(P.stack+'-IdentityApiInvokePermission-')
  &&canonical(s)===canonical({Sid:s.Sid,Effect:'Allow',Principal:{Service:'apigateway.amazonaws.com'},Action:'lambda:InvokeFunction',
   Resource:R.latestArn,Condition:{ArnLike:{'AWS:SourceArn':R.sourceArn}}}),'latest_policy');
}
export function verifyRecoveryInspector(operator,bytes,harness){
 check(operator?.contract==='care-erasure-schema-upgrade-build/1'&&operator.sourceCommit===harness.commit
  &&operator.clean===true&&operator.execution==='synthetic-staging'&&operator.phiAllowed===false
  &&operator.migrationPerformed===false&&operator.sourceMigrationCount===46&&operator.expectedLiveBefore===46
  &&operator.expectedLiveAfter===47&&operator.historicalAliasPreserved===true&&operator.mandatoryRollbackRehearsal===true
  &&operator.embeddedMigrations===true&&operator.embeddedReferenceMigrations===true&&operator.targetOverrides===false
  &&operator.sha256===sha256(bytes),'inspector_artifact');
}
/** No successful continuation is certified until its durable completion entry
 * exists. Unknown database/report outcomes leave custody admitted but unsettled. */
export async function continueCareRecovery(report,transport,afterRecovery,record,custody){
 if(afterRecovery===undefined)return report;
 check(typeof afterRecovery==='function','continuation');
 await record('continuation_admitted');custody.admitted=true;
 const continuation=await afterRecovery(report,transport);
 await record('continuation_completed');custody.finished=true;
 return {recovery:report,continuation};
}
/** The optional continuation is trusted source wiring, never a CLI/report override.
 * Its work remains inside the same exclusive operator custody. A failed continuation
 * retains the lock for independent diagnosis; it must never trigger an automatic retry. */
export async function runCareRecovery(afterRecovery){
 return runBoundCareRecovery(afterRecovery,false);
}
/** No continuation/migration hook is exposed by the post-parent entry point. */
export async function runCarePostParentRecovery(){return runBoundCareRecovery(undefined,true);}
async function runBoundCareRecovery(afterRecovery,postParent){
 const root=process.cwd();
 phase='source';const harness=careSourceSnapshot(root,'desktop');phase='principal';observeSyntheticMemberIdentity();
 // Serialize local runners, and preserve a stale lock after unknown restoration.
 phase='lock';const directory=resolve(root,'dist/synthetic-care-routing');mkdirSync(directory,{recursive:true});
 const runId=randomBytes(16).toString('hex'),sid='alp-care-recovery-'+runId,lock=resolve(directory,'operator.lock');
 try{writeFileSync(lock,JSON.stringify({runId,harness,pid:process.pid})+'\n',{flag:'wx'});}catch{fail('recovery_operator_lock');}
 const recordFile=resolve(directory,runId+'.events.jsonl'),custody={admitted:false,finished:false};let admitted=false,restored=false,rows=[];
 const credentials=fromIni({profile}),s3=new S3Client({region:P.region,credentials,maxAttempts:1}),
  secrets=new SecretsManagerClient({region:P.region,credentials,maxAttempts:1}),cognito=new CognitoIdentityProviderClient({region:P.region,credentials,maxAttempts:1,
   requestHandler:RECOVERY_AUTH_TRANSPORT}),rds=new RDSDataClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT});
 try{
  phase='build';
  runCareVersionChild(()=>execFileSync(process.execPath,[resolve(root,'scripts/build-care-erasure-schema-upgrade.mjs')],
   {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}),'build');
  phase='artifact';const artifactDir=resolve(root,'dist/synthetic-care-release',D.desktop,D.mobile),manifest=JSON.parse(readFileSync(resolve(artifactDir,'artifact-manifest.json'),'utf8')),
   release=JSON.parse(readFileSync(resolve(artifactDir,'release.json'),'utf8')),bundle=readFileSync(resolve(artifactDir,'index.js')),zip=readFileSync(resolve(artifactDir,'candidate.zip'));
  verifyDeployedCareArtifact(manifest,release,bundle,zip);
  phase='inspector';const operatorDir=resolve(root,'dist/aws-clinical-core/care-erasure-schema-upgrade'),operator=JSON.parse(readFileSync(resolve(operatorDir,'artifact-manifest.json'),'utf8'));
  verifyRecoveryInspector(operator,readFileSync(resolve(operatorDir,'index.cjs')),harness);
  const unchanged=()=>check(canonical(careSourceSnapshot(root,'desktop'))===canonical(harness),'harness_changed');
  const inventory=(args,key,token)=>collectCancellationInventory(aws,args,key,token);
  const getVersionPolicy=()=>aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier',R.version],true);
  const transport=async()=>{
   unchanged();observeSyntheticMemberIdentity();
   const latest=aws(['lambda','get-function-configuration','--function-name',P.functionName]);verifyCareVersionLatest(latest,latest.RevisionId);
   verifyRetainedCareVersion(aws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier',R.version]),latest);
   const integrations=inventory(['apigatewayv2','get-integrations','--api-id',P.apiId,'--max-results','100'],'Items','NextToken');
   check(Array.isArray(integrations.Items)&&!integrations.NextToken&&integrations.Items.filter(i=>i.IntegrationId===R.integrationId).length===1,'integration_inventory');
   const basePolicy=aws(['lambda','get-policy','--function-name',P.functionName]);verifyRecoveryLatestPolicy(basePolicy);
   return {integration:integrations.Items.find(i=>i.IntegrationId===R.integrationId),
    otherIntegrationsSha256:sha256(canonical(integrations.Items.filter(i=>i.IntegrationId!==R.integrationId))),
    stage:aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']),
    routesSha256:sha256(canonical(inventory(['apigatewayv2','get-routes','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'))),
    authorizersSha256:sha256(canonical(inventory(['apigatewayv2','get-authorizers','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'))),
    revisionId:latest.RevisionId,policy:getVersionPolicy(),latestPolicySha256:sha256(canonical(basePolicy))};
  };
  const inspect=async()=>{
   unchanged();const caller=observeSyntheticMemberIdentity();
   const request={Bucket:P.bucket,ExpectedBucketOwner:P.account,Key:manifest.key,VersionId:D.version,ChecksumMode:'ENABLED'};
   verifyCareStoredArtifact(await s3.send(new HeadObjectCommand(request),{abortSignal:AbortSignal.timeout(30000)}),manifest,D.version);
   const signal=AbortSignal.timeout(30000),object=await s3.send(new GetObjectCommand(request),{abortSignal:signal});
   try{verifyCareStoredArtifact(object,manifest,D.version);}catch(e){object.Body?.destroy?.();throw e;}
   check((await readCareArtifact(object.Body,manifest,signal)).equals(zip),'stored_artifact');
   const foundation=aws(['cloudformation','describe-stacks','--stack-name',P.foundation]),stack=aws(['cloudformation','describe-stacks','--stack-name',P.stack]);
   const body=aws(['cloudformation','get-template','--stack-name',P.stack]).TemplateBody,template=typeof body==='string'?JSON.parse(body):body;
   const fn=aws(['lambda','get-function-configuration','--function-name',P.functionName]),integrations=inventory(['apigatewayv2','get-integrations','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
    routes=inventory(['apigatewayv2','get-routes','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),authorizers=inventory(['apigatewayv2','get-authorizers','--api-id',P.apiId,'--max-results','100'],'Items','NextToken'),
    resources=aws(['cloudformation','describe-stack-resources','--stack-name',P.stack]);
   const roleName=resources.StackResources?.find(r=>r.LogicalResourceId==='IdentityApiRole')?.PhysicalResourceId;
   check(typeof roleName==='string'&&/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName),'role_name');
   const role=aws(['iam','get-role','--role-name',roleName]),attached=aws(['iam','list-attached-role-policies','--role-name',roleName,'--no-paginate']),
    inline=aws(['iam','list-role-policies','--role-name',roleName,'--no-paginate']),
    policies=['AuroraDataApiTransactionOnly','ManagedDatabaseCredentialRead','BoundedFunctionLogging'].map(name=>aws(['iam','get-role-policy','--role-name',roleName,'--policy-name',name])),
    logGroups=inventory(['logs','describe-log-groups','--log-group-name-prefix','/ai-clinical-core/synthetic-staging/identity-api','--limit','50'],'logGroups','nextToken');
   const raw=runCareVersionChild(()=>execFileSync(process.execPath,[resolve(operatorDir,'index.cjs'),'inspect'],
    {encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}),'preflight');
   let database;try{database=JSON.parse(raw);}catch{fail('recovery_database_output');}
   const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
   const observation={caller,foundation,stack,template,fn,integrations,routes,authorizers,database,resources,role,attached,inline,policies,logGroups};
   let proof;
   if(postParent){
    verifyCancellationDatabase(database,harness);
    proof=verifyCancellationControlPlane({...observation,stage:aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']),
     latestPolicy:aws(['lambda','get-policy','--function-name',P.functionName])},source);
   }else proof=verifyDeployedCareObservation(observation,source,manifest,harness);
   unchanged();return {source:D.desktop,zip:D.zip,s3Version:D.version,artifactVerified:true,iamVerified:true,loggingVerified:true,harness,
    templateSha256:proof.templateSha256,...(postParent?{routesSha256:proof.routesSha256,authorizersSha256:proof.authorizersSha256,
     roleSha256:proof.roleSha256}:{apiInventorySha256:proof.apiInventorySha256}),revisionId:fn.RevisionId,
    database:{liveCount:database.observedMigrationCount,sourceCount:database.sourceMigrationCount,tableCount:database.tableCount,
     rows:database.rowCount,dataSha256:database.dataSha256,liveLedger:postParent?database.toLedgerSha256:database.fromLedgerSha256,
     referenceLedger:database.referenceLedgerSha256,...(postParent?{originalRows:database.originalRowCount,
      originalDataSha256:database.originalDataSha256}:{})}};
  };
  // Load only the existing five fictional identities. No emails/accounts/passwords are created or reset.
  phase='personas';const secret=await secrets.send(new GetSecretValueCommand({SecretId:secretArn}),{abortSignal:AbortSignal.timeout(30000)});
  check(secret.ARN===secretArn&&typeof secret.SecretString==='string'&&Buffer.byteLength(secret.SecretString)<=65536,'persona_secret');
  rows=JSON.parse(secret.SecretString);verifyPersonaRecords(rows);
  const receiptIds=new Map();
  // Discover only actual existing cancellations belonging to the five fictional
  // owners. Historical reports and command-line values cannot supply these IDs.
  const receiptPhase=async name=>{
   const observations=[];
   for(const row of rows){
    unchanged();observeSyntheticMemberIdentity();
    const found=await rds.send(new ExecuteStatementCommand({resourceArn:P.cluster,secretArn:P.secret,database:P.database,
     sql:"select request_id::text,scope,outcome,receipt is null as receipt_absent from clinical_core.care_data_erasure_requests where owner_id=cast(:owner as uuid) and scope='domain' and outcome='cancelled' and receipt is null order by request_id limit 2",
     parameters:[{name:'owner',value:{stringValue:row.personId}}]}),{abortSignal:AbortSignal.timeout(30000)});
    check(found.numberOfRecordsUpdated===0&&found.records?.length===1,'existing_receipt_inventory');
    const columns=found.records[0];
    check(columns.length===4&&columns.slice(0,3).every(v=>typeof v.stringValue==='string')
     &&typeof columns[3].booleanValue==='boolean','existing_receipt_shape');
    const id=columns[0].stringValue;
    verifyCancellationStoredReceipt([{scope:columns[1].stringValue,outcome:columns[2].stringValue,receiptAbsent:columns[3].booleanValue}]);
    if(name==='baseline')receiptIds.set(row.mode,id);else check(receiptIds.get(row.mode)===id,'existing_receipt_changed');
    const auth=await cognito.send(new InitiateAuthCommand({ClientId:P.consumerClient,AuthFlow:'USER_PASSWORD_AUTH',
     AuthParameters:{USERNAME:row.email,PASSWORD:row.password}}),{abortSignal:AbortSignal.timeout(30000)});
    let token=auth.AuthenticationResult?.IdToken;check(typeof token==='string','persona_id_token');
    verifyPersonaClaims(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')),row);
    try{
     const input={action:'erase_receipt',scope:'domain',requestId:id};
     const response=await fetch(`https://${P.apiId}.execute-api.${P.region}.amazonaws.com/clinical-core/consumer/care-data`,
      {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(input),
       redirect:'error',signal:AbortSignal.timeout(30000)});
     const value=await boundedCareJson(response),answer=verifyCancellationAnswer(input,'cancelled',response,value),
      observation={persona:row.mode,case:'existing_cancelled_receipt',erasureRequestId:id,...answer,bodySha256:sha256(canonical(value))};
     observations.push(observation);
     appendFileSync(recordFile,JSON.stringify({stage:'existing_receipt_verified',phase:name,at:new Date().toISOString(),...observation})+'\n');
    }finally{token=undefined;}
   }return observations;
  };
  const consumerPhase=async name=>{
   check(['baseline','retained','returned'].includes(name),'consumer_phase');
   const observations=[];
   for(const row of rows){
    phase=name+'_authenticate_'+row.mode;
    appendFileSync(recordFile,JSON.stringify({stage:'consumer_authentication_admitted',phase:name,persona:row.mode,at:new Date().toISOString()})+'\n');
    const auth=await cognito.send(new InitiateAuthCommand({ClientId:P.consumerClient,AuthFlow:'USER_PASSWORD_AUTH',
     AuthParameters:{USERNAME:row.email,PASSWORD:row.password}}),{abortSignal:AbortSignal.timeout(30000)});
    let token=auth.AuthenticationResult?.IdToken;check(typeof token==='string','persona_id_token');
    verifyPersonaClaims(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')),row);
    try{for(const spec of CARE_CONSUMER_CASES){
     phase=name+'_'+row.mode+'_'+spec.name;
     const response=await fetch(`https://${P.apiId}.execute-api.${P.region}.amazonaws.com${spec.path}`,{method:spec.body?'POST':'GET',
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:spec.body?JSON.stringify(spec.body):undefined,
      redirect:'error',signal:AbortSignal.timeout(30000)});
     const value=await boundedCareJson(response),observation={persona:row.mode,...verifyRecoveryResponse(spec,response,value)};
     observations.push(observation);
     appendFileSync(recordFile,JSON.stringify({stage:'consumer_case_verified',phase:name,at:new Date().toISOString(),...observation})+'\n');
    }}finally{token=undefined;}
   }return observations;
  };
  const d={now:Date.now,inspect,transport,consumerPhase,...(postParent?{receiptPhase}:{}),
   record:async event=>{if(event.stage==='permission_admitted')admitted=true;if(event.stage==='routing_and_permission_restored')restored=true;
    appendFileSync(recordFile,JSON.stringify(event)+'\n',{encoding:'utf8'});},
   addPermission:async id=>{const statement=recoveryPermission(id);const answer=aws(['lambda','add-permission','--function-name',P.functionName,'--qualifier',R.version,
    '--statement-id',id,'--action','lambda:InvokeFunction','--principal','apigateway.amazonaws.com','--source-arn',R.sourceArn,'--source-account',P.account]);
    check(canonical(JSON.parse(answer.Statement))===canonical(statement),'added_permission');},
   removePermission:async(id,revision)=>{aws(['lambda','remove-permission','--function-name',P.functionName,'--qualifier',R.version,'--statement-id',id,'--revision-id',revision]);},
   switchUri:async uri=>{check([R.latestArn,R.retainedArn].includes(uri),'switch_target');
    aws(['apigatewayv2','update-integration','--api-id',P.apiId,'--integration-id',R.integrationId,'--integration-uri',uri]);},
   waitDeployment:async(previous,uri)=>{
    const deadline=Date.now()+120000;while(Date.now()<deadline){const current=await transport();verifyRecoveryIntegration(current.integration,uri);
     if(current.stage.DeploymentId!==previous){try{verifyRecoveryStage(current.stage);
      const deployment=aws(['apigatewayv2','get-deployment','--api-id',P.apiId,'--deployment-id',current.stage.DeploymentId]);
      if(deployment.DeploymentStatus==='DEPLOYED'&&deployment.DeploymentId===current.stage.DeploymentId)return current;
     }catch(e){if(!String(e.message).startsWith('synthetic_care_release_refused:recovery_stage'))throw e;}}
     await pause(2000);
    }fail('recovery_deployment_timeout');
   },
   waitMetric:async(start,end,minimum)=>{
    const deadline=Date.now()+180000;while(Date.now()<deadline){const metric=aws(['cloudwatch','get-metric-statistics','--namespace','AWS/Lambda','--metric-name','Invocations',
     '--dimensions',`Name=FunctionName,Value=${P.functionName}`,`Name=Resource,Value=${P.functionName}:${R.version}`,
     '--start-time',new Date(start).toISOString(),'--end-time',new Date(end).toISOString(),'--period','60','--statistics','Sum']);
     try{verifyRecoveryMetric(metric,start,end,minimum);return metric;}catch(e){if(!String(e.message).endsWith(':recovery_version_not_observed'))throw e;}
     await pause(10000);
    }fail('recovery_metric_timeout');
   }};
  phase='rehearsal';const result=await (postParent?rehearseCarePostParentRecovery(d,sid):rehearseCareRecovery(d,sid));unchanged();phase='write_report';
  const file=resolve(directory,runId+'.json');writeFileSync(file,JSON.stringify({...result,harness,observedAt:new Date().toISOString(),
   sourceRebuiltNow:false,immutableReviewedArtifactVerified:true,operatorJournal:recordFile},null,2)+'\n',{flag:'wx'});
  const report={report:file,...result,harness};
  unchanged();return await continueCareRecovery(report,transport,afterRecovery,
   async stage=>{appendFileSync(recordFile,JSON.stringify({stage,at:new Date().toISOString()})+'\n');},custody);
 }catch(error){
  appendFileSync(recordFile,JSON.stringify({stage:'finding',at:new Date().toISOString(),code:recoveryFailureCode(error,phase),
   mutationAdmitted:admitted,restorationObserved:restored,continuationAdmitted:custody.admitted,continuationFinished:custody.finished})+'\n');
  throw error;
 }finally{
  for(const row of rows)if(row&&typeof row==='object')delete row.password;s3.destroy();secrets.destroy();cognito.destroy();rds.destroy();
  if((!admitted||restored)&&(!custody.admitted||custody.finished)){
   const recorded=JSON.parse(readFileSync(lock,'utf8'));if(recorded.runId===runId)unlinkSync(lock);}
 }
}
async function main(){phase='arguments';const args=process.argv.slice(2);
 if(args[0]==='--rehearse-post-parent-fictional-receipts'){
  postParentRecoveryArgs(args);console.log(JSON.stringify(await runCarePostParentRecovery()));
 }else{recoveryArgs(args);console.log(JSON.stringify(await runCareRecovery()));}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
 console.error(recoveryFailureCode(error,phase));process.exitCode=1;
});
