import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from '../synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from '../verify-deployed-synthetic-care.mjs';
import {CARE_RECOVERY_ROUTE as R} from '../care-recovery-routing.mjs';
export const careControlSource=JSON.parse(readFileSync(new URL('../../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8'));
const source=careControlSource;
export function careControlObservation(){
 const template=structuredClone(source);for(const name of P.absentRoutes)delete template.Resources[name];
 template.Outputs.RoutesEnabled.Value='51';template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=D.version;
 const params={ClinicalApiId:P.apiId,DatabaseName:P.database,DatabaseClusterArn:P.cluster,DatabaseSecretArn:'****',
  ConsumerUserPoolId:P.consumerPool,ConsumerUserPoolClientId:P.consumerClient,WorkforceUserPoolId:P.workforcePool,
  WorkforceUserPoolClientId:P.workforceClient,ClinicalCoreKeyArn:P.keyArn,LambdaCodeBucket:P.bucket,
  LambdaCodeKey:`clinical-core/authenticated-api/care-release/${D.desktop}/${D.zip}.zip`};
 const outputs={PhiAllowed:'false',Environment:'synthetic-staging',DataClassification:'synthetic_only',DatabaseName:P.database,
  ClinicalApiId:P.apiId,DatabaseClusterArn:P.cluster,DatabaseSecretArn:P.secret};
 const roleName='fictional-role',roleArn=`arn:aws:iam::${P.account}:role/${roleName}`,logName='/ai-clinical-core/synthetic-staging/identity-api';
 const policy=(PolicyName,Statement)=>({RoleName:roleName,PolicyName,PolicyDocument:{Version:'2012-10-17',Statement}});
 return {foundation:{Stacks:[{StackStatus:'UPDATE_COMPLETE',StackId:`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.foundation}/fictional`,
   Outputs:Object.entries(outputs).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]},
  stack:{Stacks:[{StackStatus:'UPDATE_COMPLETE',StackId:`arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`,
   Parameters:Object.entries(params).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue}))}]},template,
  fn:{FunctionName:P.functionName,FunctionArn:R.latestArn,Version:'$LATEST',CodeSha256:Buffer.from(D.zip,'hex').toString('base64'),
   CodeSize:D.bytes,RevisionId:'fictional-revision',State:'Active',LastUpdateStatus:'Successful',Runtime:'nodejs22.x',Handler:'index.handler',
   MemorySize:256,Timeout:29,Architectures:['arm64'],Role:roleArn,PackageType:'Zip',EphemeralStorage:{Size:512},
   TracingConfig:{Mode:'PassThrough'},LoggingConfig:{LogGroup:logName,LogFormat:'JSON',ApplicationLogLevel:'WARN',SystemLogLevel:'WARN'},
   Environment:{Variables:{CLINICAL_DATABASE_CLUSTER_ARN:P.cluster,CLINICAL_DATABASE_SECRET_ARN:P.secret,CLINICAL_DATABASE_NAME:P.database,
    CLINICAL_CONSUMER_ISSUER:`https://cognito-idp.${P.region}.amazonaws.com/${P.consumerPool}`,CLINICAL_CONSUMER_AUDIENCE:P.consumerClient,
    CLINICAL_WORKFORCE_ISSUER:`https://cognito-idp.${P.region}.amazonaws.com/${P.workforcePool}`,CLINICAL_WORKFORCE_AUDIENCE:P.workforceClient}}},
  authorizers:{Items:[[P.consumerPool,P.consumerClient,'consumer'],[P.workforcePool,P.workforceClient,'workforce']].map(([pool,client,name])=>({
   AuthorizerId:name,AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],
   JwtConfiguration:{Issuer:`https://cognito-idp.${P.region}.amazonaws.com/${pool}`,Audience:[client]}}))},
  routes:{Items:Object.values(template.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route').map(r=>({
   RouteKey:r.Properties.RouteKey,AuthorizationType:'JWT',Target:`integrations/${R.integrationId}`,
   AuthorizerId:r.Properties.AuthorizerId.Ref==='ConsumerJwtAuthorizer'?'consumer':'workforce'}))},
  integrations:{Items:[{IntegrationId:R.integrationId,IntegrationUri:R.latestArn,IntegrationType:'AWS_PROXY',IntegrationMethod:'POST',
   ConnectionType:'INTERNET',PayloadFormatVersion:'2.0',TimeoutInMillis:30000}]},
  stage:{StageName:'$default',AutoDeploy:true,DeploymentId:'testdeployed',
   LastDeploymentStatusMessage:"Successfully deployed stage with deployment ID 'testdeployed'",
   DefaultRouteSettings:{DetailedMetricsEnabled:true,ThrottlingBurstLimit:20,ThrottlingRateLimit:10},
   AccessLogSettings:{DestinationArn:`arn:aws:logs:${P.region}:${P.account}:log-group:/ai-clinical-core/synthetic-staging/api-access`,
    Format:'{"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength"}'}},
  latestPolicy:{RevisionId:'test-policy-revision',Policy:JSON.stringify({Version:'2012-10-17',Statement:[{
   Sid:P.stack+'-IdentityApiInvokePermission-test',Effect:'Allow',Principal:{Service:'apigateway.amazonaws.com'},Action:'lambda:InvokeFunction',
   Resource:R.latestArn,Condition:{ArnLike:{'AWS:SourceArn':R.sourceArn}}}]})},
  resources:{StackResources:[{LogicalResourceId:'IdentityApiRole',PhysicalResourceId:roleName,ResourceType:'AWS::IAM::Role',ResourceStatus:'CREATE_COMPLETE'},
   {LogicalResourceId:'IdentityApiLogGroup',PhysicalResourceId:logName,ResourceType:'AWS::Logs::LogGroup',ResourceStatus:'CREATE_COMPLETE'}]},
  role:{Role:{RoleName:roleName,Arn:roleArn,AssumeRolePolicyDocument:structuredClone(source.Resources.IdentityApiRole.Properties.AssumeRolePolicyDocument)}},
  attached:{IsTruncated:false,AttachedPolicies:[]},inline:{IsTruncated:false,PolicyNames:['AuroraDataApiTransactionOnly','ManagedDatabaseCredentialRead','BoundedFunctionLogging']},
  policies:[policy('AuroraDataApiTransactionOnly',[{Effect:'Allow',Action:['rds-data:BeginTransaction','rds-data:ExecuteStatement','rds-data:CommitTransaction','rds-data:RollbackTransaction'],Resource:P.cluster}]),
   policy('ManagedDatabaseCredentialRead',[{Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:P.secret},
    {Effect:'Allow',Action:'kms:Decrypt',Resource:P.keyArn,Condition:{StringEquals:{'kms:ViaService':`secretsmanager.${P.region}.amazonaws.com`}}}]),
   policy('BoundedFunctionLogging',[{Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],Resource:`arn:aws:logs:${P.region}:${P.account}:log-group:${logName}:*`}])],
  logGroups:{logGroups:[{logGroupName:logName,retentionInDays:30,kmsKeyId:P.keyArn}]}};
}
