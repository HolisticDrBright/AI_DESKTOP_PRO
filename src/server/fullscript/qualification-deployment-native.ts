if(typeof window!=='undefined')throw Error('Fullscript deployment native transport is server-only.');
import {execFileSync} from 'node:child_process';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {RDSDataClient} from '@aws-sdk/client-rds-data';
import {LambdaClient,GetFunctionConfigurationCommand} from '@aws-sdk/client-lambda';
import {createFullscriptDeploymentDatabaseObserver} from './qualification-deployment-database';
import {observeFullscriptDeploymentResources,type FullscriptResourcePort} from './qualification-deployment-resources';
import {deploymentCanonical,verifyFullscriptPreparation,type DeploymentPlan,type DeploymentObservation,type DeploymentPorts} from './qualification-deployment-execution';
type Obj=Record<string,unknown>;
const profile='ai-synthetic-member',region='us-east-2',account='588966314750',bucket='alp-qualification-code-588966314750-us-east-2';
const fail=():never=>{throw Error('fullscript_deployment_native_refused');};
function check(v:unknown):asserts v{if(!v)fail();}
function object(v:unknown):Obj{check(v&&typeof v==='object'&&!Array.isArray(v));return v as Obj;}
const endpoints:Record<string,string>={sts:'sts',rds:'rds',secretsmanager:'secretsmanager',kms:'kms',dynamodb:'dynamodb',
 'cognito-idp':'cognito-idp',sns:'sns',apigatewayv2:'apigateway',cloudformation:'cloudformation',lambda:'lambda',cloudwatch:'monitoring'};
const reads=new Set(['sts/get-caller-identity','rds/describe-db-clusters','secretsmanager/describe-secret','kms/describe-key',
 'dynamodb/describe-table','cognito-idp/describe-user-pool','cognito-idp/describe-user-pool-client','cognito-idp/admin-get-user',
 'sns/get-topic-attributes','apigatewayv2/get-api','apigatewayv2/get-routes','apigatewayv2/get-authorizers','apigatewayv2/get-integrations',
 'cloudformation/list-stacks','cloudformation/describe-stacks','cloudformation/list-change-sets','cloudformation/describe-change-set',
 'cloudformation/get-template','cloudformation/list-stack-resources','lambda/get-function-concurrency','lambda/get-policy',
 'cloudwatch/describe-alarms','logs/describe-log-groups','iam/get-role','iam/list-role-policies','iam/get-role-policy','iam/list-attached-role-policies']);
function env(){const e={...process.env};
 // Explicit profile only; never let inherited root/static/web credentials win.
 for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_SECURITY_TOKEN','AWS_ROLE_ARN','AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_PROFILE','AWS_DEFAULT_PROFILE'])delete e[key];
 e.AWS_MAX_ATTEMPTS='1';e.AWS_RETRY_MODE='standard';e.AWS_CLI_AUTO_PROMPT='off';return e;
}
function awsJson(service:string,action:string,input:Obj,write=false):Obj{
 try{
  check(reads.has(service+'/'+action)||write&&service==='cloudformation'&&['create-change-set','execute-change-set'].includes(action));
  check(Buffer.byteLength(JSON.stringify(input))<=128*1024);
  const endpoint=service==='iam'?'https://iam.amazonaws.com':`https://${service==='logs'?'logs':endpoints[service]}.${region}.amazonaws.com`;
  check(service==='iam'||service==='logs'||endpoints[service]);
  const output=execFileSync('aws',[service,action,'--cli-input-json',JSON.stringify(input),'--profile',profile,'--region',region,
   '--endpoint-url',endpoint,'--no-paginate','--no-cli-pager','--no-cli-auto-prompt','--output','json','--color','off',
   '--cli-connect-timeout','3','--cli-read-timeout','5'],{encoding:'utf8',stdio:'pipe',windowsHide:true,timeout:10000,maxBuffer:2*1024*1024,env:env()});
  // ExecuteChangeSet has an empty success response. Accept that only for
  // this admitted write; an empty read is never evidence of absence.
  if(write&&service==='cloudformation'&&action==='execute-change-set'&&!output.trim())return {};
  return object(JSON.parse(output));
 }catch{return fail();}
}
/** Public transport surface is read-only. The two writes are private and used
 * only after durable admission and a fresh binding/absence observation. */
