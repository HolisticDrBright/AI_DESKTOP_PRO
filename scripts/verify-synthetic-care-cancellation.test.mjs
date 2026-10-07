import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyCancellationControlPlane,cancellationFailureCode} from './verify-synthetic-care-cancellation.mjs';
const source=JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8'));
function observation(){
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
test('post-parent control plane pins exact code, source template, JWT authority, IAM, encrypted logs and returned route',()=>{
 const original=observation(),before=structuredClone(original);
 const result=verifyCancellationControlPlane(original,source);
 assert.equal(result.routeCount,51);assert.equal(result.phiAllowed,false);assert.deepEqual(original,before);
 for(const mutate of [
  o=>o.foundation.Stacks[0].Outputs.find(v=>v.OutputKey==='PhiAllowed').OutputValue='true',
  o=>o.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',o=>o.stack.Stacks.push(o.stack.Stacks[0]),
  o=>o.stack.Stacks[0].Parameters.find(v=>v.ParameterKey==='LambdaCodeKey').ParameterValue='other',
  o=>o.fn.Environment.Variables.CLINICAL_DATABASE_NAME='clinical_core_qualification',
  o=>o.fn.CodeSha256=Buffer.from(P.previousZipSha256,'hex').toString('base64'),
  o=>o.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion='latest',
  o=>o.integrations.Items[0].IntegrationUri=R.retainedArn,o=>o.integrations.NextToken='hidden',
  o=>o.stage.AutoDeploy=false,o=>o.stage.DefaultRouteSettings.ThrottlingRateLimit=100,
  o=>o.routes.Items.pop(),o=>o.routes.Items[0].AuthorizationType='NONE',
  o=>o.authorizers.Items[0].JwtConfiguration.Audience.push('other'),
  o=>o.authorizers.NextToken='hidden',o=>o.routes.Items.push(o.routes.Items[0]),
  o=>delete o.inline.IsTruncated,o=>delete o.attached.IsTruncated,
  o=>o.logGroups.nextToken='hidden',
  o=>o.policies[0].PolicyDocument.Statement[0].Resource='*',
  o=>o.attached.AttachedPolicies.push({PolicyArn:'AdministratorAccess'}),
  o=>o.role.Role.AssumeRolePolicyDocument.Statement[0].Principal.Service='ec2.amazonaws.com',
  o=>o.logGroups.logGroups[0].retentionInDays=1,o=>o.logGroups.logGroups[0].kmsKeyId='other',
  o=>o.latestPolicy.Policy=JSON.stringify({Version:'2012-10-17',Statement:[]}),
 ]){const value=observation();mutate(value);assert.throws(()=>verifyCancellationControlPlane(value,source));}
});
test('only incidental role last-use and log volume metadata are excluded from the stable control digest',()=>{
 const a=observation(),b=observation();
 b.role.Role.RoleLastUsed={LastUsedDate:'fictional-later',Region:P.region};b.logGroups.logGroups[0].storedBytes=100;
 assert.deepEqual(verifyCancellationControlPlane(a,source),verifyCancellationControlPlane(b,source));
 b.fn.RevisionId='new-revision';assert.notDeepEqual(verifyCancellationControlPlane(a,source),verifyCancellationControlPlane(b,source));
});
test('actual runner binds fixed synthetic observers, exact S3 stream and bounded read-only receipt inspection',()=>{
 const script=readFileSync(new URL('./verify-synthetic-care-cancellation.mjs',import.meta.url),'utf8');
 assert.match(script,/readCareArtifact\(object.Body,manifest,signal\)/);
 assert.match(script,/observeSyntheticMemberIdentity\(\)/);
 assert.match(script,/careSourceSnapshot\(root,'desktop'\)/);
 assert.match(script,/maxAttempts:1/);
 assert.equal((script.match(/'--no-paginate'/g)??[]).length,6);
 assert.match(script,/inline.IsTruncated===false/);
 assert.match(script,/where owner_id=cast\(:owner as uuid\) and request_id=cast\(:request as uuid\) limit 2/);
 assert.match(script,/if\(!mutationAdmitted\|\|settled\)/);
 assert.doesNotMatch(script,/AdminCreateUser|AdminSetUserPassword|PutObjectCommand|update-integration|update-function|execute-change-set|UPDATE |DELETE |INSERT |process.env|\['upgrade'\]/);
 assert.equal(cancellationFailureCode(new Error('raw health text secret')),'synthetic_care_release_refused:erasure_cancellation_failed');
 assert.equal(cancellationFailureCode(new Error('synthetic_care_release_refused:erasure_cancellation_case')),
  'synthetic_care_release_refused:erasure_cancellation_case');
});
