import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CARE_OBSERVER as c,CareObservationError,assertCareArtifact,inspectCareMessagingQualification} from './care-messaging-qualification-observer.mjs';
import {inspectionArguments,inspectionAwsReader,inspectionCodeReader,inspectionLedgerReader} from './care-messaging-inspection-io.mjs';
import {qualificationConsentArtifact} from './qualification-consent-ledger.mjs';
import {crc32,careMessagingZip} from './care-messaging-zip.mjs';

// All transports below are fictional. No AWS credentials or provider requests.
const dir=mkdtempSync(join(tmpdir(),'alp-care-observer-test-'));
let artifact;
try{
 execFileSync(process.execPath,['scripts/build-aws-care-messaging.mjs','--out-dir='+dir],{timeout:30000,windowsHide:true});
 artifact={manifest:JSON.parse(readFileSync(join(dir,'artifact-manifest.json'),'utf8')),code:readFileSync(join(dir,'index.js')),
  templateBytes:readFileSync(join(dir,'template.json')),zip:readFileSync(join(dir,'deployment.zip'))};
 // The unit fixture deliberately models a clean build, independent of local edits.
 artifact.manifest.sourceClean=true;
}finally{for(const name of readdirSync(dir))unlinkSync(join(dir,name));rmdirSync(dir);}
const hash='a'.repeat(64),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pairs=(object,key,value)=>Object.entries(object).map(([k,v])=>({[key]:k,[value]:v}));
const arn=`arn:aws:lambda:${c.region}:${c.account}:function:abcdefghij-care-messaging`;
const foundation={PhiAllowed:'false',Activation:'blocked',QualificationExecution:'disabled',QualificationInfrastructure:'prepared_no_candidates',
 DatabaseName:c.database,DatabaseClusterArn:`arn:aws:rds:${c.region}:${c.account}:cluster:fictional`,
 DatabaseSecretArn:`arn:aws:secretsmanager:${c.region}:${c.account}:secret:fictional`,ApiId:'abcdefghij',ApiOrigin:'https://abcdefghij.execute-api.us-east-2.amazonaws.com'};
const binding={contract:'care-messaging-qualification-binding/1',sourceCommit:artifact.manifest.sourceCommit,
 migrationReleaseSha256:artifact.manifest.migrationReleaseSha256,apiId:foundation.ApiId,organizationId:uuid(1),
 consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_fictionalC',consumerAudience:'c'.repeat(26),
 workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_fictionalW',workforceAudience:'w'.repeat(26),
 codeBucket:'fictional-qualification-code',codeKey:'fictional/deployment.zip',codeVersion:'fictional-version',
 secretKmsKeyArn:`arn:aws:kms:${c.region}:${c.account}:key/${uuid(2)}`,logsKmsKeyArn:`arn:aws:kms:${c.region}:${c.account}:key/${uuid(3)}`,
 alarmTopicArn:`arn:aws:sns:${c.region}:${c.account}:fictional-alarms`,subjects:[uuid(4),uuid(5),uuid(6)],
 reviews:{database:hash,workforceMfa:hash,messaging:hash,retention:hash,qualification:hash}};
const params={ApiId:binding.apiId,ConsumerIssuer:binding.consumerIssuer,ConsumerAudience:binding.consumerAudience,WorkforceIssuer:binding.workforceIssuer,
 WorkforceAudience:binding.workforceAudience,OrganizationId:binding.organizationId,PhiAllowed:'false',Activation:'blocked',ActivationEvidenceSha256:'',
 DatabaseReviewSha256:hash,WorkforceMfaReviewSha256:hash,MessagingReviewSha256:hash,RetentionReviewSha256:hash,
 DatabaseClusterArn:foundation.DatabaseClusterArn,DatabaseSecretArn:foundation.DatabaseSecretArn,DatabaseName:c.database,
 SecretKmsKeyArn:binding.secretKmsKeyArn,LogsKmsKeyArn:binding.logsKmsKeyArn,AlarmTopicArn:binding.alarmTopicArn,
 CodeBucket:binding.codeBucket,CodeKey:binding.codeKey,CodeVersion:binding.codeVersion,SourceCommit:binding.sourceCommit,
 MigrationReleaseSha256:binding.migrationReleaseSha256,QualificationExecution:'enabled',QualificationAccountId:c.account,
 QualificationDatabaseName:c.database,QualificationReviewSha256:hash,QualificationIdentitySubjects:binding.subjects.join(',')};
