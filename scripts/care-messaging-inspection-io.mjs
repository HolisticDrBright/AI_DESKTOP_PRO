import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,statSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CareObservationError,CARE_OBSERVER} from './care-messaging-qualification-observer.mjs';
import {SYNTHETIC_MEMBER_PROFILE} from './synthetic-aws-principal.mjs';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {RDSDataClient,BeginTransactionCommand,ExecuteStatementCommand,RollbackTransactionCommand} from '@aws-sdk/client-rds-data';
import {assertQualificationConsentLedger,QUALIFICATION_CONSENT_LEDGER} from './qualification-consent-ledger.mjs';

// No mutation operation or arbitrary CLI arguments can pass this adapter.
const operations={
 'sts/get-caller-identity':[],
 'cloudformation/describe-stacks':['StackName'],
 'cloudformation/get-template':['StackName','TemplateStage'],
 'cloudformation/list-stack-resources':['StackName'],
 'apigatewayv2/get-api':['ApiId'],
 'apigatewayv2/get-routes':['ApiId'],
 'apigatewayv2/get-authorizer':['ApiId','AuthorizerId'],
 'apigatewayv2/get-integration':['ApiId','IntegrationId'],
 'apigatewayv2/get-stages':['ApiId'],
 'lambda/get-function-configuration':['FunctionName'],
 'lambda/get-function-concurrency':['FunctionName'],
 'lambda/get-policy':['FunctionName'],
 'logs/describe-log-groups':['LogGroupNamePrefix'],
 'iam/get-role':['RoleName'],
 'iam/list-attached-role-policies':['RoleName'],
 'iam/list-role-policies':['RoleName'],
 'iam/get-role-policy':['RoleName','PolicyName'],
 'cloudwatch/describe-alarms':['AlarmNames'],
 's3api/head-object':['Bucket','Key','VersionId','ExpectedBucketOwner'],
 's3api/get-object':['Bucket','Key','VersionId','ExpectedBucketOwner'],
};
const flag=key=>'--'+key.replace(/[A-Z]/g,(v,i)=>(i?'-':'')+v.toLowerCase());
export function inspectionArguments(service,operation,parameters,outputFile){
 const expected=operations[service+'/'+operation];
 if(!expected||Object.keys(parameters).sort().join(',')!==[...expected].sort().join(','))throw new CareObservationError('read_operation_refused');
 if((operation==='get-object')!==Boolean(outputFile))throw new CareObservationError('read_operation_refused');
 const args=[service,operation];
 for(const name of expected){
  const values=Array.isArray(parameters[name])?parameters[name]:[parameters[name]];
  if(!values.length||values.some(value=>typeof value!=='string'||!value.length||value.startsWith('-')||/[\x00-\x1f]/.test(value)))throw new CareObservationError('read_operation_refused');
  args.push(flag(name),...values);
 }
 if(outputFile)args.push(outputFile);
 return [...args,'--profile',SYNTHETIC_MEMBER_PROFILE,'--region',CARE_OBSERVER.region,'--output','json','--no-cli-pager'];
}
export function inspectionAwsReader(execute=execFileSync){
 return async(service,operation,parameters,outputFile)=>{
  const args=inspectionArguments(service,operation,parameters,outputFile);
  try{return JSON.parse(execute('aws',args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}));}
  catch(error){
   // Only AWS's exact DescribeStacks missing-stack response means absence.
   const missing=`An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${CARE_OBSERVER.stack} does not exist`;
   const stderr=String(error?.stderr??'').trim();
   if(service==='cloudformation'&&operation==='describe-stacks'&&parameters.StackName===CARE_OBSERVER.stack
    &&[missing,'aws: [ERROR]: '+missing].includes(stderr))
    throw new CareObservationError('stack_missing');
   throw new CareObservationError('aws_read_failed');
  }
 };
}
export function inspectionCodeReader(readAws){
 return async(parameters,expectedBytes)=>{
  if(!Number.isInteger(expectedBytes)||expectedBytes<1||expectedBytes>16*1024*1024+1024)throw new CareObservationError('uploaded_code_refused');
  const metadata=await readAws('s3api','head-object',parameters);
  if(metadata?.ContentLength!==expectedBytes||metadata.VersionId!==parameters.VersionId)throw new CareObservationError('uploaded_code_refused');
  const directory=mkdtempSync(join(tmpdir(),'alp-care-inspection-')),file=join(directory,'deployment.zip');
  try{
   const result=await readAws('s3api','get-object',parameters,file);
   if(result?.ContentLength!==expectedBytes||result.VersionId!==parameters.VersionId||statSync(file).size!==expectedBytes)throw new CareObservationError('uploaded_code_refused');
   return readFileSync(file);
  }finally{
   // Only the one explicitly created file and its now-empty directory.
   try{unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw new CareObservationError('temporary_cleanup_failed');}
   try{rmdirSync(directory);}catch{throw new CareObservationError('temporary_cleanup_failed');}
  }
 };
}
export function inspectionLedgerReader(expected,makeClient=()=>new RDSDataClient({region:CARE_OBSERVER.region,
 credentials:fromIni({profile:SYNTHETIC_MEMBER_PROFILE}),maxAttempts:1})){
 return async foundation=>{
  if(foundation?.DatabaseName!==CARE_OBSERVER.database
   ||!/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(foundation.DatabaseClusterArn??'')
   ||!/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(foundation.DatabaseSecretArn??''))throw new CareObservationError('foundation_refused');
  const client=makeClient(),base={resourceArn:foundation.DatabaseClusterArn,secretArn:foundation.DatabaseSecretArn,database:CARE_OBSERVER.database};
  const send=command=>client.send(command,{abortSignal:AbortSignal.timeout(30000)});
  const field=(row,index)=>row?.[index]?.stringValue;
  let transactionId,verified=false,rolledBack=false;
  try{
   transactionId=(await send(new BeginTransactionCommand(base))).transactionId;
   if(!transactionId)throw new CareObservationError('ledger_refused');
   const query=sql=>send(new ExecuteStatementCommand({...base,transactionId,sql}));
   await query('set transaction isolation level repeatable read read only');
   const database=await query('select current_database()');
   const ledger=await query('select version,sha256 from clinical_core.schema_migrations order by version');
   assertQualificationConsentLedger(field(database.records?.[0],0),(ledger.records??[]).map(row=>({version:field(row,0),sha256:field(row,1)})),expected);
   verified=true;
  }catch(error){throw new CareObservationError(error?.name==='DatabaseResumingException'?'database_resuming':'ledger_refused');}
  finally{
   try{if(transactionId){await send(new RollbackTransactionCommand({...base,transactionId}));rolledBack=true;}}
   catch{throw new CareObservationError('rollback_unverified');}finally{client.destroy();}
  }
  if(!verified||!rolledBack)throw new CareObservationError('ledger_refused');
  return {database:CARE_OBSERVER.database,release:QUALIFICATION_CONSENT_LEDGER,rows:expected.length,rolledBack:true};
 };
}
