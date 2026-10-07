/** Build a default-blocked deployment candidate. Never deploys or signs reviews. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { careMessagingZip } from './care-messaging-zip.mjs';
import { qualificationConditions, qualificationEnvironment, qualificationParameters, qualificationRules } from './qualification-execution-template.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw new Error('care_message_build_argument_invalid');
const out = args.length ? resolve(args[0].slice(10)) : 'dist/aws-clinical-core/care-messaging';
const sha = value => createHash('sha256').update(value).digest('hex');
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], {
  encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
}));
const migrationReleaseSha256 = sha(artifact.manifest.migrations.map(m => `${m.version}:${sha(artifact.files[m.file])}`).join('\n'));
if (artifact.manifest.migrations.length !== 106 || migrationReleaseSha256 !== '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b') throw new Error('care_message_build_release_invalid');
const sql = artifact.files['20261006010000_production_care_messaging.sql'];
const functions = [...sql.matchAll(/create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
  .map(([, schema, name, body]) => ({ schema, name, sha256: sha(body), callable: schema === 'clinical_core' }));
if (functions.length !== 7 || new Set(functions.map(f => f.name)).size !== 7) throw new Error('care_message_build_contract_invalid');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/care-messaging-lambda.ts'], outfile: `${out}/index.js`, bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none',
  define: { __CARE_MESSAGING_BUILD__: JSON.stringify({ sourceCommit, sourceClean, migrationCount: 106, migrationReleaseSha256, functions }) } });
const ref = name => ({ Ref: name }), sub = value => ({ 'Fn::Sub': value });
const nonempty = name => ({ 'Fn::Not': [{ 'Fn::Equals': [ref(name), ''] }] });
const hash = { Type: 'String', Default: '', AllowedPattern: '^$|^[a-f0-9]{64}$' };
const reviewed = ['DatabaseReviewSha256', 'WorkforceMfaReviewSha256', 'MessagingReviewSha256', 'RetentionReviewSha256', 'AlarmTopicArn'];
const required = ['ActivationEvidenceSha256', ...reviewed];
const template = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Artifact-bound retained care messaging; blocked/logs-only by default; no reviews seeded',
  Parameters: {
    ApiId: { Type: 'String', AllowedPattern: '^[a-z0-9]{10}$' },
    ConsumerIssuer: { Type: 'String', AllowedPattern: '^https://cognito-idp\\.us-east-2\\.amazonaws\\.com/us-east-2_[A-Za-z0-9]+$' },
    WorkforceIssuer: { Type: 'String', AllowedPattern: '^https://cognito-idp\\.us-east-2\\.amazonaws\\.com/us-east-2_[A-Za-z0-9]+$' },
    ConsumerAudience: { Type: 'String', AllowedPattern: '^[a-zA-Z0-9]{20,128}$' }, WorkforceAudience: { Type: 'String', AllowedPattern: '^[a-zA-Z0-9]{20,128}$' },
    OrganizationId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    PhiAllowed: { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'] },
    Activation: { Type: 'String', Default: 'blocked', AllowedValues: ['blocked', 'approved'] },
    ActivationEvidenceSha256: hash, DatabaseReviewSha256: hash, WorkforceMfaReviewSha256: hash, MessagingReviewSha256: hash, RetentionReviewSha256: hash,
    DatabaseClusterArn: { Type: 'String', AllowedPattern: '^arn:aws:rds:us-east-2:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$' },
    DatabaseSecretArn: { Type: 'String', AllowedPattern: '^arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$' },
    DatabaseName: { Type: 'String', AllowedPattern: '^[a-z][a-z0-9_]{0,62}$' },
    SecretKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:us-east-2:[0-9]{12}:key/[a-f0-9-]{36}$' },
    LogsKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:us-east-2:[0-9]{12}:key/[a-f0-9-]{36}$' },
    AlarmTopicArn: { Type: 'String', Default: '', AllowedPattern: '^$|^arn:aws:sns:us-east-2:[0-9]{12}:[A-Za-z0-9_-]+$' },
    CodeBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' },
    CodeKey: { Type: 'String', AllowedPattern: '^[A-Za-z0-9/_.-]{1,1024}$' },
    CodeVersion: { Type: 'String', MinLength: 1, MaxLength: 1024, AllowedPattern: '^(?!null$).+$' },
    SourceCommit: { Type: 'String', AllowedValues: [sourceCommit] }, MigrationReleaseSha256: { Type: 'String', AllowedValues: [migrationReleaseSha256] },
    ...qualificationParameters(),
  },
  Conditions: {
    Active: { 'Fn::And': [{ 'Fn::Equals': [ref('PhiAllowed'), 'true'] }, { 'Fn::Equals': [ref('Activation'), 'approved'] },
      { 'Fn::Equals': [ref('AWS::AccountId'), '173535830222'] }, { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] }, ...required.map(nonempty)] },
    ...qualificationConditions(reviewed), HasAlarmRecipient: nonempty('AlarmTopicArn'),
  },
  Rules: {
    ...qualificationRules({ extra: reviewed.map(name => ({ Assert: nonempty(name), AssertDescription: `${name} required for qualification` })) }),
    ReviewedProduction: { RuleCondition: { 'Fn::Equals': [ref('PhiAllowed'), 'true'] }, Assertions: [
      { Assert: { 'Fn::Equals': [ref('Activation'), 'approved'] }, AssertDescription: 'Separate production activation required' },
      ...required.map(name => ({ Assert: nonempty(name), AssertDescription: `${name} required for production` })),
    ] },
    SeparateIdentities: { Assertions: [
      { Assert: { 'Fn::Not': [{ 'Fn::Equals': [ref('ConsumerIssuer'), ref('WorkforceIssuer')] }] }, AssertDescription: 'Separate workforce and consumer pools required' },
      { Assert: { 'Fn::Not': [{ 'Fn::Equals': [ref('ConsumerAudience'), ref('WorkforceAudience')] }] }, AssertDescription: 'Separate app clients required' },
    ] },
  },
  Resources: {
    Logs: { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      LogGroupName: sub('/aws/lambda/${ApiId}-care-messaging'), KmsKeyId: ref('LogsKmsKeyArn'), RetentionInDays: 30,
    } },
    Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } },
    ] }, Policies: [
      { PolicyName: 'bounded-logs', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::GetAtt': ['Logs', 'Arn'] } },
      ] } },
      { 'Fn::If': ['Enabled', { PolicyName: 'reviewed-care-messaging', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction', 'rds-data:ExecuteStatement'], Resource: ref('DatabaseClusterArn') },
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('DatabaseSecretArn') },
        { Effect: 'Allow', Action: 'kms:Decrypt', Resource: ref('SecretKmsKeyArn'), Condition: { StringEquals: {
          'kms:ViaService': sub('secretsmanager.${AWS::Region}.amazonaws.com'), 'kms:CallerAccount': ref('AWS::AccountId'), 'kms:EncryptionContext:SecretARN': ref('DatabaseSecretArn'),
        } } },
      ] } }, ref('AWS::NoValue')] },
    ] } },
    Function: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: sub('${ApiId}-care-messaging'), Runtime: 'nodejs22.x', Handler: 'index.handler',
      Role: { 'Fn::GetAtt': ['Role', 'Arn'] }, Timeout: 29, MemorySize: 256, ReservedConcurrentExecutions: 2,
      Code: { S3Bucket: ref('CodeBucket'), S3Key: ref('CodeKey'), S3ObjectVersion: ref('CodeVersion') }, LoggingConfig: { LogGroup: ref('Logs') },
      Environment: { Variables: {
        CONSUMER_ISSUER: ref('ConsumerIssuer'), CONSUMER_AUDIENCE: ref('ConsumerAudience'), WORKFORCE_ISSUER: ref('WorkforceIssuer'), WORKFORCE_AUDIENCE: ref('WorkforceAudience'),
        CARE_MESSAGING_ORGANIZATION_ID: ref('OrganizationId'), PHI_ALLOWED: ref('PhiAllowed'), CARE_MESSAGING_ACTIVATION: ref('Activation'),
        CARE_MESSAGING_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'), DATABASE_REVIEW_SHA256: ref('DatabaseReviewSha256'),
        WORKFORCE_MFA_REVIEW_SHA256: ref('WorkforceMfaReviewSha256'), MESSAGING_REVIEW_SHA256: ref('MessagingReviewSha256'), RETENTION_REVIEW_SHA256: ref('RetentionReviewSha256'),
        CLINICAL_DATABASE_CLUSTER_ARN: ref('DatabaseClusterArn'), CLINICAL_DATABASE_SECRET_ARN: ref('DatabaseSecretArn'), CLINICAL_DATABASE_NAME: ref('DatabaseName'),
        SOURCE_COMMIT: ref('SourceCommit'), MIGRATION_RELEASE_SHA256: ref('MigrationReleaseSha256'), DEPLOYMENT_ACCOUNT_ID: ref('AWS::AccountId'),
        ...qualificationEnvironment(),
      } },
    } },
    Integration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: { ApiId: ref('ApiId'), IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0',
      IntegrationUri: { 'Fn::GetAtt': ['Function', 'Arn'] }, TimeoutInMillis: 30000 } },
    Errors: { Type: 'AWS::CloudWatch::Alarm', Properties: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: ref('Function') }],
      Statistic: 'Sum', Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
      ActionsEnabled: { 'Fn::If': ['Enabled', true, false] }, AlarmActions: { 'Fn::If': ['HasAlarmRecipient', [ref('AlarmTopicArn')], ref('AWS::NoValue')] } } },
    ApiServerErrors: { Type: 'AWS::CloudWatch::Alarm', Properties: { Namespace: 'AWS/ApiGateway', MetricName: '5xx', Dimensions: [{ Name: 'ApiId', Value: ref('ApiId') }],
      Statistic: 'Sum', Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
      ActionsEnabled: { 'Fn::If': ['Enabled', true, false] }, AlarmActions: { 'Fn::If': ['HasAlarmRecipient', [ref('AlarmTopicArn')], ref('AWS::NoValue')] } } },
  },
  Outputs: { PhiAllowed: { Value: ref('PhiAllowed') }, Activation: { Value: ref('Activation') }, SourceCommit: { Value: ref('SourceCommit') },
    MigrationReleaseSha256: { Value: ref('MigrationReleaseSha256') }, DatabaseName: { Value: ref('DatabaseName') },
    QualificationExecution: { Value: { 'Fn::If': ['Qualification', 'enabled', 'disabled'] } }, FunctionName: { Value: ref('Function') } },
};
template.Conditions.QualificationPosture['Fn::And'].push(
  { 'Fn::Equals': [ref('AWS::AccountId'), '588966314750'] }, { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] });
for (const pool of ['Consumer', 'Workforce']) template.Resources[`${pool}Authorizer`] = {
  Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { ApiId: ref('ApiId'), Name: sub(`\${ApiId}-care-messaging-${pool.toLowerCase()}`), AuthorizerType: 'JWT',
    IdentitySource: ['$request.header.Authorization'], JwtConfiguration: { Issuer: ref(`${pool}Issuer`), Audience: [ref(`${pool}Audience`)] } },
};
for (const [name, pool, path] of [['ConsumerMessages', 'Consumer', 'consumer/messages'], ['WorkforceMessages', 'Workforce', 'workforce/messages'], ['ConsumerExport', 'Consumer', 'consumer/messages/export']]) {
  template.Resources[`Route${name}`] = { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: ref('ApiId'), RouteKey: `POST /clinical-core/${path}`,
    AuthorizationType: 'JWT', AuthorizerId: ref(`${pool}Authorizer`), Target: { 'Fn::Join': ['/', ['integrations', ref('Integration')]] } } };
  template.Resources[`Invoke${name}`] = { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('Function'), Action: 'lambda:InvokeFunction',
    Principal: 'apigateway.amazonaws.com', SourceAccount: ref('AWS::AccountId'), SourceArn: sub(`arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${ApiId}/*/POST/clinical-core/${path}`) } };
}
writeFileSync(`${out}/template.json`, JSON.stringify(template, null, 2) + '\n');
const zip=careMessagingZip(readFileSync(`${out}/index.js`));
writeFileSync(`${out}/deployment.zip`,zip);
writeFileSync(`${out}/artifact-manifest.json`, JSON.stringify({ contract: 'care-messaging-deployment/1', sourceCommit, sourceClean,
  migrationCount: 106, migrationReleaseSha256, codeSha256: sha(readFileSync(`${out}/index.js`)), templateSha256: sha(readFileSync(`${out}/template.json`)),
  deploymentZipSha256:sha(zip), deploymentZipBytes:zip.length,
  functions, defaults: { phiAllowed: false, activation: 'blocked', qualification: 'disabled' }, deploymentPerformed: false,
  remaining: ['independent reviews', 'hosted target/operator binding and acceptance', 'clinic lifecycle/amendments', 'V2 production wiring', 'device acceptance'] }, null, 2) + '\n');
console.log('Built care messaging deployment candidate: artifact-pinned, blocked/logs-only by default. No AWS access or activation.');