export function fullscriptNativeAwsJson(service:string,action:string,input:Obj):Obj{return awsJson(service,action,input);}
function caller(v:Obj){check(v.Account===account&&typeof v.Arn==='string'
 &&/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9_+=,.@-]+$/.test(v.Arn)&&typeof v.UserId==='string');
 return {Account:v.Account,Arn:v.Arn,UserId:v.UserId};}
async function pages(service:string,action:string,input:Obj,key:string){
 const all:unknown[]=[],seen=new Set<string>();let token:string|undefined;
 const start=Date.now();
 for(let page=0;page<100;page++){
  check(Date.now()-start<=120000);const r=fullscriptNativeAwsJson(service,action,{...input,...(token?{NextToken:token}:{})});
  check(Array.isArray(r[key]));all.push(...r[key]);check(all.length<=10000);
  if(r.NextToken===undefined||r.NextToken===null||r.NextToken==='')return {...r,[key]:all,NextToken:undefined};
  check(typeof r.NextToken==='string'&&r.NextToken.length<=4096&&!seen.has(r.NextToken));seen.add(r.NextToken);token=r.NextToken;
 }return fail();
}
/** Native read transport. No secret-value command, upload, provider operation,
 * credential export or credential file. SDKs explicitly use the same profile
 * and must agree with CLI STS on the exact current assumed-role identity. */
export function createNativeFullscriptResourcePort(plan:DeploymentPlan):FullscriptResourcePort&{functionConfiguration(arn:string):Promise<Obj|null>}{
 const sealed=structuredClone(plan),target=object(sealed.target.target),values=Object.fromEntries(sealed.parameters.map(p=>[p.ParameterKey,p.ParameterValue]));
 const credentials=fromIni({profile,ignoreCache:true,clientConfig:{region,maxAttempts:1}});
 const sts=new STSClient({region,credentials,maxAttempts:1,endpoint:`https://sts.${region}.amazonaws.com`});
 const s3=new S3Client({region,credentials,maxAttempts:1,endpoint:`https://s3.${region}.amazonaws.com`,forcePathStyle:true,followRegionRedirects:false});
 const rds=new RDSDataClient({region,credentials,maxAttempts:1,endpoint:`https://rds-data.${region}.amazonaws.com`});
 const lambda=new LambdaClient({region,credentials,maxAttempts:1,endpoint:`https://lambda.${region}.amazonaws.com`});
 const identity=async()=>{
  try{const sdk=caller(object(await sts.send(new GetCallerIdentityCommand({}),{abortSignal:AbortSignal.timeout(5000)})));
   const cli=caller(fullscriptNativeAwsJson('sts','get-caller-identity',{}));check(deploymentCanonical(sdk)===deploymentCanonical(cli));return cli;
  }catch{return fail();}
 };
 return {now:Date.now,identity,metadata:async(service,action,input)=>{
  try{if(service==='apigatewayv2'&&action==='get-routes')return await pages(service,action,input,'Items');
   return fullscriptNativeAwsJson(service,action,input);
  }catch{return fail();}
 },database:createFullscriptDeploymentDatabaseObserver({send:async command=>{
  try{return object(await rds.send(command as Parameters<typeof rds.send>[0],{abortSignal:AbortSignal.timeout(5000)}));}catch{return fail();}
 }}),object:async(key,version,maximum)=>{
  let body:unknown;const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000);
  try{
   check((key===values.CodeKey&&version===values.CodeObjectVersion&&maximum===16*1024*1024)
    ||(key===values.TargetKey&&version===values.TargetObjectVersion&&maximum===65536));
   const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key,VersionId:version,ExpectedBucketOwner:account}),{abortSignal:abort.signal});
   body=r.Body;check(Number.isSafeInteger(r.ContentLength)&&r.ContentLength!>0&&r.ContentLength!<=maximum&&r.VersionId===version&&r.DeleteMarker!==true);
   check(body&&typeof(body as {[Symbol.asyncIterator]?:unknown})[Symbol.asyncIterator]==='function');
   let size=0;const chunks:Buffer[]=[];
   for await(const chunk of body as AsyncIterable<Uint8Array>){check(!abort.signal.aborted&&chunk instanceof Uint8Array);
    size+=chunk.byteLength;check(size<=maximum&&size<=r.ContentLength!);chunks.push(Buffer.from(chunk));}
   check(!abort.signal.aborted&&size===r.ContentLength);return {bytes:Buffer.concat(chunks,size),metadata:{VersionId:r.VersionId,ContentLength:r.ContentLength,
    ServerSideEncryption:r.ServerSideEncryption,ContentType:r.ContentType,...(r.ContentEncoding?{ContentEncoding:r.ContentEncoding}:{}),
    ...(r.ContentRange?{ContentRange:r.ContentRange}:{}),...(r.DeleteMarker!==undefined?{DeleteMarker:r.DeleteMarker}:{})}};
  }catch{abort.abort();return fail();}finally{clearTimeout(timer);try{(body as {destroy?:()=>void}|undefined)?.destroy?.();}catch{fail();}}
 },functionConfiguration:async arn=>{
  try{check(arn===target.functionArn||new RegExp('^'+String(target.functionArn)+':[1-9][0-9]*$').test(arn));
   return object(await lambda.send(new GetFunctionConfigurationCommand({FunctionName:arn}),{abortSignal:AbortSignal.timeout(5000)}));
  }catch(e){const error=object(e);if(error.name==='ResourceNotFoundException'&&object(error.$metadata).httpStatusCode===404)return null;return fail();}
 }};
}
/** Native control plane for the one exact reviewed plan. The command must
 * supply real local-source/review guards and durable custody; it cannot use
 * saved prerequisite reports or fictional ports. No update/delete/rollback. */
