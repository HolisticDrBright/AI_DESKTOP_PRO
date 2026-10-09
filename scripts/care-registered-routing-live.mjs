/** Fixed AWS observers for current-schema predecessor recovery. No public CLI,
 * supplied report, identity/provider creation, migration or clinical write. */
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {CognitoIdentityProviderClient,InitiateAuthCommand} from '@aws-sdk/client-cognito-identity-provider';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {rehearseCareRegisteredRouting,verifyRegisteredIntentAnswer} from './care-registered-routing.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage,verifyRecoveryMetric,verifyRecoveryResponse} from './care-recovery-routing.mjs';
import {intentRecoveryPermission} from './care-intent-routing.mjs';
import {observeIntentControlRaw,downloadIntentFunction,intentPolicyAbsent} from './care-intent-live.mjs';
import {buildCareRegisteredDatabaseObserver,readCareRegisteredPredecessor} from './prepare-synthetic-care-registered-release.mjs';
import {CARE_CONSUMER_CASES,verifyPersonaRecords,verifyPersonaClaims,boundedCareJson} from './verify-synthetic-care-consumer.mjs';
import {verifyCancellationAnswer,verifyCancellationStoredReceipt} from './care-erasure-cancellation.mjs';
import {RECOVERY_AUTH_TRANSPORT} from './rehearse-synthetic-care-routing.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('routing_live_'+code);};
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const secretArn='arn:aws:secretsmanager:us-east-2:588966314750:secret:ai-longevity-pro/synthetic-staging/testflight-personas-piSA7p';
function aws(args,missingPolicyVersion){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 try{const text=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return text.trim()?JSON.parse(text):{};
 }catch(error){if(intentPolicyAbsent(args,missingPolicyVersion,error))return null;refuseRegistered('routing_live_aws_unconfirmed');}
}
/** Compile the exact application validator, not a handwritten approximation. */
export async function compileRegisteredIntentParser(root){
 const result=await build({absWorkingDir:root,stdin:{contents:"export {parseCareErasureRecoveryResponse} from './src/contracts/careErasureRecovery.ts';",
  resolveDir:root,sourcefile:'registered-recovery-contract.mjs',loader:'js'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 check(result.outputFiles?.length===1&&result.outputFiles[0].contents.length<=2*1024*1024,'parser_build');
 const parser=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
 check(typeof parser.parseCareErasureRecoveryResponse==='function','parser_export');return parser.parseCareErasureRecoveryResponse;
}
/** Invoked by the combined release or separately admitted rehearsal, under
 * its own durable
 * custody. This function cannot stand alone as activation or release evidence. */
export async function runCareRegisteredLiveRecovery(root,mobileRoot,input,custody,observerRoot=root){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 check(custody&&['verify','record','admit'].every(k=>typeof custody[k]==='function'),'custody_required');
 const {current}=input;check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(current),'source');
 const observerSource=input.observerSource??current;
 check(canonical(careRegisteredCurrent(observerRoot,mobileRoot))===canonical(observerSource),'observer_source');
 const sid=custody.recoverySid??'alp-care-intent-recovery-'+randomBytes(16).toString('hex');intentRecoveryPermission(sid,'2');
 observeSyntheticMemberIdentity();const predecessor=readCareRegisteredPredecessor(root),
  inspect=buildCareRegisteredDatabaseObserver(observerRoot,observerSource),parseIntent=await compileRegisteredIntentParser(root);
 const credentials=fromIni({profile}),options={region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT},
  secrets=new SecretsManagerClient(options),cognito=new CognitoIdentityProviderClient(options),
  rds=new RDSDataClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT});
 let rows=[];const authenticationIds=new Set(),receiptIds=new Map();
 const unchanged=()=>{check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
  check(canonical(careRegisteredCurrent(root,mobileRoot))===canonical(current),'source_changed');
  check(canonical(careRegisteredCurrent(observerRoot,mobileRoot))===canonical(observerSource),'observer_source_changed');custody.verify();observeSyntheticMemberIdentity();};
 const transport=async()=>{unchanged();return {raw:observeIntentControlRaw(),policy:aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'],'2')};};
 const authenticate=async row=>{
  unchanged();const auth=await cognito.send(new InitiateAuthCommand({ClientId:P.consumerClient,AuthFlow:'USER_PASSWORD_AUTH',
   AuthParameters:{USERNAME:row.email,PASSWORD:row.password}}),{abortSignal:AbortSignal.timeout(30000)});
  const token=auth.AuthenticationResult?.IdToken,id=auth.$metadata?.requestId;
  check(typeof token==='string'&&/^[A-Za-z0-9-]{8,128}$/.test(id??'')&&!authenticationIds.has(id),'authentication');
  authenticationIds.add(id);verifyPersonaClaims(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')),row);return token;
 };
 const request=async(token,spec)=>{
  unchanged();const response=await fetch(`https://${P.apiId}.execute-api.${P.region}.amazonaws.com${spec.path??'/clinical-core/consumer/care-data'}`,
   {method:spec.body?'POST':'GET',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:spec.body?JSON.stringify(spec.body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  return {response,value:await boundedCareJson(response)};
 };
 try{
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:secretArn}),{abortSignal:AbortSignal.timeout(30000)});
  check(secret.ARN===secretArn&&typeof secret.SecretString==='string'&&Buffer.byteLength(secret.SecretString)<=65536,'persona_secret');
  rows=JSON.parse(secret.SecretString);verifyPersonaRecords(rows);
  return await rehearseCareRegisteredRouting(input,{now:Date.now,parseIntent,inspect,
   observerCurrent:async()=>{unchanged();return careRegisteredCurrent(observerRoot,mobileRoot);},
   current:async()=>careRegisteredCurrent(root,mobileRoot),identity:async()=>observeSyntheticMemberIdentity(),custody:async()=>{unchanged();},
   record:custody.record,admit:async e=>{unchanged();await custody.admit(e);},transport,
   retained:async()=>{unchanged();const configuration=aws(['lambda','get-function-configuration','--function-name',P.functionName,'--qualifier','2']),
    bytes=await downloadIntentFunction(configuration,predecessor),policy=aws(['lambda','get-policy','--function-name',P.functionName,'--qualifier','2'],'2');
    return {configuration,sha256:sha256(bytes),bytes:bytes.length,policy};},
   consumerPhase:async()=>{const values=[];for(const row of rows){let token=await authenticate(row);
    try{for(const spec of CARE_CONSUMER_CASES){const {response,value}=await request(token,spec);
     values.push({persona:row.mode,...verifyRecoveryResponse(spec,response,value)});}}finally{token=undefined;}}return values;},
   receiptPhase:async phase=>{const values=[];for(const row of rows){
    unchanged();const found=await rds.send(new ExecuteStatementCommand({resourceArn:P.cluster,secretArn:P.secret,database:P.database,
     sql:"select request_id::text,scope,outcome,receipt is null as receipt_absent from clinical_core.care_data_erasure_requests where owner_id=cast(:owner as uuid) and scope='domain' and outcome='cancelled' and receipt is null order by request_id limit 2",
     parameters:[{name:'owner',value:{stringValue:row.personId}}]}),{abortSignal:AbortSignal.timeout(30000)});
    check(found.numberOfRecordsUpdated===0&&found.records?.length===1&&found.records[0].length===4,'receipt_inventory');
    const c=found.records[0];check(c.slice(0,3).every(v=>typeof v.stringValue==='string')&&typeof c[3].booleanValue==='boolean','receipt_shape');
    verifyCancellationStoredReceipt([{scope:c[1].stringValue,outcome:c[2].stringValue,receiptAbsent:c[3].booleanValue}]);
    const id=c[0].stringValue;if(phase==='baseline')receiptIds.set(row.mode,id);else check(receiptIds.get(row.mode)===id,'receipt_changed');
    let token=await authenticate(row);try{const body={action:'erase_receipt',scope:'domain',requestId:id},{response,value}=await request(token,{body});
     values.push({persona:row.mode,case:'existing_cancelled_receipt',erasureRequestId:id,
      ...verifyCancellationAnswer(body,'cancelled',response,value),bodySha256:sha256(canonical(value))});}finally{token=undefined;}
   }return values;},
   intentPhase:async phase=>{const values=[];for(const row of rows){let token=await authenticate(row);
    try{for(const action of ['discover_erasure_requests','prepare_erasure']){
     const body=action==='discover_erasure_requests'?{action,limit:100}:{action,scope:'domain'},
      {response,value}=await request(token,{body}),expectedRequestId=receiptIds.get(row.mode),
      checked=verifyRegisteredIntentAnswer(action,response.status,value,expectedRequestId,parseIntent);
     values.push({persona:row.mode,phase,action,requestId:response.headers.get('apigw-requestid'),value,expectedRequestId,...checked});
    }}finally{token=undefined;}}return values;},
   addPermission:async(sid,version)=>{unchanged();check(version==='2','version');const expected=intentRecoveryPermission(sid,version),
    actual=aws(['lambda','add-permission','--function-name',P.functionName,'--qualifier',version,'--statement-id',sid,
     '--action','lambda:InvokeFunction','--principal','apigateway.amazonaws.com','--source-arn',R.sourceArn,'--source-account',P.account]);
    check(canonical(JSON.parse(actual.Statement))===canonical(expected),'permission_reply');},
   removePermission:async(sid,version,revision)=>{unchanged();check(version==='2','version');
    aws(['lambda','remove-permission','--function-name',P.functionName,'--qualifier',version,'--statement-id',sid,'--revision-id',revision]);},
   switchUri:async uri=>{unchanged();check([R.latestArn,R.latestArn+':2'].includes(uri),'switch_target');
    aws(['apigatewayv2','update-integration','--api-id',P.apiId,'--integration-id',R.integrationId,'--integration-uri',uri]);},
   waitDeployment:async(previous,uri)=>{
    const deadline=Date.now()+180000;while(Date.now()<deadline){unchanged();
     const integration=aws(['apigatewayv2','get-integration','--api-id',P.apiId,'--integration-id',R.integrationId]);verifyRecoveryIntegration(integration,uri);
     const stage=aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']);
     if(stage.DeploymentId!==previous){try{verifyRecoveryStage(stage);
      const deployed=aws(['apigatewayv2','get-deployment','--api-id',P.apiId,'--deployment-id',stage.DeploymentId]);
      if(deployed.DeploymentId===stage.DeploymentId&&deployed.DeploymentStatus==='DEPLOYED')return await transport();
     }catch(e){if(!e.message?.endsWith(':recovery_stage'))throw e;}}await pause(2000);
    }refuseRegistered('routing_live_deployment_unconfirmed');
   },
   waitMetric:async(start,end,minimum,version)=>{check(version==='2','metric_version');const deadline=Date.now()+240000;
    while(Date.now()<deadline){unchanged();const actual=aws(['cloudwatch','get-metric-statistics','--namespace','AWS/Lambda','--metric-name','Invocations',
     '--dimensions',`Name=FunctionName,Value=${P.functionName}`,`Name=Resource,Value=${P.functionName}:2`,
     '--start-time',new Date(start).toISOString(),'--end-time',new Date(end).toISOString(),'--period','60','--statistics','Sum']);
     try{verifyRecoveryMetric(actual,start,end,minimum);return actual;}catch(e){if(!e.message?.endsWith(':recovery_version_not_observed'))throw e;}
     await pause(10000);
    }refuseRegistered('routing_live_metric_unconfirmed');
   },
  },sid);
 }finally{for(const row of rows)if(row&&typeof row==='object')delete row.password;rows=[];secrets.destroy();cognito.destroy();rds.destroy();}
}
