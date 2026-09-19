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
    ExternalInventoryEnabled:{Type:'String',Default:'false',AllowedValues:['false','true']},ExternalInventoryEvidenceSha256:hash,
    ExternalPurgeEnabled:{Type:'String',Default:'false',AllowedValues:['false','true']},ExternalPurgeEvidenceSha256:hash,
    IdentityDeletionEnabled:{Type:'String',Default:'false',AllowedValues:['false','true']},IdentityDeletionEvidenceSha256:hash,
    ConsumerUserPoolId:{Type:'String',Default:'',AllowedPattern:'^$|^[a-z0-9-]+_[A-Za-z0-9]+$'},
    LabDocumentBucket:{Type:'String',Default:'',AllowedPattern:'^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'},
    LabStateMachineArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:states:[a-z0-9-]+:[0-9]{12}:stateMachine:[a-z0-9-]+-personal-lab-analysis$'},
    VoiceBucket:{Type:'String',Default:'',AllowedPattern:'^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'},
    VoiceKmsKeyArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    LabTableArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]{3,255}$'},
    VoiceTableArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]{3,255}$'},
    LabTableKmsKeyArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    VoiceTableKmsKeyArn:{Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
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
    HasAlarmRecipient:nonempty('AlarmTopicArn'),InventoryActive:{'Fn::And':[{Condition:'Active'},
      {'Fn::Equals':[ref('ExternalInventoryEnabled'),'true']},...['ExternalInventoryEvidenceSha256','LabTableArn','VoiceTableArn','LabTableKmsKeyArn','VoiceTableKmsKeyArn'].map(nonempty)]},
    PurgeActive:{'Fn::And':[{Condition:'InventoryActive'},{'Fn::Equals':[ref('ExternalPurgeEnabled'),'true']},
      ...['ExternalPurgeEvidenceSha256','LabDocumentBucket','LabStateMachineArn','VoiceBucket','VoiceKmsKeyArn'].map(nonempty)]},
    IdentityDeletionActive:{'Fn::And':[{Condition:'Active'},{'Fn::Equals':[ref('IdentityDeletionEnabled'),'true']},
      ...['IdentityDeletionEvidenceSha256','ConsumerUserPoolId'].map(nonempty)]}},
  Rules:{ReviewedActivation:{RuleCondition:{'Fn::Equals':[ref('PhiAllowed'),'true']},Assertions:[
    {Assert:{'Fn::Equals':[ref('Activation'),'approved']},AssertDescription:'Reviewed activation required'},
    ...required.map(n=>({Assert:nonempty(n),AssertDescription:n+' required before activation'}))]},
    ReviewedExternalInventory:{RuleCondition:{'Fn::Equals':[ref('ExternalInventoryEnabled'),'true']},Assertions:[
      {Assert:{'Fn::Equals':[ref('PhiAllowed'),'true']},AssertDescription:'Privacy service activation required'},
      ...['ExternalInventoryEvidenceSha256','LabTableArn','VoiceTableArn','LabTableKmsKeyArn','VoiceTableKmsKeyArn'].map(n=>({Assert:nonempty(n),AssertDescription:n+' required'})),
    ]},
    ReviewedExternalPurge:{RuleCondition:{'Fn::Equals':[ref('ExternalPurgeEnabled'),'true']},Assertions:[
      {Assert:{'Fn::Equals':[ref('ExternalInventoryEnabled'),'true']},AssertDescription:'External inventory activation required'},
      ...['ExternalPurgeEvidenceSha256','LabDocumentBucket','LabStateMachineArn','VoiceBucket','VoiceKmsKeyArn'].map(n=>({Assert:nonempty(n),AssertDescription:n+' required'})),
    ]},
    ReviewedIdentityDeletion:{RuleCondition:{'Fn::Equals':[ref('IdentityDeletionEnabled'),'true']},Assertions:[
      {Assert:{'Fn::Equals':[ref('PhiAllowed'),'true']},AssertDescription:'Privacy service activation required'},
      ...['IdentityDeletionEvidenceSha256','ConsumerUserPoolId'].map(n=>({Assert:nonempty(n),AssertDescription:n+' required'})),
    ]},
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
      ]}},ref('AWS::NoValue')]},
      {'Fn::If':['InventoryActive',{PolicyName:'ReadOnlyRetainedJobInventory',PolicyDocument:{Version:'2012-10-17',Statement:[
        ...[['Lab',['pk','personId','organizationId','ownerSub','dataClassification','state','updatedAt','contractVersion','cleanupPartition','lastVerifiedAt']],
          ['Voice',['id','owner','authorization','state']]].map(([kind,attributes])=>({Effect:'Allow',Action:'dynamodb:Scan',Resource:ref(kind+'TableArn'),
          Condition:{StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId'),'dynamodb:Select':'SPECIFIC_ATTRIBUTES'},
            'ForAllValues:StringEquals':{'dynamodb:Attributes':attributes}}})),
        ...['Lab','Voice'].map(kind=>({Effect:'Allow',Action:'kms:Decrypt',Resource:ref(kind+'TableKmsKeyArn'),Condition:{StringEquals:{
          'kms:ViaService':sub('dynamodb.${AWS::Region}.amazonaws.com'),'kms:CallerAccount':ref('AWS::AccountId'),
          'kms:EncryptionContext:aws:dynamodb:tableName':{'Fn::Select':[1,{'Fn::Split':['/',ref(kind+'TableArn')]}]},
        }}})),
      ]}},ref('AWS::NoValue')]},
      {'Fn::If':['PurgeActive',{PolicyName:'ReviewedExternalPurge',PolicyDocument:{Version:'2012-10-17',Statement:[
        // Inventoried lab jobs: fence, stop and purge through the existing outbox path.
        {Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:ConditionCheckItem'],Resource:ref('LabTableArn'),
          Condition:{StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId')}}},
        {Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:UpdateItem'],Resource:ref('VoiceTableArn'),
          Condition:{StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId')}}},
        ...['Lab','Voice'].map(kind=>({Effect:'Allow',Action:['kms:Decrypt','kms:GenerateDataKey'],Resource:ref(kind+'TableKmsKeyArn'),Condition:{StringEquals:{
          'kms:ViaService':sub('dynamodb.${AWS::Region}.amazonaws.com'),'kms:CallerAccount':ref('AWS::AccountId'),
          'kms:EncryptionContext:aws:dynamodb:tableName':{'Fn::Select':[1,{'Fn::Split':['/',ref(kind+'TableArn')]}]}}}})),
        {Effect:'Allow',Action:'s3:ListBucketVersions',Resource:sub('arn:${AWS::Partition}:s3:::${LabDocumentBucket}'),Condition:{StringLike:{'s3:prefix':'personal-labs/*'}}},
        {Effect:'Allow',Action:['s3:DeleteObject','s3:DeleteObjectVersion'],Resource:sub('arn:${AWS::Partition}:s3:::${LabDocumentBucket}/personal-labs/*')},
        {Effect:'Allow',Action:'s3:DeleteObject',Resource:sub('arn:${AWS::Partition}:s3:::${VoiceBucket}/personal-voice/*')},
        {Effect:'Allow',Action:'states:StopExecution',Resource:{'Fn::Join':[':',[{'Fn::Select':[0,{'Fn::Split':[':stateMachine:',ref('LabStateMachineArn')]}]},'execution',
          {'Fn::Select':[1,{'Fn::Split':[':stateMachine:',ref('LabStateMachineArn')]}]},'*']]}},
        {Effect:'Allow',Action:['transcribe:GetTranscriptionJob','transcribe:DeleteTranscriptionJob'],
          Resource:sub('arn:${AWS::Partition}:transcribe:${AWS::Region}:${AWS::AccountId}:transcription-job/alp-personal-voice-*')},
      ]}},ref('AWS::NoValue')]},
      {'Fn::If':['IdentityDeletionActive',{PolicyName:'ReviewedIdentityDeletion',PolicyDocument:{Version:'2012-10-17',Statement:[
        {Effect:'Allow',Action:['cognito-idp:AdminDisableUser','cognito-idp:AdminUserGlobalSignOut','cognito-idp:AdminDeleteUser'],
          Resource:sub('arn:${AWS::Partition}:cognito-idp:${AWS::Region}:${AWS::AccountId}:userpool/${ConsumerUserPoolId}')},
      ]}},ref('AWS::NoValue')]},
    ]}},
    Function:{Type:'AWS::Lambda::Function',Properties:{FunctionName:sub('${ApiId}-privacy-operations'),Runtime:'nodejs22.x',Handler:'index.handler',
      Role:{'Fn::GetAtt':['Role','Arn']},Timeout:60,MemorySize:256,ReservedConcurrentExecutions:2,
      Code:{S3Bucket:ref('CodeBucket'),S3Key:ref('CodeKey'),S3ObjectVersion:ref('CodeVersion')},
      LoggingConfig:{LogGroup:ref('Logs')},Environment:{Variables:{
        WORKFORCE_ISSUER:ref('WorkforceIssuer'),WORKFORCE_AUDIENCE:ref('WorkforceAudience'),PHI_ALLOWED:ref('PhiAllowed'),
        PRIVACY_OPERATIONS_ACTIVATION:ref('Activation'),PRIVACY_OPERATIONS_EVIDENCE_SHA256:ref('ActivationEvidenceSha256'),
        PERSONAL_PURGE_ENABLED:ref('PersonalPurgeEnabled'),PERSONAL_PURGE_EVIDENCE_SHA256:ref('PersonalPurgeEvidenceSha256'),
        EXTERNAL_INVENTORY_ENABLED:ref('ExternalInventoryEnabled'),EXTERNAL_INVENTORY_EVIDENCE_SHA256:ref('ExternalInventoryEvidenceSha256'),
        PRIVACY_LAB_TABLE_ARN:ref('LabTableArn'),PRIVACY_VOICE_TABLE_ARN:ref('VoiceTableArn'),
        EXTERNAL_PURGE_ENABLED:ref('ExternalPurgeEnabled'),EXTERNAL_PURGE_EVIDENCE_SHA256:ref('ExternalPurgeEvidenceSha256'),
        LAB_DOCUMENT_BUCKET:ref('LabDocumentBucket'),LAB_STATE_MACHINE_ARN:ref('LabStateMachineArn'),LAB_OBJECT_PREFIX:'personal-labs',
        VOICE_BUCKET:ref('VoiceBucket'),VOICE_KMS_KEY_ARN:ref('VoiceKmsKeyArn'),
        IDENTITY_DELETION_ENABLED:ref('IdentityDeletionEnabled'),IDENTITY_DELETION_EVIDENCE_SHA256:ref('IdentityDeletionEvidenceSha256'),CONSUMER_USER_POOL_ID:ref('ConsumerUserPoolId'),
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
