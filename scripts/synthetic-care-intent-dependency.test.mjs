import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyCareIntentDependencyViews,verifyCareIntentChangeSetViews} from './prepare-synthetic-care-intent-code-change.mjs';
const source=JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8'));
function fixture(){
 const template=structuredClone(source);for(const name of P.absentRoutes)delete template.Resources[name];
 template.Outputs.RoutesEnabled.Value='51';template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 const newKey=`clinical-core/authenticated-api/care-intent-release/${'a'.repeat(40)}/${'b'.repeat(64)}.zip`;
 const input={template:structuredClone(template),parameters:Object.keys(template.Parameters).map(ParameterKey=>ParameterKey==='LambdaCodeKey'
  ?{ParameterKey,ParameterValue:newKey}:{ParameterKey,UsePreviousValue:true})};
 input.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion='fictional-version';
 const variables={CLINICAL_DATABASE_CLUSTER_ARN:P.cluster,CLINICAL_DATABASE_SECRET_ARN:P.secret,CLINICAL_DATABASE_NAME:P.database,
  CLINICAL_WORKFORCE_ISSUER:`https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`,
  CLINICAL_WORKFORCE_AUDIENCE:P.workforceClient,CLINICAL_CONSUMER_ISSUER:`https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`,
  CLINICAL_CONSUMER_AUDIENCE:P.consumerClient};
 const fn={FunctionName:P.functionName,FunctionArn:R.latestArn,CodeSha256:Buffer.from(D.zip,'hex').toString('base64'),
  RevisionId:'fictional-revision',State:'Active',LastUpdateStatus:'Successful',Runtime:'nodejs22.x',Architectures:['arm64'],
  Handler:'index.handler',Role:`arn:aws:iam::${P.account}:role/fictional-fixed-role`,MemorySize:256,Timeout:29,
  LoggingConfig:{LogGroup:'/ai-clinical-core/synthetic-staging/identity-api',LogFormat:'JSON',ApplicationLogLevel:'WARN',SystemLogLevel:'WARN'},
  Environment:{Variables:variables}};
 const integration={IntegrationId:R.integrationId,IntegrationUri:R.latestArn,IntegrationType:'AWS_PROXY',IntegrationMethod:'POST',
  ConnectionType:'INTERNET',PayloadFormatVersion:'2.0',TimeoutInMillis:30000};
 const resources={StackResources:[{LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',ResourceStatus:'UPDATE_COMPLETE'},
 {LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,ResourceType:'AWS::ApiGatewayV2::Integration',ResourceStatus:'CREATE_COMPLETE'}]};
 const live={template,fn,integration,resources};
 const binding={stackId:`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`,name:'care-intent-fictional',
  id:`arn:aws:cloudformation:${P.region}:${P.account}:changeSet/care-intent-fictional/fictional`};
 const params={ClinicalApiId:P.apiId,DatabaseName:P.database,DatabaseClusterArn:P.cluster,DatabaseSecretArn:'****',
  ConsumerUserPoolId:P.consumerPool,ConsumerUserPoolClientId:P.consumerClient,WorkforceUserPoolId:P.workforcePool,
  WorkforceUserPoolClientId:P.workforceClient,ClinicalCoreKeyArn:P.keyArn,LambdaCodeBucket:P.bucket,LambdaCodeKey:newKey};
 const lambda={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiFunction',PhysicalResourceId:P.functionName,
  ResourceType:'AWS::Lambda::Function',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'DirectModification'},
  {Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never'},Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'}]}};
 const dependency={Type:'Resource',ResourceChange:{Action:'Modify',LogicalResourceId:'IdentityApiIntegration',PhysicalResourceId:R.integrationId,
  ResourceType:'AWS::ApiGatewayV2::Integration',Replacement:'False',Scope:['Properties'],Details:[{
   Target:{Attribute:'Properties',Name:'IntegrationUri',RequiresRecreation:'Never'},Evaluation:'Dynamic',ChangeSource:'ResourceAttribute',CausingEntity:'IdentityApiFunction.Arn'}]}};
 const summary={StackId:binding.stackId,StackName:P.stack,ChangeSetName:binding.name,ChangeSetId:binding.id,
  Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',Capabilities:['CAPABILITY_IAM'],
  NotificationARNs:[],RollbackConfiguration:{},DeploymentConfig:{Mode:'STANDARD',DisableRollback:false},
  Parameters:Object.entries(params).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),Changes:[lambda,dependency]};
 const detailed=structuredClone(summary);detailed.Changes=[structuredClone(lambda)];
 const before={Properties:{FunctionName:fn.FunctionName,Runtime:fn.Runtime,Architectures:fn.Architectures,Handler:fn.Handler,Role:fn.Role,
  MemorySize:String(fn.MemorySize),Timeout:String(fn.Timeout),LoggingConfig:fn.LoggingConfig,Environment:structuredClone(fn.Environment),
  Code:{S3Bucket:P.bucket,S3Key:`clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`,S3ObjectVersion:D.version}}};
 before.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='****';
 const after=structuredClone(before);after.Properties.Code.S3Key=newKey;after.Properties.Code.S3ObjectVersion='fictional-version';
 detailed.Changes[0].ResourceChange.BeforeContext=JSON.stringify(before);detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(after);
 detailed.Changes[0].ResourceChange.Details=['S3ObjectVersion','S3Key'].map(name=>({Evaluation:'Static',ChangeSource:'DirectModification',
  Target:{Attribute:'Properties',Name:'Code',RequiresRecreation:'Never',Path:'/Properties/Code/'+name,
   BeforeValue:before.Properties.Code[name],AfterValue:after.Properties.Code[name],AttributeChangeType:'Modify'}}));
 return {summary,detailed,input,binding,live,before,after};
}
const verify=f=>verifyCareIntentDependencyViews(f.summary,f.detailed,f.input.template,f.input,f.binding,f.live);
test('separate dependency profile names both raw resources and never claims execution, no-op or recovery',()=>{
 const f=fixture(),report=verify(f);
 assert.equal(report.summaryResourceCount,2);assert.equal(report.propertyValuesResourceCount,1);
 assert.deepEqual(report.affectedResources,['IdentityApiFunction','IdentityApiIntegration']);
 for(const key of ['integrationNoOpProven','executionAdmissible','deployed','phiAllowed'])assert.equal(report[key],false);
 assert.equal(report.postExecutionReadbackRequired,true);assert.equal(report.freshCompatibleRecoveryRequired,true);
 // The original strict profile MUST still refuse this very same proposal.
 assert.throws(()=>verifyCareIntentChangeSetViews(f.summary,f.detailed,f.input.template,f.input,f.binding),/proposal_projection_scope/);
});
test('no unknown resource or dynamic dependency can be filtered into the two-resource profile',()=>{
 for(const mutation of [
  f=>f.summary.Changes.push(structuredClone(f.summary.Changes[1])),f=>f.summary.Changes.shift(),
  f=>f.summary.Changes.reverse(),f=>f.detailed.Changes.push(structuredClone(f.summary.Changes[1])),
  f=>f.summary.Changes[1].Type='Hook',f=>f.summary.Changes[1].ResourceChange.Action='Add',
  f=>f.summary.Changes[1].ResourceChange.LogicalResourceId='IdentityApiRole',
  f=>f.summary.Changes[1].ResourceChange.PhysicalResourceId='other',
  f=>f.summary.Changes[1].ResourceChange.ResourceType='AWS::IAM::Role',
  f=>f.summary.Changes[1].ResourceChange.Replacement='True',f=>f.summary.Changes[1].ResourceChange.Scope.push('Metadata'),
  f=>f.summary.Changes[1].ResourceChange.Details.push(structuredClone(f.summary.Changes[1].ResourceChange.Details[0])),
  f=>f.summary.Changes[1].ResourceChange.Details[0].Evaluation='Static',
  f=>f.summary.Changes[1].ResourceChange.Details[0].ChangeSource='DirectModification',
  f=>f.summary.Changes[1].ResourceChange.Details[0].CausingEntity='IdentityApiRole.Arn',
  f=>f.summary.Changes[1].ResourceChange.Details[0].Target.RequiresRecreation='Conditionally',
  f=>f.summary.Changes[1].ResourceChange.Details[0].Target.Name='CredentialsArn',
  f=>f.summary.Changes[1].ResourceChange.Details[0].Target.Path='/Properties/IntegrationUri',
  f=>f.summary.Changes[1].ResourceChange.ModuleInfo={},f=>f.summary.Changes[1].HookInvocationCount=1,
  f=>f.summary.NextToken='unread',f=>f.detailed.NextToken='unread',
  f=>{f.summary.ExecutionStatus='EXECUTE_COMPLETE';f.detailed.ExecutionStatus='EXECUTE_COMPLETE';},
  f=>{f.summary.DeploymentConfig.DisableRollback=true;f.detailed.DeploymentConfig.DisableRollback=true;},
  f=>{f.summary.NotificationARNs=['other'];f.detailed.NotificationARNs=['other'];},
  f=>{f.summary.RollbackConfiguration={MonitoringTimeInMinutes:10};f.detailed.RollbackConfiguration=f.summary.RollbackConfiguration;},
  f=>{f.summary.Tags=[{Key:'other',Value:'value'}];f.detailed.Tags=f.summary.Tags;},
  f=>f.detailed.ChangeSetId+='other',f=>f.detailed.Parameters[0].ParameterValue='other'
 ]){const f=fixture();mutation(f);assert.throws(()=>verify(f));}
});
test('actual unchanged stack template, Lambda and integration bindings are mandatory',()=>{
 for(const mutation of [
  f=>f.live.template.Resources.IdentityApiFunction.Properties.Timeout=30,
  f=>{f.live.template.Resources.IdentityApiIntegration.Properties.TimeoutInMillis=29000;f.input.template.Resources.IdentityApiIntegration.Properties.TimeoutInMillis=29000;},
  f=>f.input.template.Resources.IdentityApiIntegration.Properties.IntegrationUri=R.retainedArn,
  f=>f.input.template.Resources.IdentityApiFunction.Properties.FunctionName=P.functionName,
  f=>f.live.fn.FunctionArn=R.retainedArn,f=>f.live.fn.FunctionName='other',f=>f.live.fn.RevisionId='',
  f=>f.live.fn.CodeSha256='other',f=>f.live.fn.State='Pending',f=>f.live.fn.LastUpdateStatus='InProgress',
  f=>f.live.integration.IntegrationUri=R.retainedArn,f=>f.live.integration.IntegrationId='other',
  f=>f.live.integration.CredentialsArn='other',f=>f.live.integration.TimeoutInMillis=29000,
  f=>f.live.integration.RequestParameters={'overwrite:header.X-Test':'value'},
  f=>f.live.resources.NextToken='unread',f=>f.live.resources.StackResources[0].PhysicalResourceId='other',
  f=>f.live.resources.StackResources[1].ResourceStatus='UPDATE_IN_PROGRESS',
  f=>f.live.resources.StackResources.push(structuredClone(f.live.resources.StackResources[1])),
  f=>f.live.resources.StackResources.pop(),f=>f.live.fn.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN='other',
  f=>f.live.fn.Role='other',f=>f.live.fn.Timeout=30,f=>f.live.fn.Environment.Variables.PHI_ALLOWED='true',
  f=>{f.after.Properties.Role='other';f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(f.after);},
  f=>f.detailed.Changes[0].ResourceChange.AfterContext=undefined,
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='other'
 ]){const f=fixture();mutation(f);assert.throws(()=>verify(f));}
});
test('separate command performs fresh live qualification twice and cannot execute or accept report/env authority',()=>{
 const command=readFileSync(new URL('./prepare-synthetic-care-intent-dependency-change.mjs',import.meta.url),'utf8');
 const operator=readFileSync(new URL('./prepare-synthetic-care-intent-code-change.mjs',import.meta.url),'utf8');
 assert.match(command,/runCareIntentUpload/);assert.match(command,/--prepare-fictional-intent-dependency-change-only/);
 assert.match(operator,/const live=dependencyProfile\?observeDependency\(\)/);
 assert.match(operator,/const returned=observeDependency\(\)/);assert.match(operator,/dependency_live_drift/);
 assert.match(operator,/live.fn.RevisionId!==preparation.control.revision/);
 assert.match(operator,/summary,set,proposedTemplate,input,\{stackId,name,id\},live/);
 assert.doesNotMatch(command+operator,/'execute-change-set'|'update-stack'|'update-integration'|'update-function-code'|--target|--report|process\.env/);
});
