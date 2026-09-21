// Deployment artifact only: generating this template never activates a workload.
const ref = name => ({Ref: name});
const sub = value => ({'Fn::Sub': value});
const nonempty = name => ({'Fn::Not': [{'Fn::Equals': [ref(name), '']}]});
import {qualificationConditions,qualificationEnvironment,qualificationParameters,qualificationRules} from './qualification-execution-template.mjs';
export function personalStorageCandidate(disabled) {
  const template = structuredClone(disabled);
  template.Description = 'Independent personal storage production candidate; blocked and logs-only by default';
  delete template.Parameters.ConsumerAuthorizerId;
  const scopes = ['forms_checkins','symptoms_adherence','nutrition','protocols_supplements','wearables','reproductive_health','ai_context','lab_history','voice_transcription'];
  Object.assign(template.Parameters, {
    ConsumerIssuer: {Type:'String',AllowedPattern:'^https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com/[A-Za-z0-9_-]+$'},
    ConsumerAudience: {Type:'String',AllowedPattern:'^[a-zA-Z0-9]{20,128}$'},
    PhiAllowed: {Type:'String',Default:'false',AllowedValues:['false','true']},
    Activation: {Type:'String',Default:'blocked',AllowedValues:['blocked','approved']},
    ActivationEvidenceSha256: {Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
    DatabaseReviewSha256: {Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
    AllowedScopes: {Type:'String',Default:'',AllowedPattern:`^$|^(${scopes.join('|')})(,(${scopes.join('|')}))*$`},
    DatabaseClusterArn: {Type:'String',AllowedPattern:'^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$'},
    DatabaseSecretArn: {Type:'String',AllowedPattern:'^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$'},
    DatabaseName: {Type:'String',AllowedPattern:'^[a-z][a-z0-9_]{0,62}$'},
    SecretKmsKeyArn: {Type:'String',AllowedPattern:'^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    LogsKmsKeyArn: {Type:'String',AllowedPattern:'^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    AlarmTopicArn: {Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$'},
    CodeVersion: {Type:'String',MinLength:1,MaxLength:1024,AllowedPattern:'^(?!null$).+$'},
    SourceCommit: {Type:'String',AllowedPattern:'^[a-f0-9]{40}$'},
    // Large-export delivery is optional and separately reviewed: without all three the job routes refuse.
    ExportBucketName: {Type:'String',Default:'',AllowedPattern:'^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'},
    ExportKmsKeyArn: {Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    ExportReviewSha256: {Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
    // Cross-store export coverage is optional and separately reviewed per store: the export pass reads the owner's lab jobs,
    // documents and voice transcripts only where the store's table, bucket and key are named with the review digest.
    ExportLabJobTableArn: {Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]{3,255}$'},
    ExportLabDocumentBucketName: {Type:'String',Default:'',AllowedPattern:'^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'},
    ExportLabKmsKeyArn: {Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    ExportVoiceJobTableArn: {Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]{3,255}$'},
    ExportTranscriptionBucketName: {Type:'String',Default:'',AllowedPattern:'^$|^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'},
    ExportVoiceKmsKeyArn: {Type:'String',Default:'',AllowedPattern:'^$|^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$'},
    CrossStoreExportReviewSha256: {Type:'String',Default:'',AllowedPattern:'^$|^[a-f0-9]{64}$'},
    // Qualification execution: serves only the designated fictional identities against the isolated qualification database
    // with PHI disabled and production activation blocked (docs/aws-qualification-target.md). Disabled by default; never
    // combinable with PhiAllowed=true or Activation=approved; pinned to the deploying account, which is never production.
    ...qualificationParameters(),
  });
  const required = ['ActivationEvidenceSha256','DatabaseReviewSha256','AllowedScopes','AlarmTopicArn'];
  template.Conditions = {
    Active: {'Fn::And': [
      {'Fn::Equals':[ref('PhiAllowed'),'true']},
      {'Fn::Equals':[ref('Activation'),'approved']}, ...required.map(nonempty),
    ]},
    ...qualificationConditions(['DatabaseReviewSha256','AllowedScopes','AlarmTopicArn']),
    HasAlarmRecipient: nonempty('AlarmTopicArn'),
    // Export delivery rides either mode: the production activation or the qualification execution, never a third state.
    ExportDelivery: {'Fn::And':[{Condition:'Enabled'},
      nonempty('ExportBucketName'),nonempty('ExportKmsKeyArn'),nonempty('ExportReviewSha256')]},
    // Fn::And accepts at most ten conditions: each store builds on the ExportDelivery condition rather than restating it.
    CrossStoreLabExport: {'Fn::And':[{Condition:'ExportDelivery'},
      nonempty('ExportLabJobTableArn'),nonempty('ExportLabDocumentBucketName'),nonempty('ExportLabKmsKeyArn'),nonempty('CrossStoreExportReviewSha256')]},
    CrossStoreVoiceExport: {'Fn::And':[{Condition:'ExportDelivery'},
      nonempty('ExportVoiceJobTableArn'),nonempty('ExportTranscriptionBucketName'),nonempty('ExportVoiceKmsKeyArn'),nonempty('CrossStoreExportReviewSha256')]},
  };
  template.Rules = {...qualificationRules(),ActivationRequiresReviewedConfiguration: {
    RuleCondition: {'Fn::Equals':[ref('PhiAllowed'),'true']},
    Assertions: [
      {Assert:{'Fn::Equals':[ref('Activation'),'approved']},AssertDescription:'Reviewed activation is required'},
      ...required.map(name => ({Assert:nonempty(name),AssertDescription:`${name} required before activation`})),
    ],
  },ExportDeliveryRequiresReview: {
    RuleCondition: {'Fn::Not':[{'Fn::Equals':[ref('ExportBucketName'),'']}]},
    Assertions: [
      {Assert:nonempty('ExportKmsKeyArn'),AssertDescription:'ExportKmsKeyArn required with an export bucket'},
      {Assert:nonempty('ExportReviewSha256'),AssertDescription:'ExportReviewSha256 required with an export bucket'},
    ],
  },CrossStoreLabExportRequiresReview: {
    RuleCondition: {'Fn::Not':[{'Fn::Equals':[ref('ExportLabJobTableArn'),'']}]},
    Assertions: [
      {Assert:nonempty('ExportBucketName'),AssertDescription:'Export delivery is required before cross-store lab export'},
      {Assert:nonempty('ExportLabDocumentBucketName'),AssertDescription:'ExportLabDocumentBucketName required with a lab job table'},
      {Assert:nonempty('ExportLabKmsKeyArn'),AssertDescription:'ExportLabKmsKeyArn required with a lab job table'},
      {Assert:nonempty('CrossStoreExportReviewSha256'),AssertDescription:'CrossStoreExportReviewSha256 required with a lab job table'},
    ],
  },CrossStoreVoiceExportRequiresReview: {
    RuleCondition: {'Fn::Not':[{'Fn::Equals':[ref('ExportVoiceJobTableArn'),'']}]},
    Assertions: [
      {Assert:nonempty('ExportBucketName'),AssertDescription:'Export delivery is required before cross-store voice export'},
      {Assert:nonempty('ExportTranscriptionBucketName'),AssertDescription:'ExportTranscriptionBucketName required with a voice job table'},
      {Assert:nonempty('ExportVoiceKmsKeyArn'),AssertDescription:'ExportVoiceKmsKeyArn required with a voice job table'},
      {Assert:nonempty('CrossStoreExportReviewSha256'),AssertDescription:'CrossStoreExportReviewSha256 required with a voice job table'},
    ],
  }};
  const r = template.Resources;
  r.Logs.Properties = {
    LogGroupName:sub('/aws/lambda/${ApiId}-personal-storage'),RetentionInDays:30,KmsKeyId:ref('LogsKmsKeyArn'),
  };
  r.Logs.DeletionPolicy='Retain'; r.Logs.UpdateReplacePolicy='Retain';
  const account = {StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId')}};
  r.Role.Properties.Policies.push({'Fn::If':['Enabled',{
    PolicyName:'ReviewedPersonalRecordsOnly',PolicyDocument:{Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['rds-data:BeginTransaction','rds-data:CommitTransaction','rds-data:RollbackTransaction','rds-data:ExecuteStatement'],Resource:ref('DatabaseClusterArn'),Condition:account},
      {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:ref('DatabaseSecretArn'),Condition:account},
      {Effect:'Allow',Action:'kms:Decrypt',Resource:ref('SecretKmsKeyArn'),Condition:{StringEquals:{
        'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com'),
        'kms:EncryptionContext:SecretARN':ref('DatabaseSecretArn'),
        'kms:CallerAccount':ref('AWS::AccountId'),
      }}},
    ]},
  },ref('AWS::NoValue')]});
  // Export objects live under one prefix in the reviewed bucket; deletes are by exact version; listing is bound to that
  // prefix and exists so cleanup can prove no upload or version remains under a job's key before certifying deletion.
  r.Role.Properties.Policies.push({'Fn::If':['ExportDelivery',{
    PolicyName:'ReviewedPersonalExportObjectsOnly',PolicyDocument:{Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['s3:PutObject','s3:GetObject','s3:GetObjectVersion','s3:DeleteObjectVersion','s3:AbortMultipartUpload','s3:ListMultipartUploadParts'],
        Resource:sub('arn:${AWS::Partition}:s3:::${ExportBucketName}/personal-exports/*'),Condition:account},
      // Version listing is bound to the export prefix. s3:ListBucketMultipartUploads has no supported prefix condition, so it is a
      // bucket-level grant: the export bucket must be dedicated to personal exports (part of the ExportReviewSha256 review).
      {Effect:'Allow',Action:'s3:ListBucketVersions',Resource:sub('arn:${AWS::Partition}:s3:::${ExportBucketName}'),
        Condition:{StringLike:{'s3:prefix':'personal-exports/*'},StringEquals:{'aws:ResourceAccount':ref('AWS::AccountId')}}},
      {Effect:'Allow',Action:'s3:ListBucketMultipartUploads',Resource:sub('arn:${AWS::Partition}:s3:::${ExportBucketName}'),Condition:account},
      {Effect:'Allow',Action:['kms:GenerateDataKey','kms:Decrypt'],Resource:ref('ExportKmsKeyArn'),Condition:{StringEquals:{
        'kms:ViaService':sub('s3.${AWS::Region}.amazonaws.com'),'kms:CallerAccount':ref('AWS::AccountId')}}},
    ]},
  },ref('AWS::NoValue')]});
  // Cross-store export readers: read-only, owner-scoped by the code, bound to the named table, bucket and key of each store.
  // The lab reader queries the owner inventory index and reads job rows and document objects; the voice reader scans the
  // job table for the owner and reads transcript outputs only. No writes, deletes or listings of other prefixes.
  r.Role.Properties.Policies.push({'Fn::If':['CrossStoreLabExport',{
    PolicyName:'ReviewedCrossStoreLabExportReadOnly',PolicyDocument:{Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:Query'],Resource:[ref('ExportLabJobTableArn'),{'Fn::Join':['',[ref('ExportLabJobTableArn'),'/index/LabOwnerInventory']]}],Condition:account},
      {Effect:'Allow',Action:'s3:GetObject',Resource:sub('arn:${AWS::Partition}:s3:::${ExportLabDocumentBucketName}/*'),Condition:account},
      {Effect:'Allow',Action:'kms:Decrypt',Resource:ref('ExportLabKmsKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('s3.${AWS::Region}.amazonaws.com'),'kms:CallerAccount':ref('AWS::AccountId')}}},
    ]},
  },ref('AWS::NoValue')]});
  r.Role.Properties.Policies.push({'Fn::If':['CrossStoreVoiceExport',{
    PolicyName:'ReviewedCrossStoreVoiceExportReadOnly',PolicyDocument:{Version:'2012-10-17',Statement:[
      {Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:Scan'],Resource:ref('ExportVoiceJobTableArn'),Condition:account},
      {Effect:'Allow',Action:'s3:GetObject',Resource:sub('arn:${AWS::Partition}:s3:::${ExportTranscriptionBucketName}/personal-voice/output/*'),Condition:account},
      {Effect:'Allow',Action:'kms:Decrypt',Resource:ref('ExportVoiceKmsKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('s3.${AWS::Region}.amazonaws.com'),'kms:CallerAccount':ref('AWS::AccountId')}}},
    ]},
  },ref('AWS::NoValue')]});
  r.Function.Properties.FunctionName=sub('${ApiId}-personal-storage');
  r.Function.Properties.Code.S3ObjectVersion=ref('CodeVersion');
  r.Function.Properties.ReservedConcurrentExecutions=4;
  r.Function.Properties.Environment.Variables={
    CONSUMER_ISSUER:ref('ConsumerIssuer'),CONSUMER_AUDIENCE:ref('ConsumerAudience'),
    PHI_ALLOWED:ref('PhiAllowed'),PERSONAL_STORAGE_ACTIVATION:ref('Activation'),
    PERSONAL_STORAGE_EVIDENCE_SHA256:ref('ActivationEvidenceSha256'),PERSONAL_STORAGE_ALLOWED_SCOPES:ref('AllowedScopes'),
    CLINICAL_DATABASE_CLUSTER_ARN:ref('DatabaseClusterArn'),CLINICAL_DATABASE_SECRET_ARN:ref('DatabaseSecretArn'),CLINICAL_DATABASE_NAME:ref('DatabaseName'),
    KNOWLEDGE_RELEASE_MODE:'disabled',SOURCE_COMMIT:ref('SourceCommit'),
    ...qualificationEnvironment(),
    PERSONAL_EXPORT_BUCKET:{'Fn::If':['ExportDelivery',ref('ExportBucketName'),'']},
    PERSONAL_EXPORT_KMS_KEY_ARN:{'Fn::If':['ExportDelivery',ref('ExportKmsKeyArn'),'']},
    PERSONAL_EXPORT_BUCKET_OWNER:{'Fn::If':['ExportDelivery',ref('AWS::AccountId'),'']},
    EXPORT_LAB_JOB_TABLE:{'Fn::If':['CrossStoreLabExport',{'Fn::Select':[1,{'Fn::Split':['/',ref('ExportLabJobTableArn')]}]},'']},
    EXPORT_LAB_DOCUMENT_BUCKET:{'Fn::If':['CrossStoreLabExport',ref('ExportLabDocumentBucketName'),'']},
    EXPORT_VOICE_JOB_TABLE:{'Fn::If':['CrossStoreVoiceExport',{'Fn::Select':[1,{'Fn::Split':['/',ref('ExportVoiceJobTableArn')]}]},'']},
    EXPORT_TRANSCRIPTION_BUCKET:{'Fn::If':['CrossStoreVoiceExport',ref('ExportTranscriptionBucketName'),'']},
  };
  r.ConsumerAuthorizer={Type:'AWS::ApiGatewayV2::Authorizer',Properties:{
    ApiId:ref('ApiId'),Name:sub('${ApiId}-personal-storage-consumer'),AuthorizerType:'JWT',
    IdentitySource:['$request.header.Authorization'],JwtConfiguration:{Issuer:ref('ConsumerIssuer'),Audience:[ref('ConsumerAudience')]},
  }};
  for(const resource of Object.values(r))if(resource.Type==='AWS::ApiGatewayV2::Route')resource.Properties.AuthorizerId=ref('ConsumerAuthorizer');
  r.Invoke.Properties.SourceAccount=ref('AWS::AccountId');
  for(const metric of ['Errors','Throttles'])r[`${metric}Alarm`]={Type:'AWS::CloudWatch::Alarm',Properties:{
    Namespace:'AWS/Lambda',MetricName:metric,Dimensions:[{Name:'FunctionName',Value:ref('Function')}],
    Statistic:'Sum',Period:60,EvaluationPeriods:1,Threshold:1,ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',
    AlarmActions:{'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]},
  }};
  // API failures are returned as bounded 503s, not thrown Lambda errors. Monitor
  // HTTP API 5xx as well; this API-wide signal can include other route failures.
  r.ApiFailureAlarm={Type:'AWS::CloudWatch::Alarm',Properties:{
    Namespace:'AWS/ApiGateway',MetricName:'5xx',Dimensions:[{Name:'ApiId',Value:ref('ApiId')}],
    Statistic:'Sum',Period:60,EvaluationPeriods:1,Threshold:1,ComparisonOperator:'GreaterThanOrEqualToThreshold',TreatMissingData:'notBreaching',
    AlarmActions:{'Fn::If':['HasAlarmRecipient',[ref('AlarmTopicArn')],ref('AWS::NoValue')]},
  }};
  template.Outputs={PhiAllowed:{Value:ref('PhiAllowed')},Activation:{Value:ref('Activation')},QualificationExecution:{Value:{'Fn::If':['Qualification','enabled','disabled']}},
    FunctionArn:{Value:{'Fn::GetAtt':['Function','Arn']}},SourceCommit:{Value:ref('SourceCommit')},
    ActivationEvidenceSha256:{Value:ref('ActivationEvidenceSha256')},DatabaseReviewSha256:{Value:ref('DatabaseReviewSha256')}};
  return template;
}