const template=JSON.parse(artifact.templateBytes.toString());
const physical=Object.fromEntries(Object.keys(template.Resources).map(key=>[key,'fictional-'+key]));
physical.Function='abcdefghij-care-messaging';physical.Logs='/aws/lambda/'+physical.Function;
const logArn=`arn:aws:logs:${c.region}:${c.account}:log-group:${physical.Logs}:*`;
function resolve(value){
 if(Array.isArray(value))return value.map(resolve);if(!value||typeof value!=='object')return value;
 if(value.Ref)return ({...params,...physical,'AWS::Region':c.region,'AWS::AccountId':c.account,'AWS::Partition':'aws'})[value.Ref];
 if(value['Fn::GetAtt'])return {'Logs.Arn':logArn,'Function.Arn':arn}[value['Fn::GetAtt'].join('.')];
 if(value['Fn::Sub'])return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g,(_,key)=>resolve({Ref:key}));
 if(value['Fn::If'])return resolve(value['Fn::If'][1]);
 return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,resolve(v)]));
}
const roleArn=`arn:aws:iam::${c.account}:role/${physical.Role}`;
function fixture(){
 const responses={
  'sts/get-caller-identity':{Account:c.account,Arn:`arn:aws:sts::${c.account}:assumed-role/fictional/session`,UserId:'fictional'},
  'cloudformation/describe-stacks/foundation':{Stacks:[{StackStatus:'CREATE_COMPLETE',StackId:`arn:aws:cloudformation:${c.region}:${c.account}:stack/${c.foundation}/fictional`,Outputs:pairs(foundation,'OutputKey','OutputValue')}]},
  'cloudformation/describe-stacks/candidate':{Stacks:[{StackStatus:'CREATE_COMPLETE',StackId:`arn:aws:cloudformation:${c.region}:${c.account}:stack/${c.stack}/fictional`,Parameters:pairs(params,'ParameterKey','ParameterValue'),
   Outputs:pairs({PhiAllowed:'false',Activation:'blocked',SourceCommit:binding.sourceCommit,MigrationReleaseSha256:binding.migrationReleaseSha256,DatabaseName:c.database,
    QualificationExecution:'enabled',FunctionName:physical.Function},'OutputKey','OutputValue')}]},
  'cloudformation/get-template':{TemplateBody:template},
  'cloudformation/list-stack-resources':{StackResourceSummaries:Object.entries(template.Resources).map(([key,resource])=>({LogicalResourceId:key,PhysicalResourceId:physical[key],ResourceType:resource.Type,ResourceStatus:'CREATE_COMPLETE'}))},
  'apigatewayv2/get-api':{ApiId:binding.apiId,ApiEndpoint:foundation.ApiOrigin,ProtocolType:'HTTP'},
  'lambda/get-function-configuration':{FunctionArn:arn,FunctionName:physical.Function,State:'Active',LastUpdateStatus:'Successful',Runtime:'nodejs22.x',Handler:'index.handler',Timeout:29,
   MemorySize:256,PackageType:'Zip',CodeSize:artifact.zip.length,CodeSha256:Buffer.from(artifact.manifest.deploymentZipSha256,'hex').toString('base64'),RevisionId:'fictional',Role:roleArn,
   LoggingConfig:{LogGroup:physical.Logs},Environment:{Variables:resolve(template.Resources.Function.Properties.Environment.Variables)}},
  'lambda/get-function-concurrency':{ReservedConcurrentExecutions:2},
  'logs/describe-log-groups':{logGroups:[{logGroupName:physical.Logs,arn:logArn,kmsKeyId:binding.logsKmsKeyArn,retentionInDays:30}]},
  'iam/get-role':{Role:{Arn:roleArn,RoleName:physical.Role,AssumeRolePolicyDocument:template.Resources.Role.Properties.AssumeRolePolicyDocument}},
  'iam/list-attached-role-policies':{AttachedPolicies:[],IsTruncated:false},
  'iam/list-role-policies':{PolicyNames:['bounded-logs','reviewed-care-messaging'],IsTruncated:false},
  'apigatewayv2/get-routes':{Items:['ConsumerMessages','WorkforceMessages','ConsumerExport'].map(key=>({RouteKey:template.Resources['Route'+key].Properties.RouteKey,RouteId:physical['Route'+key],
   AuthorizationType:'JWT',AuthorizerId:physical[(key==='WorkforceMessages'?'Workforce':'Consumer')+'Authorizer'],Target:'integrations/'+physical.Integration}))},
  'apigatewayv2/get-integration':{IntegrationId:physical.Integration,IntegrationUri:arn,IntegrationType:'AWS_PROXY',PayloadFormatVersion:'2.0',TimeoutInMillis:30000},
  'apigatewayv2/get-stages':{Items:[{StageName:'$default',AutoDeploy:true,DeploymentId:'fictional'}]},
  'lambda/get-policy':{Policy:JSON.stringify({Version:'2012-10-17',Statement:['ConsumerMessages','WorkforceMessages','ConsumerExport'].map(key=>{
   const p=resolve(template.Resources['Invoke'+key].Properties);return {Sid:'fictional-'+key,Effect:'Allow',Principal:{Service:p.Principal},Action:p.Action,Resource:arn,
    Condition:{StringEquals:{'AWS:SourceAccount':p.SourceAccount},ArnLike:{'AWS:SourceArn':p.SourceArn}}};})})},
  'cloudwatch/describe-alarms':{MetricAlarms:['Errors','ApiServerErrors'].map(key=>({...resolve(template.Resources[key].Properties),AlarmName:physical[key]}))},
 };
 for(const pool of ['Consumer','Workforce'])responses['apigatewayv2/get-authorizer/'+physical[pool+'Authorizer']]={AuthorizerId:physical[pool+'Authorizer'],AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],
  JwtConfiguration:{Issuer:params[pool+'Issuer'],Audience:[params[pool+'Audience']]}};
 for(const p of resolve(template.Resources.Role.Properties.Policies))responses['iam/get-role-policy/'+p.PolicyName]={PolicyName:p.PolicyName,PolicyDocument:p.PolicyDocument};
 const calls=[],counts=new Map();
 const readAws=async(service,operation,parameters)=>{
  let key=service+'/'+operation;
  if(operation==='describe-stacks')key+='/'+(parameters.StackName===c.foundation?'foundation':'candidate');
  if(operation==='get-authorizer')key+='/'+parameters.AuthorizerId;
  if(operation==='get-role-policy')key+='/'+parameters.PolicyName;
  calls.push(key);counts.set(key,(counts.get(key)??0)+1);
  if(!Object.hasOwn(responses,key))throw new Error('Unexpected observation '+key);
  if(responses[key] instanceof Error)throw responses[key];
  return structuredClone(responses[key]);
 };
 return {responses,calls,counts,options:{artifact,head:artifact.manifest.sourceCommit,binding:structuredClone(binding),readAws,
  readCodeVersion:async()=>artifact.zip,inspectLedger:async()=>({database:c.database,release:binding.migrationReleaseSha256,rows:106,rolledBack:true})}};
}
test('ZIP is deterministic with correct CRC and a single exact stored UTF-8 entry',()=>{
 assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
 const code=Buffer.from('exports.handler=async()=>"fictional";'),zip=careMessagingZip(code);
 assert.deepEqual(zip,careMessagingZip(code));assert.equal(zip.readUInt32LE(0),0x04034b50);
 assert.equal(zip.readUInt16LE(8),0);assert.equal(zip.readUInt32LE(14),crc32(code));
 assert.equal(zip.subarray(30,38).toString(),'index.js');assert.deepEqual(zip.subarray(38,38+code.length),code);
 const end=zip.length-22,central=zip.readUInt32LE(end+16);
 assert.equal(zip.readUInt32LE(central),0x02014b50);assert.equal(zip.readUInt16LE(end+10),1);
 assert.equal(zip.readUInt32LE(central+16),crc32(code));assert.equal(zip.readUInt32LE(central+42),0);
 assert.throws(()=>careMessagingZip(Buffer.alloc(0)));assert.throws(()=>careMessagingZip(Buffer.alloc(16*1024*1024+1)));
});
test('exact fictional deployment verifies bindings but never acceptance or human approval',async()=>{
 const f=fixture(),result=await inspectCareMessagingQualification(f.options);
 assert.equal(result.status,'deployment_bindings_verified');assert.equal(result.acceptance,false);assert.equal(result.humanReviewsVerified,false);assert.equal(result.phiAllowed,false);
 for(const count of f.counts.values())assert.equal(count,2);
});
test('missing stack requires repeated actual absence; denied access is not absence',async()=>{
 const f=fixture();f.responses['cloudformation/describe-stacks/candidate']=new CareObservationError('stack_missing');delete f.options.binding;
 assert.equal((await inspectCareMessagingQualification(f.options)).status,'not_deployed');
 f.responses['cloudformation/describe-stacks/candidate']=new CareObservationError('aws_read_failed');
 await assert.rejects(()=>inspectCareMessagingQualification(f.options),/aws_read_failed/);
});
test('a candidate appearing during missing-stack inspection is not certified absent',async()=>{
 const f=fixture(),read=f.options.readAws;f.options.readAws=async(...args)=>{
  if(args[1]==='describe-stacks'&&args[2].StackName===c.stack&&!f.calls.includes('missing-once')){
   f.calls.push('missing-once');throw new CareObservationError('stack_missing');
  }return read(...args);
 };delete f.options.binding;
 await assert.rejects(()=>inspectCareMessagingQualification(f.options),/observation_changed/);
});
test('artifact rejects changed ZIP, JS, template, dirty source and mismatched ZIP metadata before AWS',()=>{
 for(const mutate of [a=>{a.zip=Buffer.from('wrong');},a=>{a.code=Buffer.from('wrong');},a=>{a.templateBytes=Buffer.from('{}');},
  a=>{a.manifest.sourceClean=false;},a=>{a.manifest.deploymentZipBytes++;}]){
  const a={...artifact,manifest:structuredClone(artifact.manifest)};mutate(a);
  assert.throws(()=>assertCareArtifact(a,artifact.manifest.sourceCommit),/artifact_refused/);
 }
});
const negatives=[
 ['root principal','principal_refused',f=>{f.responses['sts/get-caller-identity'].Arn=`arn:aws:iam::${c.account}:root`;}],
 ['production account','principal_refused',f=>{f.responses['sts/get-caller-identity'].Account='173535830222';}],
 ['staging database','foundation_refused',f=>{f.responses['cloudformation/describe-stacks/foundation'].Stacks[0].Outputs.find(o=>o.OutputKey==='DatabaseName').OutputValue='clinical_core';}],
 ['unsigned reviews','review_binding_refused',f=>{f.options.binding.reviews.messaging='0'.repeat(64);}],
 ['null code version','binding_refused',f=>{f.options.binding.codeVersion='null';}],
 ['wrong source','artifact_refused',f=>{f.options.head='b'.repeat(40);}],
 ['wrong ledger','ledger_refused',f=>{f.options.inspectLedger=async()=>({database:c.database,release:'b'.repeat(64),rows:106,rolledBack:true});}],
 ['unfinished candidate','stack_refused',f=>{f.responses['cloudformation/describe-stacks/candidate'].Stacks[0].StackStatus='UPDATE_IN_PROGRESS';}],
 ['extra stack parameter','parameters_refused',f=>{f.responses['cloudformation/describe-stacks/candidate'].Stacks[0].Parameters.push({ParameterKey:'Extra',ParameterValue:'x'});}],
 ['template change','template_refused',f=>{f.responses['cloudformation/get-template']={TemplateBody:{}};}],
 ['code mismatch','function_refused',f=>{f.responses['lambda/get-function-configuration'].CodeSha256='other';}],
 ['extra environment key','environment_refused',f=>{f.responses['lambda/get-function-configuration'].Environment.Variables.EXTRA='unsafe';}],
 ['wrong concurrency','concurrency_refused',f=>{f.responses['lambda/get-function-concurrency'].ReservedConcurrentExecutions=0;}],
 ['S3 mismatch','uploaded_code_refused',f=>{f.options.readCodeVersion=async()=>Buffer.from('wrong');}],
 ['managed policy attached','iam_refused',f=>{f.responses['iam/list-attached-role-policies'].AttachedPolicies=[{PolicyArn:'unsafe'}];}],
 ['broader inline policy','iam_refused',f=>{f.responses['iam/get-role-policy/reviewed-care-messaging'].PolicyDocument.Statement[0].Resource='*';}],
 ['route without JWT','routes_refused',f=>{f.responses['apigatewayv2/get-routes'].Items[0].AuthorizationType='NONE';}],
 ['wrong JWT audience','authorizer_refused',f=>{f.responses['apigatewayv2/get-authorizer/'+physical.ConsumerAuthorizer].JwtConfiguration.Audience=['wrong'];}],
 ['wrong integration','integration_refused',f=>{f.responses['apigatewayv2/get-integration'].IntegrationUri='wrong';}],
 ['wildcard invoke','invoke_refused',f=>{const p=JSON.parse(f.responses['lambda/get-policy'].Policy);p.Statement[0].Condition.ArnLike['AWS:SourceArn']='*';f.responses['lambda/get-policy'].Policy=JSON.stringify(p);}],
 ['undeployed default stage','stage_refused',f=>{delete f.responses['apigatewayv2/get-stages'].Items[0].DeploymentId;}],
 ['alarm disabled','alarms_refused',f=>{f.responses['cloudwatch/describe-alarms'].MetricAlarms[0].ActionsEnabled=false;}],
];
for(const [name,category,mutate] of negatives)test('refuses '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(()=>inspectCareMessagingQualification(f.options),new RegExp(category));});
for(const key of ['lambda/get-function-concurrency','iam/list-attached-role-policies','apigatewayv2/get-authorizer/'+physical.ConsumerAuthorizer,
 'apigatewayv2/get-integration','lambda/get-policy','cloudwatch/describe-alarms'])test('repeats mutable observation '+key,async()=>{
 const f=fixture(),read=f.options.readAws;f.options.readAws=async(...args)=>{const result=await read(...args);if(f.calls.at(-1)===key&&f.counts.get(key)===2)result.changed=true;return result;};
 await assert.rejects(()=>inspectCareMessagingQualification(f.options),/observation_changed/);
});
test('CLI adapter is read-only, explicitly profile-pinned, and recognizes only exact absence',async()=>{
 assert.throws(()=>inspectionArguments('lambda','update-function-code',{}),/read_operation_refused/);
 assert.throws(()=>inspectionArguments('sts','get-caller-identity',{Profile:'root'}),/read_operation_refused/);
 const args=inspectionArguments('cloudformation','describe-stacks',{StackName:c.stack});assert.ok(args.includes('ai-synthetic-member'));assert.ok(args.includes('us-east-2'));
 const read=inspectionAwsReader(()=>{throw {stderr:`An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${c.stack} does not exist\n`};});
 await assert.rejects(()=>read('cloudformation','describe-stacks',{StackName:c.stack}),/stack_missing/);
 const formatted=inspectionAwsReader((_program,_args,options)=>{
  assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
  throw {stderr:`\naws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${c.stack} does not exist\n`};
 });
 await assert.rejects(()=>formatted('cloudformation','describe-stacks',{StackName:c.stack}),/stack_missing/);
 await assert.rejects(()=>inspectionAwsReader(()=>{throw {stderr:'AccessDenied'};})('cloudformation','describe-stacks',{StackName:c.stack}),/aws_read_failed/);
});
test('S3 reader refuses mismatched version or size before downloading',async()=>{
 for(const metadata of [{ContentLength:artifact.zip.length,VersionId:'wrong'},{ContentLength:0,VersionId:binding.codeVersion}]){
  let count=0;const read=inspectionCodeReader(async()=>{count++;return metadata;});
  await assert.rejects(()=>read({Bucket:binding.codeBucket,Key:binding.codeKey,VersionId:binding.codeVersion,ExpectedBucketOwner:c.account},artifact.zip.length),/uploaded_code_refused/);assert.equal(count,1);
 }
});
test('S3 reader retrieves exact version bytes and removes only its explicit temporary file',async()=>{
 let written;const calls=[];
 const read=inspectionCodeReader(async(service,operation,parameters,file)=>{
  assert.equal(service,'s3api');assert.equal(parameters.VersionId,binding.codeVersion);assert.equal(parameters.ExpectedBucketOwner,c.account);calls.push(operation);
  if(file){written=file;writeFileSync(file,artifact.zip);}
  return {ContentLength:artifact.zip.length,VersionId:binding.codeVersion};
 });
 assert.deepEqual(await read({Bucket:binding.codeBucket,Key:binding.codeKey,VersionId:binding.codeVersion,ExpectedBucketOwner:c.account},artifact.zip.length),artifact.zip);
 assert.deepEqual(calls,['head-object','get-object']);assert.equal(existsSync(written),false);
});
test('second whole-ledger inspection and immutable package comparison must still agree',async()=>{
 for(const callback of ['inspectLedger','readCodeVersion']){
  const f=fixture(),original=f.options[callback];let count=0;
  f.options[callback]=async(...args)=>{const result=await original(...args);if(++count===2)return callback==='inspectLedger'?{...result,rows:103}:Buffer.from('changed');return result;};
  await assert.rejects(()=>inspectCareMessagingQualification(f.options),/observation_changed/);
 }
});
test('inspection entrypoint has rollback-only whole-ledger queries and no write command',()=>{
 const text=readFileSync(new URL('./inspect-care-messaging-qualification.mjs',import.meta.url),'utf8')+
  readFileSync(new URL('./care-messaging-inspection-io.mjs',import.meta.url),'utf8');
 assert.match(text,/set transaction isolation level repeatable read read only/);assert.match(text,/assertQualificationConsentLedger/);
 assert.match(text,/new RollbackTransactionCommand/);assert.doesNotMatch(text,/CommitTransactionCommand|INSERT INTO|UPDATE clinical|PhiAllowed=true/);
 assert.match(text,/dirty_source_refused/);assert.match(text,/rebuilt_artifact_mismatch/);
});
const expectedLedger=qualificationConsentArtifact(JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
 {encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,windowsHide:true})));
