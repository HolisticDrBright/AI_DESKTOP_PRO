import { qualificationParameters, qualificationConditions, qualificationEnvironment, qualificationRules } from './qualification-execution-template.mjs';
const ref = name => ({ Ref: name }), sub = value => ({ 'Fn::Sub': value });
const eq = (a, b) => ({ 'Fn::Equals': [a, b] });
const nonempty = name => ({ 'Fn::Not': [eq(ref(name), '')] });
const hash = { Type: 'String', Default: '', AllowedPattern: '^$|^[a-f0-9]{64}$' };
export function telehealthConsentTemplate(build, codeSha256) {
  if (!build || !/^[a-f0-9]{40}$/.test(build.sourceCommit) || typeof build.sourceClean !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(build.sourceInputSha256) || build.migrationCount !== 112
    || build.migrationReleaseSha256 !== '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4'
    || !/^[A-Za-z0-9+/]{43}=$/.test(codeSha256)) throw Error('telehealth_consent_template_binding_refused');
  const reviewed = ['DatabaseReviewSha256', 'WorkforceMfaReviewSha256', 'ConnectionReviewSha256',
    'ConsentReviewSha256', 'RetentionReviewSha256', 'AlarmTopicArn', 'ConfigurationSha256'];
  const q = qualificationConditions(reviewed);
  q.QualificationPosture['Fn::And'].push(eq(ref('AWS::AccountId'), '588966314750'), eq(ref('AWS::Region'), 'us-east-2'),
    eq(ref('DatabaseName'), 'clinical_core_qualification'));
  // Split review sets into named conditions; every Fn::And stays <=10 operands.
  q.Qualification = { 'Fn::And': [{ Condition: 'QualificationPosture' }, { Condition: 'ReviewedConfiguration' },
    { Condition: 'ArtifactMatches' }, nonempty('QualificationReviewSha256'), nonempty('QualificationIdentitySubjects')] };
  const template = {
    AWSTemplateFormatVersion: '2010-09-09', Description: 'Separate 112 exact-copy patient consent service; blocked/logs-only by default; no approvals seeded',
    Parameters: {
      ApiId: { Type: 'String', AllowedPattern: '^[a-z0-9]{10}$' },
      ConsumerIssuer: { Type: 'String', AllowedPattern: '^https://cognito-idp\\.us-east-2\\.amazonaws\\.com/us-east-2_[A-Za-z0-9]+$' },
      WorkforceIssuer: { Type: 'String', AllowedPattern: '^https://cognito-idp\\.us-east-2\\.amazonaws\\.com/us-east-2_[A-Za-z0-9]+$' },
      ConsumerAudience: { Type: 'String', AllowedPattern: '^[A-Za-z0-9]{20,128}$' }, WorkforceAudience: { Type: 'String', AllowedPattern: '^[A-Za-z0-9]{20,128}$' },
      OrganizationId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
      PhiAllowed: { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'] },
      Activation: { Type: 'String', Default: 'blocked', AllowedValues: ['blocked', 'approved'] },
      ConsentEnabled: { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'] },
      ActivationEvidenceSha256: hash, DatabaseReviewSha256: hash, WorkforceMfaReviewSha256: hash,
      ConnectionReviewSha256: hash, ConsentReviewSha256: hash, RetentionReviewSha256: hash, ConfigurationSha256: hash,
      DatabaseClusterArn: { Type: 'String', AllowedPattern: '^arn:aws:rds:us-east-2:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$' },
      DatabaseSecretArn: { Type: 'String', AllowedPattern: '^arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$' },
      DatabaseName: { Type: 'String', AllowedValues: ['clinical_core', 'clinical_core_qualification'] },
      SecretKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:us-east-2:[0-9]{12}:key/[a-f0-9-]{36}$' },
      LogsKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:us-east-2:[0-9]{12}:key/[a-f0-9-]{36}$' },
      AlarmTopicArn: { Type: 'String', Default: '', AllowedPattern: '^$|^arn:aws:sns:us-east-2:[0-9]{12}:[A-Za-z0-9_-]+$' },
      CodeBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' },
      CodeKey: { Type: 'String', AllowedPattern: '^[A-Za-z0-9/_.-]{1,1024}$' },
      CodeVersion: { Type: 'String', MinLength: 1, MaxLength: 1024, AllowedPattern: '^(?!null$).+$' },
      SourceCommit: { Type: 'String', AllowedValues: [build.sourceCommit] },
      SourceClean: { Type: 'String', Default: String(build.sourceClean), AllowedValues: [String(build.sourceClean)] },
      SourceInputSha256: { Type: 'String', AllowedValues: [build.sourceInputSha256] },
      MigrationReleaseSha256: { Type: 'String', AllowedValues: [build.migrationReleaseSha256] },
      ...qualificationParameters(),
    },
    Conditions: {
      ReviewedConfiguration: { 'Fn::And': reviewed.map(nonempty) },
      ArtifactMatches: { 'Fn::And': [eq(ref('SourceCommit'), build.sourceCommit), eq(ref('SourceInputSha256'), build.sourceInputSha256),
        eq(ref('MigrationReleaseSha256'), build.migrationReleaseSha256), eq(ref('SourceClean'), 'true')] },
      Active: { 'Fn::And': [eq(ref('PhiAllowed'), 'true'), eq(ref('Activation'), 'approved'),
        eq(ref('AWS::AccountId'), '173535830222'), eq(ref('AWS::Region'), 'us-east-2'), eq(ref('DatabaseName'), 'clinical_core'),
        { Condition: 'ReviewedConfiguration' }, { Condition: 'ArtifactMatches' }, nonempty('ActivationEvidenceSha256')] },
      ...q, HasAlarmRecipient: nonempty('AlarmTopicArn'),
    },
    Rules: {
      ...qualificationRules({ extra: [...reviewed.map(name => ({ Assert: nonempty(name), AssertDescription: `${name} independently required` })),
        { Assert: eq(ref('DatabaseName'), 'clinical_core_qualification'), AssertDescription: 'Isolated qualification database only' },
        { Assert: eq(ref('AWS::AccountId'), '588966314750'), AssertDescription: 'Synthetic account only' },
        { Assert: eq(ref('AWS::Region'), 'us-east-2'), AssertDescription: 'Ohio only' },
        { Assert: eq(ref('SourceClean'), 'true'), AssertDescription: 'Clean exact-source build required' }] }),
      ReviewedProduction: { RuleCondition: eq(ref('PhiAllowed'), 'true'), Assertions: [
        { Assert: eq(ref('Activation'), 'approved'), AssertDescription: 'Separate production activation required' },
        { Assert: eq(ref('DatabaseName'), 'clinical_core'), AssertDescription: 'Production database only' },
        ...['ActivationEvidenceSha256', ...reviewed].map(name => ({ Assert: nonempty(name), AssertDescription: `${name} required` })),
      ] },
      SeparateIdentities: { Assertions: ['Issuer', 'Audience'].map(suffix => ({
        Assert: { 'Fn::Not': [eq(ref(`Consumer${suffix}`), ref(`Workforce${suffix}`))] }, AssertDescription: 'Separate consumer and workforce identities required' })) },
    },
    Resources: {
      Logs: { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
        LogGroupName: sub('/aws/lambda/${ApiId}-telehealth-consent'), KmsKeyId: ref('LogsKmsKeyArn'), RetentionInDays: 30 } },
      Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] }, Policies: [
        { PolicyName: 'bounded-logs', PolicyDocument: { Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::GetAtt': ['Logs', 'Arn'] } }] } },
        { 'Fn::If': ['Enabled', { PolicyName: 'reviewed-consent', PolicyDocument: { Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Action: ['rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction', 'rds-data:ExecuteStatement'], Resource: ref('DatabaseClusterArn') },
          { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('DatabaseSecretArn') },
          { Effect: 'Allow', Action: 'kms:Decrypt', Resource: ref('SecretKmsKeyArn'), Condition: { StringEquals: {
            'kms:ViaService': sub('secretsmanager.${AWS::Region}.amazonaws.com'), 'kms:CallerAccount': ref('AWS::AccountId'),
            'kms:EncryptionContext:SecretARN': ref('DatabaseSecretArn') } } },
        ] } }, ref('AWS::NoValue')] },
      ] } },
      Function: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: sub('${ApiId}-telehealth-consent'),
        Runtime: 'nodejs22.x', Handler: 'index.handler', Role: { 'Fn::GetAtt': ['Role', 'Arn'] }, Timeout: 29, MemorySize: 256,
        ReservedConcurrentExecutions: 2, LoggingConfig: { LogGroup: ref('Logs') },
        Code: { S3Bucket: ref('CodeBucket'), S3Key: ref('CodeKey'), S3ObjectVersion: ref('CodeVersion') },
        Environment: { Variables: {
          CONSUMER_ISSUER: ref('ConsumerIssuer'), CONSUMER_AUDIENCE: ref('ConsumerAudience'),
          WORKFORCE_ISSUER: ref('WorkforceIssuer'), WORKFORCE_AUDIENCE: ref('WorkforceAudience'),
          TELEHEALTH_CONSENT_ORGANIZATION_ID: ref('OrganizationId'), TELEHEALTH_CONSENT_ENABLED: ref('ConsentEnabled'),
          PHI_ALLOWED: ref('PhiAllowed'), TELEHEALTH_CONSENT_ACTIVATION: ref('Activation'),
          TELEHEALTH_CONSENT_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'), TELEHEALTH_CONSENT_CONFIGURATION_SHA256: ref('ConfigurationSha256'),
          DATABASE_REVIEW_SHA256: ref('DatabaseReviewSha256'), WORKFORCE_MFA_REVIEW_SHA256: ref('WorkforceMfaReviewSha256'),
          CONNECTION_REVIEW_SHA256: ref('ConnectionReviewSha256'), CONSENT_REVIEW_SHA256: ref('ConsentReviewSha256'), RETENTION_REVIEW_SHA256: ref('RetentionReviewSha256'),
          CLINICAL_DATABASE_CLUSTER_ARN: ref('DatabaseClusterArn'), CLINICAL_DATABASE_SECRET_ARN: ref('DatabaseSecretArn'), CLINICAL_DATABASE_NAME: ref('DatabaseName'),
          SOURCE_COMMIT: ref('SourceCommit'), SOURCE_INPUT_SHA256: ref('SourceInputSha256'), MIGRATION_RELEASE_SHA256: ref('MigrationReleaseSha256'),
          DEPLOYMENT_ACCOUNT_ID: ref('AWS::AccountId'), ...qualificationEnvironment(),
        } },
      } },
      Published: { Type: 'AWS::Lambda::Version', Properties: { FunctionName: ref('Function'), CodeSha256: codeSha256,
        Description: sub('${SourceCommit}:${ConfigurationSha256}') } },
      Integration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: { ApiId: ref('ApiId'), IntegrationType: 'AWS_PROXY',
        PayloadFormatVersion: '2.0', IntegrationUri: ref('Published'), TimeoutInMillis: 30000 } },
      ConsumerAuthorizer: { Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { ApiId: ref('ApiId'),
        Name: sub('${ApiId}-telehealth-consent-consumer'), AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
        JwtConfiguration: { Issuer: ref('ConsumerIssuer'), Audience: [ref('ConsumerAudience')] } } },
      Route: { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: ref('ApiId'), RouteKey: 'POST /clinical-core/consumer/telehealth-consent',
        AuthorizationType: 'JWT', AuthorizerId: ref('ConsumerAuthorizer'), Target: { 'Fn::Join': ['/', ['integrations', ref('Integration')]] } } },
      Invoke: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('Published'), Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com', SourceAccount: ref('AWS::AccountId'),
        SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/consumer/telehealth-consent') } },
      Errors: { Type: 'AWS::CloudWatch::Alarm', Properties: { Namespace: 'AWS/Lambda', MetricName: 'Errors',
        Dimensions: [{ Name: 'FunctionName', Value: ref('Function') }], Statistic: 'Sum', Period: 60, EvaluationPeriods: 1,
        Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
        ActionsEnabled: { 'Fn::If': ['Enabled', true, false] }, AlarmActions: { 'Fn::If': ['HasAlarmRecipient', [ref('AlarmTopicArn')], ref('AWS::NoValue')] } } },
      ApiServerErrors: { Type: 'AWS::CloudWatch::Alarm', Properties: { Namespace: 'AWS/ApiGateway', MetricName: '5xx',
        Dimensions: [{ Name: 'ApiId', Value: ref('ApiId') }], Statistic: 'Sum', Period: 60, EvaluationPeriods: 1,
        Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
        ActionsEnabled: { 'Fn::If': ['Enabled', true, false] }, AlarmActions: { 'Fn::If': ['HasAlarmRecipient', [ref('AlarmTopicArn')], ref('AWS::NoValue')] } } },
    },
    Outputs: { PhiAllowed: { Value: ref('PhiAllowed') }, Activation: { Value: ref('Activation') }, SourceCommit: { Value: ref('SourceCommit') },
      SourceInputSha256: { Value: ref('SourceInputSha256') }, MigrationReleaseSha256: { Value: ref('MigrationReleaseSha256') },
      ConfigurationSha256: { Value: ref('ConfigurationSha256') }, FunctionVersionArn: { Value: ref('Published') }, DatabaseName: { Value: ref('DatabaseName') },
      QualificationExecution: { Value: { 'Fn::If': ['Qualification', 'enabled', 'disabled'] } } },
  };
  return template;
}
