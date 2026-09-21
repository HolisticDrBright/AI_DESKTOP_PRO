import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { qualificationConditions, qualificationEnvironment, qualificationParameters, qualificationRules } from './qualification-execution-template.mjs';

const args=process.argv.slice(2),outputArgs=args.filter(arg=>arg.startsWith('--out-dir='));
const modes=args.filter(arg=>!arg.startsWith('--out-dir='));
if (modes.some(arg => !['--capture','--cleanup-review','--cleanup-execution','--transcription','--drafting'].includes(arg)) || modes.length > 1
  || outputArgs.length>1 || outputArgs.some(arg=>!arg.slice('--out-dir='.length).trim())) throw new Error('recording_build_argument_invalid');
const capture = modes.includes('--capture'), cleanupReview = modes.includes('--cleanup-review'), cleanupExecution = modes.includes('--cleanup-execution'), transcription = modes.includes('--transcription'), drafting = modes.includes('--drafting');
const suffix = capture ? 'recording-capture' : cleanupReview ? 'recording-cleanup-review' : cleanupExecution ? 'recording-cleanup-execution' : transcription ? 'recording-transcription' : drafting ? 'recording-drafting' : 'recording-authority';
const splitRuntime = capture || cleanupReview || cleanupExecution || transcription || drafting;
// Isolated output lets artifact tests avoid racing a simultaneous release build.
const out = outputArgs.length?resolve(outputArgs[0].slice('--out-dir='.length)):`dist/aws-clinical-core/${suffix}`;
mkdirSync(out, { recursive: true });
await build({ entryPoints: [`src/server/clinical-core/${suffix}-lambda.ts`], outfile: out + "/index.js",
  bundle: true, platform: "node", target: "node22", format: "cjs", minify: true, legalComments: "none",
  external: splitRuntime ? [`./${suffix}-runtime.js`] : [] });
