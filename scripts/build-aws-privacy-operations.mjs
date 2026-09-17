import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
const out='dist/aws-clinical-core/privacy-operations';mkdirSync(out,{recursive:true});
await build({entryPoints:['src/server/clinical-core/privacy-operations-lambda.ts'],outfile:out+'/index.js',
  bundle:true,platform:'node',target:'node22',format:'cjs',minify:true,legalComments:'none'});
const ref=n=>({Ref:n}),sub=v=>({'Fn::Sub':v}),nonempty=n=>({'Fn::Not':[{'Fn::Equals':[ref(n),'']}]}),
  hash={Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'};
const required=['ActivationEvidenceSha256','DatabaseReviewSha256','WorkforceMfaReviewSha256','AlarmTopicArn'];
const template={AWSTemplateFormatVersion:'2010-09-09',Description:'Owner-assigned privacy workforce queue; blocked and logs-only by default',
  Parameters:{
    ApiId:{Type:'String',AllowedPattern:'[a-z0-9]{10}'},
    WorkforceIssuer:{Type:'String',AllowedPattern:'^https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com/[A-Za-z0-9_-]+$'},
    WorkforceAudience:{Type:'String',AllowedPattern:'^[a-zA-Z0-9]{20,128}$'},
    PhiAllowed:{Type:'String',Default:'false',AllowedValues:['false','true']},
    Activation:{Type:'String',Default:'blocked',AllowedValues:['blocked','approved']},
    ActivationEvidenceSha256:hash,DatabaseReviewSha256:hash,WorkforceMfaReviewSha256:hash,
    PersonalPurgeEnabled:{Type:'String',Default:'false',AllowedValues:['false','true']},PersonalPurgeEvidenceSha256:hash,
    DatabaseClusterArn:{Type:'String',AllowedPattern:'^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$'},
    DatabaseSecretArn:{Type:'String',AllowedPattern:'^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$'},
    DatabaseName:{Type:'String',AllowedPattern:'^[a-z][a-z0-9_]{0,62}$'},
    SecretKmsKeyArn:{Type:'String',AllowedPattern:'^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    LogsKmsKeyArn:{Type:'String',AllowedPattern:'^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    AlarmTopicArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$'},
    CodeBucket:{Type:'String'},CodeKey:{Type:'String'},CodeVersion:{Type:'String',MinLength:1,MaxLength:1024,AllowedPattern:'^(?!null$).+$'},
    SourceCommit:{Type:'String',AllowedPattern:'^[a-f0-9]{40}$'},
  },
  Conditions:{Active:{'Fn::And':[{'Fn::Equals':[ref('PhiAllowed'),'true']},{'Fn::Equals':[ref('Activation'),'approved']},...required.map(nonempty)]},
    HasAlarmRecipient:nonempty('AlarmTopicArn')},
  Rules:{ReviewedActivation:{RuleCondition:{'Fn::Equals':[ref('PhiAllowed'),'true']},Assertions:[
    {Assert:{'Fn::Equals':[ref('Activation'),'approved']},AssertDescription:'Reviewed activation required'},
    ...required.map(n=>({Assert:nonempty(n),AssertDescription:n+' required before activation'}))]},
    ReviewedPersonalPurge:{RuleCondition:{'Fn::Equals':[ref('PersonalPurgeEnabled'),'true']},Assertions:[
      {Assert:{'Fn::Equals':[ref('PhiAllowed'),'true']},AssertDescription:'Privacy service activation required'},
      {Assert:nonempty('PersonalPurgeEvidenceSha256'),AssertDescription:'Separate reviewed purge evidence required'},
    ]}},
  Resources:{
    Logs:{Type:'AWS::Logs::LogGroup',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',
      Properties:{LogGroupName:sub('/aws/lambda/${ApiId}-privacy-operations'),RetentionInDays:30,KmsKeyId:ref('LogsKmsKeyArn')}},
    Role:{Type:'AWS::IAM::Role',Properties:{AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[
      {Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[
      {PolicyName:'bounded-logs',PolicyDocument:{Version:'2012-10-17',Statement:[
        {Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],Resource:{'Fn::GetAtt':['Logs','Arn']}}]}},
      {'Fn::If':['Active',{PolicyName:'ReviewedPrivacyOperations',PolicyDocument:{Version:'2012-10-17',Statement:[
        {Effect:'Allow',Action:['rds-data:BeginTransaction','rds-data:CommitTransaction','rds-data:RollbackTransaction','rds-data:ExecuteStatement'],
          Resource:ref('DatabaseClusterArn'),Condition:{StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId')}}},
        {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:ref('DatabaseSecretArn'),Condition:{StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId')}}},
        {Effect:'Allow',Action:'kms:Decrypt',Resource:ref('SecretKmsKeyArn'),Condition:{StringEquals:{
          'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com'),'kms:EncryptionContext:SecretARN':ref('DatabaseSecretArn'),
          'kms:CallerAccount':ref('AWS::AccountId')}}},
      ]}},ref('AWS::NoValue')]}]}},
    Function:{Type:'AWS::Lambda::Function',Properties:{FunctionName:sub('${ApiId}-privacy-operations'),Runtime:'nodejs22.x',Handler:'index.handler',
      Role:{'Fn::GetAtt':['Role','Arn']},Timeout:20,MemorySize:256,ReservedConcurrentExecutions:2,
      Code:{S3Bucket:ref('CodeBucket'),S3Key:ref('CodeKey'),S3ObjectVersion:ref('CodeVersion')},
      LoggingConfig:{LogGroup:ref('Logs')},Environment:{Variables:{
        WORKFORCE_ISSUER:ref('WorkforceIssuer'),WORKFORCE_AUDIENCE:ref('WorkforceAudience'),PHI_ALLOWED:ref('PhiAllowed'),
        PRIVACY_OPERATIONS_ACTIVATION:ref('Activation'),PRIVACY_OPERATIONS_EVIDENCE_SHA256:ref('ActivationEvidenceSha256'),
        PERSONAL_PURGE_ENABLED:ref('PersonalPurgeEnabled'),PERSONAL_PURGE_EVIDENCE_SHA256:ref('PersonalPurgeEvidenceSha256'),
        WORKFORCE_MFA_REVIEW_SHA256:ref('WorkforceMfaReviewSha256'),CLINICAL_DATABASE_CLUSTER_ARN:ref('DatabaseClusterArn'),
        CLINICAL_DATABASE_SECRET_ARN:ref('DatabaseSecretArn'),CLINICAL_DATABASE_NAME:ref('DatabaseName'),SOURCE_COMMIT:ref('SourceCommit'),
      }}}},
    Authorizer:{Type:'AWS::ApiGatewayV2::Authorizer',Properties:{ApiId:ref('ApiId'),Name:sub('${ApiId}-privacy-workforce'),
      AuthorizerType:'JWT',IdentitySource:['$request.header.Authorization'],JwtConfiguration:{Issuer:ref('WorkforceIssuer'),Audience:[ref('WorkforceAudience')]}}},
    Integration:{Type:'AWS::ApiGatewayV2::Integration',Properties:{ApiId:ref('ApiId'),IntegrationType:'AWS_PROXY',
      IntegrationUri:{'Fn::GetAtt':['Function','Arn']},PayloadFormatVersion:'2.0'}},
    Route:{Type:'AWS::ApiGatewayV2::Route',Properties:{ApiId:ref('ApiId'),RouteKey:'POST /clinical-core/workforce/privacy-operations',
      AuthorizationType:'JWT',AuthorizerId:ref('Authorizer'),Target:{'Fn::Join':['/',['integrations',ref('Integration')]]}}},
    Invoke:{Type:'AWS::Lambda::Permission',Properties:{FunctionName:ref('Function'),Action:'lambda:InvokeFunction',Principal:'apigateway.amazonaws.com',
      SourceAccount:ref('AWS::AccountId'),SourceArn:sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/privacy-operations')}},
  },
  Outputs:{PhiAllowed:{Value:ref('PhiAllowed')},Activation:{Value:ref('Activation')},SourceCommit:{Value:ref('SourceCommit')}},
};
for(const metric of ['Errors','Throttles'])template.Resources[metric+'Alarm']={Type:'AWS::CloudWatch::Alarm',Properties:{
  Namespace:'AWS/Lambda',MetricName:metric,Dimensions:[{Name:'FunctionName',Value:ref('Function')}],Statistic:'Sum',Period:60,
  EvaluationPeriods:1,Threshold:1,ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',
  AlarmActions:{'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]},
}};
template.Resources.ApiFailureAlarm={Type:'AWS::CloudWatch::Alarm',Properties:{...template.Resources.ErrorsAlarm.Properties,
  Namespace:'AWS/ApiGateway',MetricName:'5xx',Dimensions:[{Name:'ApiId',Value:ref('ApiId')}]}};
writeFileSync(out+'/template.json',JSON.stringify(template,null,2));
console.log('Built default-blocked privacy operations candidate; no deployment, assignments or activation.');