for(const [scenario,category] of [['good',null],['wrong database','ledger_refused'],['changed digest','ledger_refused'],
 ['no transaction','ledger_refused'],['resuming','database_resuming'],['query denied','ledger_refused'],['rollback denied','rollback_unverified']])
 test('read-only ledger adapter: '+scenario,async()=>{
  const commands=[];let destroyed=false;
  const inspect=inspectionLedgerReader(expectedLedger,()=>({destroy(){destroyed=true;},async send(command,options){
   const type=command.constructor.name;commands.push(command);assert.ok(options.abortSignal instanceof AbortSignal);
   assert.equal(command.input.database,c.database);assert.equal(command.input.resourceArn,foundation.DatabaseClusterArn);
   if(type==='BeginTransactionCommand'){
    if(scenario==='resuming'){const error=new Error('private provider detail');error.name='DatabaseResumingException';throw error;}
    return scenario==='no transaction'?{}:{transactionId:'fictional-transaction'};
   }
   assert.equal(command.input.transactionId,'fictional-transaction');
   if(type==='RollbackTransactionCommand'){if(scenario==='rollback denied')throw new Error('private error');return {};}
   assert.equal(type,'ExecuteStatementCommand');const sql=command.input.sql;
   if(sql.startsWith('set transaction')){if(scenario==='query denied')throw new Error('private error');return {};}
   if(sql==='select current_database()')return {records:[[{stringValue:scenario==='wrong database'?'clinical_core':c.database}]]};
   assert.equal(sql,'select version,sha256 from clinical_core.schema_migrations order by version');
   return {records:expectedLedger.map((row,index)=>[{stringValue:row.version},{stringValue:scenario==='changed digest'&&index===1?'wrong':row.sha256}])};
  }}));
  if(category)await assert.rejects(()=>inspect(foundation),new RegExp(category));else assert.equal((await inspect(foundation)).rolledBack,true);
  assert.equal(destroyed,true);assert.ok(commands.every(command=>command.constructor.name!=='CommitTransactionCommand'));
  assert.equal(commands.filter(command=>command.constructor.name==='BeginTransactionCommand').length,1);
  if(!['resuming','no transaction'].includes(scenario))assert.equal(commands.at(-1).constructor.name,'RollbackTransactionCommand');
 });
test('ledger adapter refuses foreign resource or staging database before constructing a client',async()=>{
 const inspect=inspectionLedgerReader(expectedLedger,()=>{throw new Error('must not construct');});
 for(const altered of [{...foundation,DatabaseName:'clinical_core'},{...foundation,DatabaseClusterArn:foundation.DatabaseClusterArn.replace(c.account,'173535830222')}])
  await assert.rejects(()=>inspect(altered),/foundation_refused/);
});