if (splitRuntime) await build({ entryPoints: [`src/server/clinical-core/${suffix}-runtime.ts`], outfile: out + `/${suffix}-runtime.js`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none' });
const ref = name => ({ Ref: name }), sub = value => ({ "Fn::Sub": value });
const nonempty = name => ({ "Fn::Not": [{ "Fn::Equals": [ref(name), ""] }] });
const hash = { Type: "String", Default: "", AllowedPattern: "^$|^[a-f0-9]{64}$" };
const required = ["ActivationEvidenceSha256", "DatabaseReviewSha256", "WorkforceMfaReviewSha256", "AlarmTopicArn",
  ...(capture ? ['CaptureReviewSha256', 'StorageReviewSha256', 'RetentionReviewSha256'] : []),
  ...(cleanupReview ? ['CleanupReviewSha256'] : []),
  ...(cleanupExecution ? ['CleanupExecutionReviewSha256','CleanupWorkerSha256','StorageReviewSha256','HoldCoordinationReviewSha256'] : []),
  ...(transcription ? ['TranscriptionReviewSha256','ProviderReviewSha256','StorageReviewSha256'] : []),
  ...(drafting ? ['DraftingReviewSha256','ProviderReviewSha256','StorageReviewSha256'] : [])];
const template = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: drafting ? 'Review-only encounter AI drafting from stored transcripts; never writes clinical notes; independent reviews required; blocked by default' : transcription ? 'Encounter transcription authority and bounded provider processing; independent reviews required; blocked by default' : cleanupExecution ? 'One authenticated bounded recording cleanup pass; independent reviews required; blocked by default' : cleanupReview ? 'Read-only recording cleanup operator metadata; no storage or dispatch permission; blocked by default' : capture ? 'Encounter recording capture transport; independent reviewed activation; blocked and logs-only by default'
    : "Encounter recording consent authority; no audio transport; blocked and logs-only by default",
  Parameters: {
    ApiId: { Type: "String", AllowedPattern: "[a-z0-9]{10}" },
    WorkforceIssuer: { Type: "String", AllowedPattern: "^https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com/[A-Za-z0-9_-]+$" },
    WorkforceAudience: { Type: "String", AllowedPattern: "^[a-zA-Z0-9]{20,128}$" },
    OrganizationId: { Type: "String", AllowedPattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" },
    PhiAllowed: { Type: "String", Default: "false", AllowedValues: ["false", "true"] },
    Activation: { Type: "String", Default: "blocked", AllowedValues: ["blocked", "approved"] },
    ActivationEvidenceSha256: hash, DatabaseReviewSha256: hash, WorkforceMfaReviewSha256: hash,
    DatabaseClusterArn: { Type: "String", AllowedPattern: "^arn:aws:rds:[a-z0-9-]+:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$" },
    DatabaseSecretArn: { Type: "String", AllowedPattern: "^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$" },
    DatabaseName: { Type: "String", AllowedPattern: "^[a-z][a-z0-9_]{0,62}$" },
    SecretKmsKeyArn: { Type: "String", AllowedPattern: "^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$" },
    LogsKmsKeyArn: { Type: "String", AllowedPattern: "^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$" },
    AlarmTopicArn: { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$" },
    CodeBucket: { Type: "String" }, CodeKey: { Type: "String" },
    CodeVersion: { Type: "String", MinLength: 1, MaxLength: 1024, AllowedPattern: "^(?!null$).+$" },
    SourceCommit: { Type: "String", AllowedPattern: "^[a-f0-9]{40}$" },
    // Qualification execution (docs/aws-qualification-target.md): designated fictional workforce identities against the isolated
    // qualification database with PHI disabled; the data policy rides Enabled (Active or Qualification), never a third state.
    ...qualificationParameters(),
  },
  Conditions: {
    Active: { "Fn::And": [{ "Fn::Equals": [ref("PhiAllowed"), "true"] }, { "Fn::Equals": [ref("Activation"), "approved"] }, ...required.map(nonempty)] },
    ...qualificationConditions(required.filter(name => name !== "ActivationEvidenceSha256")),
    HasAlarmRecipient: nonempty("AlarmTopicArn"),
  },
  Rules: { ...qualificationRules(), ReviewedActivation: { RuleCondition: { "Fn::Equals": [ref("PhiAllowed"), "true"] }, Assertions: [
    { Assert: { "Fn::Equals": [ref("Activation"), "approved"] }, AssertDescription: "Reviewed activation required" },
    ...required.map(name => ({ Assert: nonempty(name), AssertDescription: name + " required before activation" })),
  ] } },
  Resources: {
    Logs: { Type: "AWS::Logs::LogGroup", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain", Properties: {
      LogGroupName: sub(`/aws/lambda/\${ApiId}-${suffix}`), RetentionInDays: 30, KmsKeyId: ref("LogsKmsKeyArn"),
    } },
    Role: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
    ] }, Policies: [
      { PolicyName: "bounded-logs", PolicyDocument: { Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: { "Fn::GetAtt": ["Logs", "Arn"] } },
      ] } },
      { "Fn::If": ["Enabled", { PolicyName: "ReviewedRecordingAuthority", PolicyDocument: { Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction", "rds-data:ExecuteStatement"], Resource: ref("DatabaseClusterArn") },
        { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: ref("DatabaseSecretArn") },
        { Effect: "Allow", Action: "kms:Decrypt", Resource: ref("SecretKmsKeyArn"), Condition: { StringEquals: {
          "kms:ViaService": sub("secretsmanager.${AWS::Region}.amazonaws.com"), "kms:CallerAccount": ref("AWS::AccountId"),
          "kms:EncryptionContext:SecretARN": ref("DatabaseSecretArn"),
        } } },
      ] } }, ref("AWS::NoValue")] },
    ] } },
    Function: { Type: "AWS::Lambda::Function", Properties: { FunctionName: sub(`\${ApiId}-${suffix}`), Runtime: "nodejs22.x", Handler: "index.handler",
      Role: { "Fn::GetAtt": ["Role", "Arn"] }, Timeout: capture || cleanupExecution || transcription || drafting ? 29 : 20, MemorySize: transcription || drafting ? 1024 : capture || cleanupExecution ? 512 : 256, ReservedConcurrentExecutions: 2,
      Code: { S3Bucket: ref("CodeBucket"), S3Key: ref("CodeKey"), S3ObjectVersion: ref("CodeVersion") },
      LoggingConfig: { LogGroup: ref("Logs") }, Environment: { Variables: {
        WORKFORCE_ISSUER: ref("WorkforceIssuer"), WORKFORCE_AUDIENCE: ref("WorkforceAudience"), RECORDING_ORGANIZATION_ID: ref("OrganizationId"),
        PHI_ALLOWED: ref("PhiAllowed"), RECORDING_AUTHORITY_ACTIVATION: ref("Activation"),
        RECORDING_AUTHORITY_EVIDENCE_SHA256: ref("ActivationEvidenceSha256"), WORKFORCE_MFA_REVIEW_SHA256: ref("WorkforceMfaReviewSha256"),
        DATABASE_REVIEW_SHA256: ref("DatabaseReviewSha256"), CLINICAL_DATABASE_CLUSTER_ARN: ref("DatabaseClusterArn"),
        CLINICAL_DATABASE_SECRET_ARN: ref("DatabaseSecretArn"), CLINICAL_DATABASE_NAME: ref("DatabaseName"), SOURCE_COMMIT: ref("SourceCommit"),
        ...qualificationEnvironment(),
      } } } },
    Authorizer: { Type: "AWS::ApiGatewayV2::Authorizer", Properties: { ApiId: ref("ApiId"), Name: sub(`\${ApiId}-${suffix}-workforce`),
      AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"], JwtConfiguration: { Issuer: ref("WorkforceIssuer"), Audience: [ref("WorkforceAudience")] },
    } },
    Integration: { Type: "AWS::ApiGatewayV2::Integration", Properties: { ApiId: ref("ApiId"), IntegrationType: "AWS_PROXY",
      IntegrationUri: { "Fn::GetAtt": ["Function", "Arn"] }, PayloadFormatVersion: "2.0", TimeoutInMillis: capture || cleanupExecution || transcription || drafting ? 30000 : 20000,
    } },
    Route: { Type: "AWS::ApiGatewayV2::Route", Properties: { ApiId: ref("ApiId"), RouteKey: "POST /clinical-core/workforce/encounter-recording/authority",
      AuthorizationType: "JWT", AuthorizerId: ref("Authorizer"), Target: { "Fn::Join": ["/", ["integrations", ref("Integration")]] },
    } },
    Invoke: { Type: "AWS::Lambda::Permission", Properties: { FunctionName: ref("Function"), Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com",
      SourceAccount: ref("AWS::AccountId"), SourceArn: sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/encounter-recording/authority"),
    } },
  },
  Outputs: { PhiAllowed: { Value: ref("PhiAllowed") }, Activation: { Value: ref("Activation") }, QualificationExecution: { Value: { "Fn::If": ["Qualification", "enabled", "disabled"] } }, SourceCommit: { Value: ref("SourceCommit") } },
};
if (capture) {
  Object.assign(template.Parameters, {
    CaptureReleaseId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    CaptureReviewSha256: hash, StorageReviewSha256: hash, RetentionReviewSha256: hash,
    RecordingBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' },
    RecordingKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' },
  });
  const vars = template.Resources.Function.Properties.Environment.Variables;
  delete vars.RECORDING_AUTHORITY_ACTIVATION; delete vars.RECORDING_AUTHORITY_EVIDENCE_SHA256;
  Object.assign(vars, { RECORDING_CAPTURE_ACTIVATION: ref('Activation'), RECORDING_CAPTURE_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'),
    RECORDING_CAPTURE_RELEASE_ID: ref('CaptureReleaseId'), RECORDING_CAPTURE_REVIEW_SHA256: ref('CaptureReviewSha256'),
    RECORDING_STORAGE_REVIEW_SHA256: ref('StorageReviewSha256'), RECORDING_RETENTION_REVIEW_SHA256: ref('RetentionReviewSha256') });
  const policy = template.Resources.Role.Properties.Policies[1]['Fn::If'][1];
  policy.PolicyName = 'ReviewedRecordingCapture';
  const prefix = sub('arn:${AWS::Partition}:s3:::${RecordingBucket}/encounter-recordings/${OrganizationId}/*');
  policy.PolicyDocument.Statement.push(
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: prefix,
      Condition: { StringEquals: { 's3:ResourceAccount': ref('AWS::AccountId') } } },
    { Effect: 'Allow', Action: 's3:PutObject', Resource: prefix, Condition: { Null: { 's3:if-none-match': 'false' }, StringEquals: {
      's3:ResourceAccount': ref('AWS::AccountId'), 's3:x-amz-server-side-encryption': 'aws:kms',
      's3:x-amz-server-side-encryption-aws-kms-key-id': ref('RecordingKmsKeyArn'),
    } } },
    { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:GenerateDataKey'], Resource: ref('RecordingKmsKeyArn'), Condition: {
      StringEquals: { 'kms:ViaService': sub('s3.${AWS::Region}.amazonaws.com'), 'kms:CallerAccount': ref('AWS::AccountId') },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': [sub('arn:${AWS::Partition}:s3:::${RecordingBucket}'), prefix] },
    } },
  );
  const route = template.Resources.Route, permission = template.Resources.Invoke;
  delete template.Resources.Route; delete template.Resources.Invoke;
  // Logical ids must be alphanumeric (cfn-lint E3001; CloudFormation refuses underscores), so each action is title-cased.
  for (const action of ['readiness', 'start', 'state', 'command', 'segment', 'reconcile']) {
    const logical = action[0].toUpperCase() + action.slice(1);
    template.Resources['Route' + logical] = { ...route, Properties: { ...route.Properties,
      RouteKey: 'POST /clinical-core/workforce/encounter-recording/' + action } };
    template.Resources['Invoke' + logical] = { ...permission, Properties: { ...permission.Properties,
      SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/encounter-recording/' + action) } };
  }
}
if (cleanupReview) {
  template.Parameters.CleanupReviewSha256 = hash;
  const vars = template.Resources.Function.Properties.Environment.Variables;
  delete vars.RECORDING_AUTHORITY_ACTIVATION; delete vars.RECORDING_AUTHORITY_EVIDENCE_SHA256;
  Object.assign(vars, { RECORDING_CLEANUP_REVIEW_ACTIVATION: ref('Activation'),
    RECORDING_CLEANUP_REVIEW_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'), RECORDING_CLEANUP_REVIEW_SHA256: ref('CleanupReviewSha256') });
  template.Resources.Role.Properties.Policies[1]['Fn::If'][1].PolicyName = 'ReviewedRecordingCleanupMetadata';
  template.Resources.Route.Properties.RouteKey = 'POST /clinical-core/workforce/encounter-recording/cleanup-review';
  template.Resources.Invoke.Properties.SourceArn = sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/encounter-recording/cleanup-review');
}
if (cleanupExecution) {
  Object.assign(template.Parameters, {
    CleanupReleaseId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    CleanupExecutionReviewSha256: hash, CleanupWorkerSha256: hash, StorageReviewSha256: hash, HoldCoordinationReviewSha256: hash,
    RecordingBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' },
    RecordingKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$' },
  });
  const vars=template.Resources.Function.Properties.Environment.Variables;
  delete vars.RECORDING_AUTHORITY_ACTIVATION; delete vars.RECORDING_AUTHORITY_EVIDENCE_SHA256;
  Object.assign(vars, { RECORDING_CLEANUP_EXECUTION_ACTIVATION: ref('Activation'),
    RECORDING_CLEANUP_EXECUTION_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'),
    RECORDING_CLEANUP_RELEASE_ID: ref('CleanupReleaseId'), RECORDING_CLEANUP_WORKER_SHA256: ref('CleanupWorkerSha256'),
    RECORDING_CLEANUP_EXECUTION_REVIEW_SHA256: ref('CleanupExecutionReviewSha256'),
    RECORDING_STORAGE_REVIEW_SHA256: ref('StorageReviewSha256'), RECORDING_HOLD_COORDINATION_REVIEW_SHA256: ref('HoldCoordinationReviewSha256'),
  });
  const policy=template.Resources.Role.Properties.Policies[1]['Fn::If'][1];
  policy.PolicyName='ReviewedRecordingCleanupExecution';
  const bucket=sub('arn:${AWS::Partition}:s3:::${RecordingBucket}');
  const prefix=sub('arn:${AWS::Partition}:s3:::${RecordingBucket}/encounter-recordings/${OrganizationId}/*');
  const owner={StringEquals:{'s3:ResourceAccount':ref('AWS::AccountId')}};
  policy.PolicyDocument.Statement.push(
    {Effect:'Allow',Action:['s3:GetBucketVersioning','s3:GetBucketObjectLockConfiguration'],Resource:bucket,Condition:owner},
    {Effect:'Allow',Action:'s3:ListBucketVersions',Resource:bucket,Condition:{...owner,StringLike:{'s3:prefix':sub('encounter-recordings/${OrganizationId}/*')}}},
    {Effect:'Allow',Action:['s3:GetObjectVersion','s3:GetObjectLegalHold','s3:GetObjectRetention','s3:DeleteObjectVersion'],Resource:prefix,Condition:owner},
    {Effect:'Allow',Action:['kms:Decrypt','kms:GenerateDataKey'],Resource:ref('RecordingKmsKeyArn'),Condition:{
      StringEquals:{'kms:ViaService':sub('s3.${AWS::Region}.amazonaws.com'),'kms:CallerAccount':ref('AWS::AccountId')},
      StringLike:{'kms:EncryptionContext:aws:s3:arn':[bucket,prefix]},
    }},
  );
  template.Resources.Route.Properties.RouteKey='POST /clinical-core/workforce/encounter-recording/cleanup-execution';
  template.Resources.Invoke.Properties.SourceArn=sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/encounter-recording/cleanup-execution');
}
if (transcription) {
  Object.assign(template.Parameters, {
    TranscriptionReleaseId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    TranscriptionReviewSha256: hash, ProviderReviewSha256: hash, StorageReviewSha256: hash,
    RecordingBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' },
    RecordingKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$' },
  });
  const vars = template.Resources.Function.Properties.Environment.Variables;
  delete vars.RECORDING_AUTHORITY_ACTIVATION; delete vars.RECORDING_AUTHORITY_EVIDENCE_SHA256;
  Object.assign(vars, { RECORDING_TRANSCRIPTION_ACTIVATION: ref('Activation'), RECORDING_TRANSCRIPTION_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'),
    RECORDING_TRANSCRIPTION_RELEASE_ID: ref('TranscriptionReleaseId'), RECORDING_TRANSCRIPTION_REVIEW_SHA256: ref('TranscriptionReviewSha256'),
    RECORDING_PROVIDER_REVIEW_SHA256: ref('ProviderReviewSha256'), RECORDING_STORAGE_REVIEW_SHA256: ref('StorageReviewSha256') });
  const policy = template.Resources.Role.Properties.Policies[1]['Fn::If'][1];
  policy.PolicyName = 'ReviewedRecordingTranscription';
  const bucket = sub('arn:${AWS::Partition}:s3:::${RecordingBucket}');
  const prefix = sub('arn:${AWS::Partition}:s3:::${RecordingBucket}/encounter-recordings/${OrganizationId}/*');
  const owner = { StringEquals: { 's3:ResourceAccount': ref('AWS::AccountId') } };
  policy.PolicyDocument.Statement.push(
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: prefix, Condition: owner },
    { Effect: 'Allow', Action: 's3:PutObject', Resource: prefix, Condition: { Null: { 's3:if-none-match': 'false' }, StringEquals: {
      's3:ResourceAccount': ref('AWS::AccountId'), 's3:x-amz-server-side-encryption': 'aws:kms',
      's3:x-amz-server-side-encryption-aws-kms-key-id': ref('RecordingKmsKeyArn') } } },
    { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:GenerateDataKey'], Resource: ref('RecordingKmsKeyArn'), Condition: {
      StringEquals: { 'kms:ViaService': sub('s3.${AWS::Region}.amazonaws.com'), 'kms:CallerAccount': ref('AWS::AccountId') },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': [bucket, prefix] } } },
    // The provider reads media and writes output through the same bucket and key; job names are prefixed per deployment.
    { Effect: 'Allow', Action: ['transcribe:StartTranscriptionJob', 'transcribe:GetTranscriptionJob'],
      Resource: sub('arn:${AWS::Partition}:transcribe:${AWS::Region}:${AWS::AccountId}:transcription-job/alp-*') },
  );
  template.Resources.Route.Properties.RouteKey = 'POST /clinical-core/workforce/encounter-recording/transcription';
  template.Resources.Invoke.Properties.SourceArn = sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/encounter-recording/transcription');
}
if (drafting) {
  Object.assign(template.Parameters, {
    DraftingReleaseId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    DraftingReviewSha256: hash, ProviderReviewSha256: hash, StorageReviewSha256: hash,
    RecordingBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' },
    RecordingKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]{36}$' },
    // The provider key is a separate reviewed secret; it is never the database secret.
    DraftingOpenAiSecretArn: { Type: 'String', AllowedPattern: '^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$' },
  });
  const vars = template.Resources.Function.Properties.Environment.Variables;
  delete vars.RECORDING_AUTHORITY_ACTIVATION; delete vars.RECORDING_AUTHORITY_EVIDENCE_SHA256;
  Object.assign(vars, { RECORDING_DRAFTING_ACTIVATION: ref('Activation'), RECORDING_DRAFTING_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'),
    RECORDING_DRAFTING_RELEASE_ID: ref('DraftingReleaseId'), RECORDING_DRAFTING_REVIEW_SHA256: ref('DraftingReviewSha256'),
    RECORDING_PROVIDER_REVIEW_SHA256: ref('ProviderReviewSha256'), RECORDING_STORAGE_REVIEW_SHA256: ref('StorageReviewSha256'),
    RECORDING_DRAFTING_OPENAI_SECRET_ARN: ref('DraftingOpenAiSecretArn') });
  const policy = template.Resources.Role.Properties.Policies[1]['Fn::If'][1];
  policy.PolicyName = 'ReviewedRecordingDrafting';
  const bucket = sub('arn:${AWS::Partition}:s3:::${RecordingBucket}');
  const prefix = sub('arn:${AWS::Partition}:s3:::${RecordingBucket}/encounter-recordings/${OrganizationId}/*');
  const owner = { StringEquals: { 's3:ResourceAccount': ref('AWS::AccountId') } };
  policy.PolicyDocument.Statement.push(
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: prefix, Condition: owner },
    { Effect: 'Allow', Action: 's3:PutObject', Resource: prefix, Condition: { Null: { 's3:if-none-match': 'false' }, StringEquals: {
      's3:ResourceAccount': ref('AWS::AccountId'), 's3:x-amz-server-side-encryption': 'aws:kms',
      's3:x-amz-server-side-encryption-aws-kms-key-id': ref('RecordingKmsKeyArn') } } },
    { Effect: 'Allow', Action: ['kms:Decrypt', 'kms:GenerateDataKey'], Resource: ref('RecordingKmsKeyArn'), Condition: {
      StringEquals: { 'kms:ViaService': sub('s3.${AWS::Region}.amazonaws.com'), 'kms:CallerAccount': ref('AWS::AccountId') },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': [bucket, prefix] } } },
    { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('DraftingOpenAiSecretArn'), Condition: { StringEquals: { 'aws:ResourceAccount': ref('AWS::AccountId') } } },
    { Effect: 'Allow', Action: 'kms:Decrypt', Resource: ref('SecretKmsKeyArn'), Condition: { StringEquals: { 'kms:ViaService': sub('secretsmanager.${AWS::Region}.amazonaws.com'),
      'kms:CallerAccount': ref('AWS::AccountId'), 'kms:EncryptionContext:SecretARN': ref('DraftingOpenAiSecretArn') } } },
  );
  template.Resources.Route.Properties.RouteKey = 'POST /clinical-core/workforce/encounter-recording/drafting';
  template.Resources.Invoke.Properties.SourceArn = sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/workforce/encounter-recording/drafting');
}
for (const metric of ["Errors", "Throttles"]) template.Resources[metric + "Alarm"] = { Type: "AWS::CloudWatch::Alarm", Properties: {
  Namespace: "AWS/Lambda", MetricName: metric, Dimensions: [{ Name: "FunctionName", Value: ref("Function") }], Statistic: "Sum", Period: 60,
  EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
  AlarmActions: { "Fn::If": ["HasAlarmRecipient", [ref("AlarmTopicArn")], ref("AWS::NoValue")] },
} };
template.Resources.ApiFailureAlarm = { Type: "AWS::CloudWatch::Alarm", Properties: { ...template.Resources.ErrorsAlarm.Properties,
  Namespace: "AWS/ApiGateway", MetricName: "5xx", Dimensions: [{ Name: "ApiId", Value: ref("ApiId") }],
} };
writeFileSync(out + "/template.json", JSON.stringify(template, null, 2));
if (splitRuntime) writeFileSync(out + '/artifact-manifest.json', JSON.stringify({ contract: `${suffix}-artifact/1`,
  files: ['index.js', `${suffix}-runtime.js`, 'template.json'].map(path => {
    const bytes = readFileSync(out + '/' + path);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }),
}, null, 2));
console.log(`Built ${suffix} candidate; no deployment or activation.`);
