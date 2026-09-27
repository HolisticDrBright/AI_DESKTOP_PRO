// Infrastructure preparation only. No application, identity, provider, fixture or PHI activation.
import {mkdirSync, writeFileSync} from 'node:fs';
export const ACCOUNT = '588966314750';
export const REGION = 'us-east-2';
const ref = name => ({Ref:name});
const sub = value => ({'Fn::Sub':value});
const arn = name => ({'Fn::GetAtt':[name,'Arn']});
const tags = [{Key:'Environment',Value:'synthetic-staging'},{Key:'DataClassification',Value:'synthetic_only'},{Key:'Purpose',Value:'isolated-qualification'},{Key:'PhiAllowed',Value:'false'}];
const retain = {DeletionPolicy:'RetainExceptOnCreate',UpdateReplacePolicy:'Retain'};
const bucket = (name,key,lifecycle) => ({Type:'AWS::S3::Bucket',...retain,Properties:{
  BucketName:sub(`alp-qualification-${name}-\${AWS::AccountId}-\${AWS::Region}`),
  PublicAccessBlockConfiguration:{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true},
  OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},VersioningConfiguration:{Status:'Enabled'},
  BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:key?{SSEAlgorithm:'aws:kms',KMSMasterKeyID:arn(key)}:{SSEAlgorithm:'AES256'}}]},
  LifecycleConfiguration:{Rules:lifecycle},Tags:tags,
}});
const tls = bucketName => ({Type:'AWS::S3::BucketPolicy',Properties:{Bucket:ref(bucketName),PolicyDocument:{Version:'2012-10-17',Statement:[{
  Sid:'DenyInsecureTransport',Effect:'Deny',Principal:'*',Action:'s3:*',Resource:[arn(bucketName),sub(`\${${bucketName}.Arn}/*`)],Condition:{Bool:{'aws:SecureTransport':'false'}},
}]}}});
const key = (description,statements=[]) => ({Type:'AWS::KMS::Key',...retain,Properties:{Description:description,EnableKeyRotation:true,PendingWindowInDays:30,Tags:tags,
  KeyPolicy:{Version:'2012-10-17',Statement:[{Sid:'DelegateToAccountIAM',Effect:'Allow',Principal:{AWS:sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root')},Action:'kms:*',Resource:'*'},...statements]},
}});
export function buildQualificationFoundation(){
 const resources={
  Api:{Type:'AWS::ApiGatewayV2::Api',Properties:{Name:'ai-clinical-core-isolated-qualification',ProtocolType:'HTTP',Tags:Object.fromEntries(tags.map(t=>[t.Key,t.Value]))}},
  ExportKey:key('Synthetic qualification personal exports only; not production activation'),
  LogsKey:key('Isolated qualification log encryption',[{Sid:'QualifiedCloudWatchLogs',Effect:'Allow',Principal:{Service:`logs.${REGION}.amazonaws.com`},
   Action:['kms:Encrypt','kms:Decrypt','kms:ReEncrypt*','kms:GenerateDataKey*','kms:DescribeKey'],Resource:'*',Condition:{ArnLike:{'kms:EncryptionContext:aws:logs:arn':[
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/apigateway/qualification/${Api}'),
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${Api}-*'),
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/ai-clinical-core/production/personal-voice/${Api}'),
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/ai-clinical-core/production/personal-lab/${Api}*'),
   ]}}},{Sid:'QualificationAlarmEncryption',Effect:'Allow',Principal:{Service:'cloudwatch.amazonaws.com'},Action:['kms:Decrypt','kms:GenerateDataKey*'],Resource:'*',
    Condition:{StringEquals:{'aws:SourceAccount':ref('AWS::AccountId')},ArnLike:{'aws:SourceArn':sub('arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:ai-clinical-core-qualification-*')}}}]),
  CodeBucket:bucket('code',null,[{Id:'AbortIncompleteCodeUploads',Status:'Enabled',AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}}]),
  ExportBucket:bucket('exports','ExportKey',[
   {Id:'AbortIncompleteExports',Status:'Enabled',Prefix:'personal-exports/',AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}},
   {Id:'ExpireNoncurrentExports',Status:'Enabled',Prefix:'personal-exports/',NoncurrentVersionExpiration:{NoncurrentDays:1}},
   {Id:'ExpireCurrentExports',Status:'Enabled',Prefix:'personal-exports/',ExpirationInDays:3},
   {Id:'RemoveExpiredDeleteMarkers',Status:'Enabled',Prefix:'personal-exports/',ExpiredObjectDeleteMarker:true},
  ]),
  CodeBucketPolicy:tls('CodeBucket'),ExportBucketPolicy:tls('ExportBucket'),
  AccessLogs:{Type:'AWS::Logs::LogGroup',...retain,Properties:{LogGroupName:sub('/aws/apigateway/qualification/${Api}'),RetentionInDays:30,KmsKeyId:arn('LogsKey'),Tags:tags}},
  Stage:{Type:'AWS::ApiGatewayV2::Stage',Properties:{ApiId:ref('Api'),StageName:'$default',AutoDeploy:true,
   DefaultRouteSettings:{ThrottlingBurstLimit:10,ThrottlingRateLimit:5,DetailedMetricsEnabled:true},
   AccessLogSettings:{DestinationArn:arn('AccessLogs'),Format:'{"requestId":"$context.requestId","status":"$context.status","responseLength":"$context.responseLength"}'},
   Tags:Object.fromEntries(tags.map(t=>[t.Key,t.Value])),
  }},
  AlarmTopic:{Type:'AWS::SNS::Topic',Properties:{TopicName:'ai-clinical-core-qualification-alarms',KmsMasterKeyId:arn('LogsKey'),Tags:tags}},
  AlarmTopicPolicy:{Type:'AWS::SNS::TopicPolicy',Properties:{Topics:[ref('AlarmTopic')],PolicyDocument:{Version:'2012-10-17',Statement:[{
   Sid:'QualificationAlarmsOnly',Effect:'Allow',Principal:{Service:'cloudwatch.amazonaws.com'},Action:'sns:Publish',Resource:ref('AlarmTopic'),
   Condition:{StringEquals:{'aws:SourceAccount':ref('AWS::AccountId')},ArnLike:{'aws:SourceArn':sub('arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:ai-clinical-core-qualification-*')}}},
   {Sid:'AccountAdministration',Effect:'Allow',Principal:{AWS:sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root')},Action:['sns:GetTopicAttributes','sns:SetTopicAttributes','sns:AddPermission','sns:RemovePermission','sns:DeleteTopic','sns:Subscribe','sns:ListSubscriptionsByTopic','sns:Publish'],Resource:ref('AlarmTopic')},
  ]}}},
  ApiFailureAlarm:{Type:'AWS::CloudWatch::Alarm',DependsOn:'AlarmTopicPolicy',Properties:{AlarmName:'ai-clinical-core-qualification-api-failures',AlarmDescription:'Synthetic qualification API 5xx; topic has no delivery subscription until separately reviewed.',
   Namespace:'AWS/ApiGateway',MetricName:'5xx',Dimensions:[{Name:'ApiId',Value:ref('Api')}],Statistic:'Sum',Period:60,EvaluationPeriods:1,Threshold:1,
   ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',AlarmActions:[ref('AlarmTopic')],Tags:tags}},
 };
 for(const resource of Object.values(resources)) resource.Condition='SyntheticAccountAndRegion';
 const out=value=>({Value:value});
 return {AWSTemplateFormatVersion:'2010-09-09',Description:'Isolated synthetic qualification support only: empty API, private versioned storage and logs; no clinical handlers or PHI activation.',
  Metadata:{Qualification:{ContainsPhi:false,ProductionActivation:'blocked',ApplicationRoutes:0,FixturesSeeded:false,AlarmDeliveryVerified:false,ExportLifecycle:'Synthetic test-only fallback; not a production retention approval or deletion guarantee.'}},
  Parameters:{
   DatabaseClusterArn:{Type:'String',AllowedValues:['arn:aws:rds:us-east-2:588966314750:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa']},
   DatabaseSecretArn:{Type:'String',AllowedPattern:'^arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-[A-Za-z0-9-]+$'},
   BaseSourceCommit:{Type:'String',AllowedPattern:'^[a-f0-9]{40}$'},TemplateSha256:{Type:'String',AllowedPattern:'^[a-f0-9]{64}$'},
  },
  Conditions:{SyntheticAccountAndRegion:{'Fn::And':[{'Fn::Equals':[ref('AWS::AccountId'),ACCOUNT]},{'Fn::Equals':[ref('AWS::Region'),REGION]}]}},
  Resources:resources,Outputs:{
   Environment:out('synthetic-staging'),DataClassification:out('synthetic_only'),PhiAllowed:out('false'),Activation:out('blocked'),
   QualificationExecution:out('disabled'),QualificationInfrastructure:out('prepared_no_candidates'),
   DatabaseName:out('clinical_core_qualification'),DatabaseClusterArn:out(ref('DatabaseClusterArn')),DatabaseSecretArn:out(ref('DatabaseSecretArn')),
   BaseSourceCommit:out(ref('BaseSourceCommit')),TemplateSha256:out(ref('TemplateSha256')),
   ...Object.fromEntries(Object.entries({ApiId:ref('Api'),ApiOrigin:sub('https://${Api}.execute-api.${AWS::Region}.amazonaws.com'),CodeBucket:ref('CodeBucket'),ExportBucketName:ref('ExportBucket'),ExportKmsKeyArn:arn('ExportKey'),LogsKmsKeyArn:arn('LogsKey'),AlarmTopicArn:ref('AlarmTopic')}).map(([name,value])=>[name,{Condition:'SyntheticAccountAndRegion',Value:value}])),
  },
 };
}
if(process.argv[1]?.endsWith('build-aws-qualification-foundation.mjs')){
 const out='dist/aws-clinical-core/qualification-foundation';mkdirSync(out,{recursive:true});
 writeFileSync(`${out}/template.json`,JSON.stringify(buildQualificationFoundation(),null,2)+'\n');
 console.log('Built qualification infrastructure only; no deployment or activation.');
}
