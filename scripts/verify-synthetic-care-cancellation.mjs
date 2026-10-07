/** Actual parent cancellation-first acceptance. Fixed target; no target/report/skip overrides. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,unlinkSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {S3Client,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {CognitoIdentityProviderClient,InitiateAuthCommand} from '@aws-sdk/client-cognito-identity-provider';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {CARE_RELEASE as P,careSourceSnapshot,sha256,normalizedText,refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D,verifyDeployedCareArtifact,verifyDeployedCareRole} from './verify-deployed-synthetic-care.mjs';
import {verifyCareStoredArtifact,readCareArtifact} from './upload-synthetic-care-release.mjs';
import {verifyCareVersionLatest,runCareVersionChild} from './retain-synthetic-care-version.mjs';
import {verifyRecoveryInspector,verifyRecoveryLatestPolicy,RECOVERY_AUTH_TRANSPORT} from './rehearse-synthetic-care-routing.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryIntegration,verifyRecoveryStage} from './care-recovery-routing.mjs';
import {verifyPersonaRecords,verifyPersonaClaims,boundedCareJson} from './verify-synthetic-care-consumer.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {careCancellationArgs,verifyCareCancellation} from './care-erasure-cancellation.mjs';
const check=(ok,code)=>{if(!ok)fail('erasure_cancellation_'+code);};
const secretArn='arn:aws:secretsmanager:us-east-2:588966314750:secret:ai-longevity-pro/synthetic-staging/testflight-personas-piSA7p';
const authId=v=>typeof v==='string'&&/^[A-Za-z0-9-]{8,128}$/.test(v);
function aws(args){
 try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json'],
  {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}));}
 catch{fail('erasure_cancellation_aws_observation');}
}
const entries=(rows,k,v)=>{
 check(Array.isArray(rows)&&rows.every(x=>typeof x?.[k]==='string'&&typeof x?.[v]==='string')
  &&new Set(rows.map(x=>x[k])).size===rows.length,'target_bindings');
 return Object.fromEntries(rows.map(x=>[x[k],x[v]]));
};
export function verifyCancellationControlPlane(o,source){
 const foundation=o.foundation?.Stacks?.[0],stack=o.stack?.Stacks?.[0];
 for(const [item,name,response] of [[foundation,P.foundation,o.foundation],[stack,P.stack,o.stack]])
  check(response?.Stacks?.length===1&&['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(item?.StackStatus)
   &&item.StackId?.startsWith(`arn:aws:cloudformation:${P.region}:${P.account}:stack/${name}/`),'stack');
 const output=entries(foundation.Outputs,'OutputKey','OutputValue');
 for(const [key,value] of Object.entries({PhiAllowed:'false',Environment:'synthetic-staging',DataClassification:'synthetic_only',
  DatabaseName:P.database,ClinicalApiId:P.apiId,DatabaseClusterArn:P.cluster,DatabaseSecretArn:P.secret}))check(output[key]===value,'foundation');
 const params=entries(stack.Parameters,'ParameterKey','ParameterValue'),key=`clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`;
 check(canonical(params)===canonical({ClinicalApiId:P.apiId,DatabaseName:P.database,DatabaseClusterArn:P.cluster,DatabaseSecretArn:'****',
  ConsumerUserPoolId:P.consumerPool,ConsumerUserPoolClientId:P.consumerClient,WorkforceUserPoolId:P.workforcePool,
  WorkforceUserPoolClientId:P.workforceClient,ClinicalCoreKeyArn:P.keyArn,LambdaCodeBucket:P.bucket,LambdaCodeKey:key}),'stack_parameters');
 const template=structuredClone(source);
 for(const name of P.absentRoutes){check(template.Resources?.[name],'source_route');delete template.Resources[name];}
 template.Outputs.RoutesEnabled.Value='51';
 template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 check(canonical(o.template)===canonical(template),'template');
 verifyCareVersionLatest(o.fn,o.fn?.RevisionId);
 verifyDeployedCareRole(o,source);
 check(Array.isArray(o.integrations?.Items)&&!o.integrations.NextToken
  &&o.integrations.Items.filter(i=>i.IntegrationId===R.integrationId).length===1,'integrations');
 verifyRecoveryIntegration(o.integrations.Items.find(i=>i.IntegrationId===R.integrationId),R.latestArn);
 verifyRecoveryStage(o.stage);verifyRecoveryLatestPolicy(o.latestPolicy);
 check(Array.isArray(o.routes?.Items)&&!o.routes.NextToken&&Array.isArray(o.authorizers?.Items)&&!o.authorizers.NextToken
  &&new Set(o.routes.Items.map(r=>r.RouteKey)).size===o.routes.Items.length,'routes');
 const live=o.routes.Items.filter(r=>r.Target===`integrations/${R.integrationId}`);
 const declared=Object.values(template.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route');
 check(live.length===51&&declared.length===51,'route_count');
 for(const resource of declared){
  const prop=resource.Properties,route=live.find(r=>r.RouteKey===prop.RouteKey);
  const pool=prop.AuthorizerId?.Ref==='ConsumerJwtAuthorizer'?[P.consumerPool,P.consumerClient]
   :prop.AuthorizerId?.Ref==='WorkforceJwtAuthorizer'?[P.workforcePool,P.workforceClient]:fail('erasure_cancellation_source_authorizer');
  const a=o.authorizers.Items.find(a=>a.AuthorizerId===route?.AuthorizerId);
  check(route?.AuthorizationType==='JWT'&&a?.AuthorizerType==='JWT'
   &&canonical(a.IdentitySource)===canonical(['$request.header.Authorization'])
   &&a.JwtConfiguration?.Issuer===`https://cognito-idp.${P.region}.amazonaws.com/${pool[0]}`
   &&canonical(a.JwtConfiguration?.Audience)===canonical([pool[1]]),'route_authority');
 }
 const stableRole=structuredClone(o.role);delete stableRole.Role.RoleLastUsed;
 const stableLogs=structuredClone(o.logGroups);
 for(const group of stableLogs.logGroups)delete group.storedBytes;
 return {revision:o.fn.RevisionId,codeSha256:o.fn.CodeSha256,
  templateSha256:sha256(canonical(o.template)),routesSha256:sha256(canonical(o.routes)),
  authorizersSha256:sha256(canonical(o.authorizers)),integrationsSha256:sha256(canonical(o.integrations)),
  stageSha256:sha256(canonical(o.stage)),policySha256:sha256(canonical(o.latestPolicy)),
  roleSha256:sha256(canonical({role:stableRole,attached:o.attached,inline:o.inline,policies:o.policies,logs:stableLogs})),
  routeCount:51,iamVerified:true,loggingVerified:true,phiAllowed:false};
}
export function cancellationFailureCode(error){
 const known=/^synthetic_care_release_refused:([a-z0-9_]{1,180})$/.exec(error?.message??'');
 return known?'synthetic_care_release_refused:'+known[1]:'synthetic_care_release_refused:erasure_cancellation_failed';
}
export async function runCareCancellation(){
 const root=process.cwd(),harness=careSourceSnapshot(root,'desktop');observeSyntheticMemberIdentity();
 const dir=resolve(root,'dist/synthetic-care-cancellation'),custodyDir=resolve(root,'dist/synthetic-care-routing');
 mkdirSync(dir,{recursive:true});mkdirSync(custodyDir,{recursive:true});
 const runId=randomBytes(16).toString('hex'),lock=resolve(custodyDir,'operator.lock'),journal=resolve(dir,runId+'.events.jsonl');
 try{writeFileSync(lock,JSON.stringify({runId,harness,pid:process.pid,purpose:'parent-cancellation-first'})+'\n',{flag:'wx'});}
 catch{fail('erasure_cancellation_operator_lock');}
 const credentials=fromIni({profile}),s3=new S3Client({region:P.region,credentials,maxAttempts:1}),
  secrets=new SecretsManagerClient({region:P.region,credentials,maxAttempts:1}),
  cognito=new CognitoIdentityProviderClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT}),
  rds=new RDSDataClient({region:P.region,credentials,maxAttempts:1,requestHandler:RECOVERY_AUTH_TRANSPORT});
 const sessions=new Map();
 let rows=[],settled=false,mutationAdmitted=false;
 const record=async e=>{appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),...e})+'\n');
  if(e.stage==='case_admitted'&&['settle_erasure','erase_request'].includes(e.action))mutationAdmitted=true;};
 try{
  const unchanged=()=>check(canonical(careSourceSnapshot(root,'desktop'))===canonical(harness),'source_changed');
  runCareVersionChild(()=>execFileSync(process.execPath,[resolve(root,'scripts/build-care-erasure-schema-upgrade.mjs')],
   {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}),'build');
  const operatorDir=resolve(root,'dist/aws-clinical-core/care-erasure-schema-upgrade');
  verifyRecoveryInspector(JSON.parse(readFileSync(resolve(operatorDir,'artifact-manifest.json'),'utf8')),
   readFileSync(resolve(operatorDir,'index.cjs')),harness);
  const artifactDir=resolve(root,'dist/synthetic-care-release',D.desktop,D.mobile),
   manifest=JSON.parse(readFileSync(resolve(artifactDir,'artifact-manifest.json'),'utf8')),
   release=JSON.parse(readFileSync(resolve(artifactDir,'release.json'),'utf8')),
   bundle=readFileSync(resolve(artifactDir,'index.js')),zip=readFileSync(resolve(artifactDir,'candidate.zip'));
  verifyDeployedCareArtifact(manifest,release,bundle,zip);
  const request={Bucket:P.bucket,ExpectedBucketOwner:P.account,Key:manifest.key,VersionId:D.version,ChecksumMode:'ENABLED'};
  verifyCareStoredArtifact(await s3.send(new HeadObjectCommand(request),{abortSignal:AbortSignal.timeout(30000)}),manifest,D.version);
  const signal=AbortSignal.timeout(30000),object=await s3.send(new GetObjectCommand(request),{abortSignal:signal});
  const bytes=await readCareArtifact(object.Body,manifest,signal);check(bytes.equals(zip),'immutable_artifact');
  const source=JSON.parse(normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'));
  const control=async()=>{
   unchanged();observeSyntheticMemberIdentity();
   const resources=aws(['cloudformation','describe-stack-resources','--stack-name',P.stack]),
    roleName=resources.StackResources?.find(r=>r.LogicalResourceId==='IdentityApiRole')?.PhysicalResourceId;
   check(typeof roleName==='string'&&/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName),'role_name');
   const raw=aws(['cloudformation','get-template','--stack-name',P.stack]).TemplateBody,
    inline=aws(['iam','list-role-policies','--role-name',roleName]);
   check(inline.PolicyNames?.length<=10&&!inline.IsTruncated,'role_policies');
   return verifyCancellationControlPlane({
    foundation:aws(['cloudformation','describe-stacks','--stack-name',P.foundation]),
    stack:aws(['cloudformation','describe-stacks','--stack-name',P.stack]),
    template:typeof raw==='string'?JSON.parse(raw):raw,
    fn:aws(['lambda','get-function-configuration','--function-name',P.functionName]),resources,
    role:aws(['iam','get-role','--role-name',roleName]),
    attached:aws(['iam','list-attached-role-policies','--role-name',roleName]),inline,
    policies:inline.PolicyNames.map(name=>aws(['iam','get-role-policy','--role-name',roleName,'--policy-name',name])),
    logGroups:aws(['logs','describe-log-groups','--log-group-name-prefix','/ai-clinical-core/synthetic-staging/identity-api']),
    integrations:aws(['apigatewayv2','get-integrations','--api-id',P.apiId]),
    routes:aws(['apigatewayv2','get-routes','--api-id',P.apiId]),
    authorizers:aws(['apigatewayv2','get-authorizers','--api-id',P.apiId]),
    stage:aws(['apigatewayv2','get-stage','--api-id',P.apiId,'--stage-name','$default']),
    latestPolicy:aws(['lambda','get-policy','--function-name',P.functionName])},source);
  };
  const inspect=async()=>{unchanged();observeSyntheticMemberIdentity();
   const output=runCareVersionChild(()=>execFileSync(process.execPath,[resolve(operatorDir,'index.cjs'),'inspect'],
    {encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}),'preflight');
   return JSON.parse(output);
  };
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:secretArn}),{abortSignal:AbortSignal.timeout(30000)});
  check(secret.ARN===secretArn&&typeof secret.SecretString==='string'&&Buffer.byteLength(secret.SecretString)<=65536,'secret');
  rows=JSON.parse(secret.SecretString);verifyPersonaRecords(rows);
  const authRequests=new Set();
  const authenticate=async mode=>{
   const row=rows.find(r=>r.mode===mode);check(row,'persona');
   const answer=await cognito.send(new InitiateAuthCommand({ClientId:P.consumerClient,AuthFlow:'USER_PASSWORD_AUTH',
    AuthParameters:{USERNAME:row.email,PASSWORD:row.password}}),{abortSignal:AbortSignal.timeout(30000)});
   const token=answer.AuthenticationResult?.IdToken,id=answer.$metadata?.requestId;
   check(typeof token==='string'&&authId(id)&&!authRequests.has(id),'auth_response');authRequests.add(id);
   verifyPersonaClaims(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')),row);
   check(![...sessions.values()].includes(token),'auth_session_reused');
   sessions.set(id,token);return {owner:row.personId,sessionId:id};
  };
  const result=await verifyCareCancellation({source:async()=>careSourceSnapshot(root,'desktop'),uuid:randomUUID,record,inspect,control,authenticate,
   request:async(session,body)=>{
    const token=sessions.get(session.sessionId);check(typeof token==='string','session');
    const response=await fetch(`https://${P.apiId}.execute-api.${P.region}.amazonaws.com/clinical-core/consumer/care-data`,
     {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body),
      redirect:'error',signal:AbortSignal.timeout(30000)});
    return {response,value:await boundedCareJson(response)};
   },
   stored:async(owner,id)=>{
    const answer=await rds.send(new ExecuteStatementCommand({resourceArn:P.cluster,secretArn:P.secret,database:P.database,
     sql:'select scope,outcome,receipt is null as receipt_absent from clinical_core.care_data_erasure_requests where owner_id=cast(:owner as uuid) and request_id=cast(:request as uuid) limit 2',
     parameters:[{name:'owner',value:{stringValue:owner}},{name:'request',value:{stringValue:id}}]}),
     {abortSignal:AbortSignal.timeout(30000)});
    check(answer.numberOfRecordsUpdated===0&&Array.isArray(answer.records)&&answer.records.length<=2,'stored_read');
    return answer.records.map(row=>{check(row.length===3&&Object.hasOwn(row[0],'stringValue')&&Object.hasOwn(row[1],'stringValue')
      &&Object.hasOwn(row[2],'booleanValue'),'stored_shape');
     return {scope:row[0].stringValue,outcome:row[1].stringValue,receiptAbsent:row[2].booleanValue};});
   }});
  sessions.clear();unchanged();
  const file=resolve(dir,runId+'.json');
  writeFileSync(file,JSON.stringify({...result,completedAt:new Date().toISOString(),journal},null,2)+'\n',{flag:'wx'});
  await record({stage:'completed',report:file});settled=true;
  console.log(JSON.stringify({report:file,runId,verdict:result.verdict,caseCount:result.observations.length,
   originalDataPreserved:true,terminalCancellationRowsAdded:5,phiAllowed:false}));
 }catch(error){
  await record({stage:'finding',code:cancellationFailureCode(error),mutationAdmitted});
  throw error;
 }finally{
  for(const row of rows)if(row&&typeof row==='object')delete row.password;
  sessions.clear();
  s3.destroy();secrets.destroy();cognito.destroy();rds.destroy();
  // Unknown mutating outcomes retain custody. Diagnose the same run; never
  // delete this lock merely because the process no longer appears live.
  if(!mutationAdmitted||settled){const saved=JSON.parse(readFileSync(lock,'utf8'));if(saved.runId===runId)unlinkSync(lock);}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{careCancellationArgs(process.argv.slice(2));await runCareCancellation();}
 catch(error){console.error(cancellationFailureCode(error));process.exitCode=1;}
}
