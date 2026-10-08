import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from '../synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from '../verify-deployed-synthetic-care.mjs';
import {CARE_RECOVERY_ROUTE as R} from '../care-recovery-routing.mjs';
const source=JSON.parse(readFileSync(new URL('../../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8'));
export function careIntentDependencyFixture(){
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
