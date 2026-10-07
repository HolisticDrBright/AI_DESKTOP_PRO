import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CARE_CONNECTION_OBSERVER as c,CareObservationError,assertCareConnectionsArtifact,inspectCareConnectionsQualification} from './care-messaging-qualification-observer.mjs';
import {inspectionAwsReader} from './care-messaging-inspection-io.mjs';

// Actual emitted artifacts; all live observations below are fictional. The
// sourceClean override models a clean fixture, never a reviewed deployment.
const directory=mkdtempSync(join(tmpdir(),'alp-connection-observer-'));
let artifact;
try{
 execFileSync(process.execPath,['scripts/build-aws-care-connections.mjs','--out-dir='+directory],{timeout:30000,windowsHide:true});
 artifact={manifest:JSON.parse(readFileSync(join(directory,'artifact-manifest.json'),'utf8')),code:readFileSync(join(directory,'index.js')),
  templateBytes:readFileSync(join(directory,'template.json')),zip:readFileSync(join(directory,'deployment.zip'))};
 artifact.manifest.sourceClean=true;
}finally{for(const name of readdirSync(directory))unlinkSync(join(directory,name));rmdirSync(directory);}
const hash='a'.repeat(64),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pairs=(o,key,value)=>Object.entries(o).map(([k,v])=>({[key]:k,[value]:v}));
function fixture(recovery=true){
 const template=JSON.parse(artifact.templateBytes.toString('utf8'));
 const f={PhiAllowed:'false',Activation:'blocked',QualificationExecution:'disabled',QualificationInfrastructure:'prepared_no_candidates',
  DatabaseName:c.database,DatabaseClusterArn:`arn:aws:rds:${c.region}:${c.account}:cluster:fictional`,DatabaseSecretArn:`arn:aws:secretsmanager:${c.region}:${c.account}:secret:fictional`,
  ApiId:'abcdefghij',ApiOrigin:'https://abcdefghij.execute-api.us-east-2.amazonaws.com'};
 const binding={contract:'care-connections-qualification-binding/1',sourceCommit:artifact.manifest.sourceCommit,migrationReleaseSha256:artifact.manifest.migrationReleaseSha256,
  apiId:f.ApiId,organizationId:uuid(1),consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalC',consumerAudience:'c'.repeat(26),
  workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalW',workforceAudience:'w'.repeat(26),codeBucket:'fictional-code-bucket',codeKey:'fictional/deployment.zip',codeVersion:'fictional-version',
  secretKmsKeyArn:`arn:aws:kms:${c.region}:${c.account}:key/${uuid(2)}`,logsKmsKeyArn:`arn:aws:kms:${c.region}:${c.account}:key/${uuid(3)}`,alarmTopicArn:`arn:aws:sns:${c.region}:${c.account}:fictional-alarms`,
  subjects:[uuid(4),uuid(5),uuid(6)],reviews:{database:hash,workforceMfa:hash,connection:hash,consent:hash,retention:hash,qualification:hash,...(recovery?{claimRecovery:hash}:{})},
  claimRecoveryEnabled:recovery,enabledConsentScopes:[]};
 const p={...Object.fromEntries(Object.entries(template.Parameters).map(([k,v])=>[k,v.Default??''])),ApiId:f.ApiId,OrganizationId:binding.organizationId,
  ConsumerIssuer:binding.consumerIssuer,ConsumerAudience:binding.consumerAudience,WorkforceIssuer:binding.workforceIssuer,WorkforceAudience:binding.workforceAudience,
  PhiAllowed:'false',Activation:'blocked',ActivationEvidenceSha256:'',DatabaseReviewSha256:hash,WorkforceMfaReviewSha256:hash,ConnectionReviewSha256:hash,ConsentReviewSha256:hash,RetentionReviewSha256:hash,
  ClaimRecoveryEnabled:String(recovery),ClaimRecoveryReviewSha256:recovery?hash:'',EnabledConsentScopes:'',DatabaseClusterArn:f.DatabaseClusterArn,DatabaseSecretArn:f.DatabaseSecretArn,DatabaseName:c.database,
  SecretKmsKeyArn:binding.secretKmsKeyArn,LogsKmsKeyArn:binding.logsKmsKeyArn,AlarmTopicArn:binding.alarmTopicArn,CodeBucket:binding.codeBucket,CodeKey:binding.codeKey,CodeVersion:binding.codeVersion,
  SourceCommit:binding.sourceCommit,MigrationReleaseSha256:binding.migrationReleaseSha256,QualificationExecution:'enabled',QualificationAccountId:c.account,QualificationDatabaseName:c.database,
  QualificationReviewSha256:hash,QualificationIdentitySubjects:binding.subjects.join(',')};
 const physical=Object.fromEntries(Object.keys(template.Resources).map(k=>[k,'fictional-'+k]));physical.Function=f.ApiId+'-care-connections';physical.Logs='/aws/lambda/'+physical.Function;
 const arn=`arn:aws:lambda:${c.region}:${c.account}:function:${physical.Function}`,logArn=`arn:aws:logs:${c.region}:${c.account}:log-group:${physical.Logs}:*`,roleArn=`arn:aws:iam::${c.account}:role/${physical.Role}`;
 const resolve=v=>{
  if(Array.isArray(v))return v.map(resolve);if(!v||typeof v!=='object')return v;
  if(v.Ref)return {...p,...physical,'AWS::AccountId':c.account,'AWS::Region':c.region,'AWS::Partition':'aws'}[v.Ref];
  if(v['Fn::GetAtt'])return {'Logs.Arn':logArn,'Function.Arn':arn}[v['Fn::GetAtt'].join('.')];
  if(v['Fn::Sub'])return v['Fn::Sub'].replace(/\$\{([^}]+)\}/g,(_,k)=>resolve({Ref:k}));
  if(v['Fn::If'])return resolve(v['Fn::If'][1]);
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]));
 };
 const routeNames=['ConsumerConnection','WorkforceConnection','ConsumerClaimRecovery'];
 const responses={
  'sts/get-caller-identity':{Account:c.account,Arn:`arn:aws:sts::${c.account}:assumed-role/Fictional/session`},
  'cloudformation/describe-stacks/foundation':{Stacks:[{StackId:`arn:aws:cloudformation:${c.region}:${c.account}:stack/${c.foundation}/fictional`,StackStatus:'CREATE_COMPLETE',Outputs:pairs(f,'OutputKey','OutputValue')}]},
  'cloudformation/describe-stacks/candidate':{Stacks:[{StackId:`arn:aws:cloudformation:${c.region}:${c.account}:stack/${c.stack}/fictional`,StackStatus:'CREATE_COMPLETE',Parameters:pairs(p,'ParameterKey','ParameterValue'),
   Outputs:pairs({PhiAllowed:'false',Activation:'blocked',SourceCommit:binding.sourceCommit,MigrationReleaseSha256:binding.migrationReleaseSha256,DatabaseName:c.database,QualificationExecution:'enabled',FunctionName:physical.Function,ClaimRecoveryEnabled:String(recovery)},'OutputKey','OutputValue')}]},
  'cloudformation/get-template':{TemplateBody:template},
  'cloudformation/list-stack-resources':{StackResourceSummaries:Object.entries(template.Resources).map(([k,r])=>({LogicalResourceId:k,PhysicalResourceId:physical[k],ResourceType:r.Type,ResourceStatus:'CREATE_COMPLETE'}))},
  'apigatewayv2/get-api':{ApiId:f.ApiId,ApiEndpoint:f.ApiOrigin,ProtocolType:'HTTP'},
  'lambda/get-function-configuration':{FunctionArn:arn,FunctionName:physical.Function,State:'Active',LastUpdateStatus:'Successful',Runtime:'nodejs22.x',Handler:'index.handler',Timeout:29,MemorySize:256,
   PackageType:'Zip',CodeSize:artifact.zip.length,CodeSha256:Buffer.from(artifact.manifest.deploymentZipSha256,'hex').toString('base64'),RevisionId:'fictional',Role:roleArn,LoggingConfig:{LogGroup:physical.Logs},Environment:{Variables:resolve(template.Resources.Function.Properties.Environment.Variables)}},
  'lambda/get-function-concurrency':{ReservedConcurrentExecutions:2},
  'logs/describe-log-groups':{logGroups:[{logGroupName:physical.Logs,arn:logArn,kmsKeyId:binding.logsKmsKeyArn,retentionInDays:30}]},
  'iam/get-role':{Role:{Arn:roleArn,RoleName:physical.Role,AssumeRolePolicyDocument:template.Resources.Role.Properties.AssumeRolePolicyDocument}},
  'iam/list-attached-role-policies':{AttachedPolicies:[],IsTruncated:false},'iam/list-role-policies':{PolicyNames:['bounded-logs','reviewed-care-connections'],IsTruncated:false},
  'apigatewayv2/get-routes':{Items:routeNames.map(k=>({RouteKey:template.Resources['Route'+k].Properties.RouteKey,RouteId:physical['Route'+k],AuthorizationType:'JWT',
   AuthorizerId:physical[(k.startsWith('Workforce')?'Workforce':'Consumer')+'Authorizer'],Target:'integrations/'+physical.Integration}))},
  'apigatewayv2/get-integration':{IntegrationId:physical.Integration,IntegrationUri:arn,IntegrationType:'AWS_PROXY',PayloadFormatVersion:'2.0',TimeoutInMillis:30000},
  'apigatewayv2/get-stages':{Items:[{StageName:'$default',AutoDeploy:true,DeploymentId:'fictional'}]},
  'lambda/get-policy':{Policy:JSON.stringify({Version:'2012-10-17',Statement:routeNames.map(k=>{const invoke=resolve(template.Resources['Invoke'+k].Properties);return {Effect:'Allow',Action:invoke.Action,Resource:arn,Principal:{Service:invoke.Principal},
   Condition:{StringEquals:{'AWS:SourceAccount':invoke.SourceAccount},ArnLike:{'AWS:SourceArn':invoke.SourceArn}}};})})},
  'cloudwatch/describe-alarms':{MetricAlarms:['Errors','ApiServerErrors'].map(k=>({...resolve(template.Resources[k].Properties),AlarmName:physical[k]}))},
 };
 for(const pool of ['Consumer','Workforce'])responses['apigatewayv2/get-authorizer/'+physical[pool+'Authorizer']]={AuthorizerId:physical[pool+'Authorizer'],AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],JwtConfiguration:{Issuer:p[pool+'Issuer'],Audience:[p[pool+'Audience']]}};
 for(const policy of resolve(template.Resources.Role.Properties.Policies))responses['iam/get-role-policy/'+policy.PolicyName]={PolicyDocument:policy.PolicyDocument};
 const calls=[];
 const readAws=async(service,operation,parameters)=>{
  let key=service+'/'+operation;if(operation==='describe-stacks')key+='/'+(parameters.StackName===c.foundation?'foundation':'candidate');
  if(operation==='get-authorizer')key+='/'+parameters.AuthorizerId;if(operation==='get-role-policy')key+='/'+parameters.PolicyName;calls.push(key);
  if(!Object.hasOwn(responses,key))throw new Error('unexpected observation');if(responses[key] instanceof Error)throw responses[key];return structuredClone(responses[key]);
 };
 return {responses,calls,options:{artifact,head:artifact.manifest.sourceCommit,binding,readAws,readCodeVersion:async()=>artifact.zip,
  inspectLedger:async()=>({database:c.database,release:binding.migrationReleaseSha256,rows:106,rolledBack:true})}};
}
for(const enabled of [false,true])test('connection bindings, recovery '+enabled+', never certify approvals or API acceptance',async()=>{
 const f=fixture(enabled),report=await inspectCareConnectionsQualification(f.options);
 assert.equal(report.status,'deployment_bindings_verified');assert.equal(report.acceptance,false);assert.equal(report.humanReviewsVerified,false);assert.equal(report.phiAllowed,false);
 assert.equal(f.calls.filter(k=>k==='lambda/get-function-configuration').length,2);
});
const cases=[
 ['missing recovery review','review_binding_refused',f=>{delete f.options.binding.reviews.claimRecovery;}],
 ['wrong recovery flag type','binding_refused',f=>{f.options.binding.claimRecoveryEnabled='true';}],
 ['implicit scope grant','binding_refused',f=>{f.options.binding.enabledConsentScopes=['invented'];}],
 ['duplicate scopes','binding_refused',f=>{f.options.binding.enabledConsentScopes=['messaging','messaging'];}],
 ['substituted review','parameters_refused',f=>{f.responses['cloudformation/describe-stacks/candidate'].Stacks[0].Parameters.find(p=>p.ParameterKey==='ClaimRecoveryReviewSha256').ParameterValue='b'.repeat(64);}],
 ['wrong recovery output','outputs_refused',f=>{f.responses['cloudformation/describe-stacks/candidate'].Stacks[0].Outputs.find(p=>p.OutputKey==='ClaimRecoveryEnabled').OutputValue='false';}],
 ['recovery environment drift','environment_refused',f=>{f.responses['lambda/get-function-configuration'].Environment.Variables.CARE_CLAIM_RECOVERY_ENABLED='false';}],
 ['missing recovery route','routes_refused',f=>{f.responses['apigatewayv2/get-routes'].Items.pop();}],
 ['workforce recovery authorizer','routes_refused',f=>{f.responses['apigatewayv2/get-routes'].Items[2].AuthorizerId='fictional-WorkforceAuthorizer';}],
 ['unsigned recovery route','routes_refused',f=>{f.responses['apigatewayv2/get-routes'].Items[2].AuthorizationType='NONE';}],
 ['wildcard invoke','invoke_refused',f=>{const p=JSON.parse(f.responses['lambda/get-policy'].Policy);p.Statement[2].Condition.ArnLike['AWS:SourceArn']='*';f.responses['lambda/get-policy'].Policy=JSON.stringify(p);}],
 ['changed runtime code','function_refused',f=>{f.responses['lambda/get-function-configuration'].CodeSha256='other';}],
 ['older database','ledger_refused',f=>{f.options.inspectLedger=async()=>({database:c.database,release:'b'.repeat(64),rows:105,rolledBack:true});}],
 ['root operator','principal_refused',f=>{f.responses['sts/get-caller-identity'].Arn=`arn:aws:iam::${c.account}:root`;}],
 ['broader data access','iam_refused',f=>{f.responses['iam/get-role-policy/reviewed-care-connections'].PolicyDocument.Statement[0].Resource='*';}],
];
for(const [name,category,mutate] of cases)test('refuses '+name,async()=>{const f=fixture();mutate(f);await assert.rejects(()=>inspectCareConnectionsQualification(f.options),new RegExp(category));});
test('connection absence needs exact repeated AWS absence, not permission denial',async()=>{
 const f=fixture();delete f.options.binding;f.responses['cloudformation/describe-stacks/candidate']=new CareObservationError('stack_missing');
 assert.equal((await inspectCareConnectionsQualification(f.options)).status,'not_deployed');
 const read=inspectionAwsReader(()=>{throw {stderr:`An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${c.stack} does not exist`};},'care-connections');
 await assert.rejects(()=>read('cloudformation','describe-stacks',{StackName:c.stack}),/stack_missing/);
 await assert.rejects(()=>read('cloudformation','describe-stacks',{StackName:'not-the-reviewed-stack'}),/aws_read_failed/);
});
test('recovery pins and defaults are required in the rebuilt artifact before any AWS observation',()=>{
 for(const mutate of [a=>{a.manifest.claimFunctions=[];},a=>{a.manifest.defaults.claimRecoveryEnabled=true;},a=>{a.manifest.sourceClean=false;}]){
  const a={...artifact,manifest:structuredClone(artifact.manifest)};mutate(a);assert.throws(()=>assertCareConnectionsArtifact(a,artifact.manifest.sourceCommit),/artifact_refused/);
 }
});
test('concurrent recovery configuration drift refuses inspection',async()=>{
 const f=fixture(),read=f.options.readAws;let count=0;
 f.options.readAws=async(...args)=>{const result=await read(...args);if(args[1]==='get-function-configuration'&&++count===2)result.Environment.Variables.CARE_CLAIM_RECOVERY_REVIEW_SHA256='changed';return result;};
 await assert.rejects(()=>inspectCareConnectionsQualification(f.options),/observation_changed/);
});