export function createNativeFullscriptDeploymentPorts(plan:DeploymentPlan,custody:DeploymentPorts['custody'],localGuard:()=>Promise<void>):DeploymentPorts{
 const sealed=structuredClone(plan),binding=deploymentCanonical(sealed),resources=createNativeFullscriptResourcePort(sealed);
 let created=false,executed=false;
 const valid=(p:DeploymentPlan)=>check(deploymentCanonical(p)===binding);
 const onceWrite=async(p:DeploymentPlan,stage:'create_admitted'|'execute_admitted')=>{valid(p);await custody.verify();
  check(custody.stages().at(-1)===stage);await localGuard();await observeFullscriptDeploymentResources(p,resources);
  await localGuard();await resources.identity();await custody.verify();};
 const port:DeploymentPorts={now:Date.now,custody,guard:async p=>{valid(p);await localGuard();await resources.identity();await observeFullscriptDeploymentResources(p,resources);await custody.verify();},
  create:async p=>{
   try{await onceWrite(p,'create_admitted');check(!created);
    const absent=await port.observe(p);check(absent.stack===null&&absent.proposal===null&&absent.function===null&&absent.resources.length===0
     &&!absent.routes.some(r=>r.RouteKey==='POST /clinical-core/consumer/fullscript/draft'||r.RouteKey==='POST /clinical-core/workforce/fullscript/draft'));
    await onceWrite(p,'create_admitted');created=true;
    const result=awsJson('cloudformation','create-change-set',{StackName:p.review.stackName,ChangeSetName:p.changeSetName,ChangeSetType:'CREATE',
     TemplateBody:p.templateBody,Parameters:p.parameters,Capabilities:['CAPABILITY_IAM'],Tags:[{Key:'FullscriptDeploymentReview',Value:p.reviewSha256}],ClientToken:p.clientToken},true);
    check(typeof result.StackId==='string'&&result.StackId.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${p.review.stackName}/`)
     &&typeof result.Id==='string'&&result.Id.startsWith(`arn:aws:cloudformation:${region}:${account}:changeSet/${p.changeSetName}/`));
   }catch{return fail();}
  },execute:async(p,stackId,changeSetId)=>{
   try{await onceWrite(p,'execute_admitted');check(!executed&&stackId.startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${p.review.stackName}/`)
    &&changeSetId.startsWith(`arn:aws:cloudformation:${region}:${account}:changeSet/${p.changeSetName}/`));
    const prepared=verifyFullscriptPreparation(p,await port.observe(p),Date.now());
    check(prepared.stackId===stackId&&prepared.changeSetId===changeSetId);await onceWrite(p,'execute_admitted');executed=true;
    awsJson('cloudformation','execute-change-set',{StackName:stackId,ChangeSetName:changeSetId,ClientRequestToken:p.clientToken+'-execute',DisableRollback:true},true);
   }catch{return fail();}
  },observe:async p=>{
   try{
    valid(p);await custody.verify();await localGuard();await resources.identity();
    const start=Date.now();
    for(let pass=0;pass<90;pass++){
     check(Date.now()-start<=180000);await custody.verify();
     const stacks=await pages('cloudformation','list-stacks',{},'StackSummaries');
     const matches=(stacks.StackSummaries as Obj[]).filter(s=>s.StackName===p.review.stackName);check(matches.length<=1);
     const routes=(await pages('apigatewayv2','get-routes',{ApiId:p.target.target.apiId},'Items')).Items as Obj[];
     if(matches.length===0)return {stack:null,proposal:null,template:null,resources:[],function:await resources.functionConfiguration(String(p.target.target.functionArn)),routes,authorizers:[],integrations:[]};
     const described=fullscriptNativeAwsJson('cloudformation','describe-stacks',{StackName:matches[0].StackId});
     check(described.NextToken===undefined&&Array.isArray(described.Stacks)&&described.Stacks.length===1);const stack=object(described.Stacks[0]);
     check(stack.StackName===p.review.stackName&&stack.StackId===matches[0].StackId);
     const changes=await pages('cloudformation','list-change-sets',{StackName:stack.StackId},'Summaries');
     const proposals=(changes.Summaries as Obj[]).filter(s=>s.ChangeSetName===p.changeSetName);check(proposals.length===1);
     const proposal=fullscriptNativeAwsJson('cloudformation','describe-change-set',{StackName:stack.StackId,ChangeSetName:proposals[0].ChangeSetId});
     check(proposal.NextToken===undefined);
     if(proposal.Status==='CREATE_PENDING'||proposal.Status==='CREATE_IN_PROGRESS'||['CREATE_IN_PROGRESS'].includes(String(stack.StackStatus))){
      await new Promise(r=>setTimeout(r,2000));continue;
     }
     const raw=fullscriptNativeAwsJson('cloudformation','get-template',{StackName:stack.StackId,ChangeSetName:proposal.ChangeSetId,TemplateStage:'Original'});
     const template=typeof raw.TemplateBody==='string'?JSON.parse(raw.TemplateBody):raw.TemplateBody;
     const stackResources=(await pages('cloudformation','list-stack-resources',{StackName:stack.StackId},'StackResourceSummaries')).StackResourceSummaries as Obj[];
     const version=stackResources.find(r=>r.LogicalResourceId==='Version')?.PhysicalResourceId;
     const fn=await resources.functionConfiguration(String(version??p.target.target.functionArn));
     const authorizers=(await pages('apigatewayv2','get-authorizers',{ApiId:p.target.target.apiId},'Items')).Items as Obj[];
     const integrations=(await pages('apigatewayv2','get-integrations',{ApiId:p.target.target.apiId},'Items')).Items as Obj[];
     return {stack,proposal,template,resources:stackResources,function:fn,routes,authorizers,integrations} as DeploymentObservation;
    }return fail();
   }catch{return fail();}
  }};return port;
}
