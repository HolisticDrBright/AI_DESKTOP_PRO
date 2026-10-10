/** Build the default-blocked clinic-records deployment candidate: compiled handler, deterministic zip, CloudFormation template
 * with separate JWT authorizers and exact-resource permissions, and an artifact manifest. Never deploys, registers or signs reviews. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { careMessagingZip } from './care-messaging-zip.mjs';
import { qualificationConditions, qualificationEnvironment, qualificationParameters, qualificationRules } from './qualification-execution-template.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || args.length && !/^--out-dir=.+$/.test(args[0])) throw new Error('clinic_records_build_argument_invalid');
const out = args.length ? resolve(args[0].slice(10)) : 'dist/aws-clinical-core/clinic-records';
const sha = value => createHash('sha256').update(value).digest('hex');
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'], {
  encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
}));
const c = artifact.candidate;
if (c.contract !== 'clinic-record-privacy-candidate/2' || c.migrationCount !== 114 || artifact.manifest.migrations.length !== 114
  || c.activation !== 'blocked' || c.phiAllowed !== false || c.deployment !== 'not_deployed' || c.seededDisclosureReleases !== false) throw new Error('clinic_records_build_release_invalid');
const sql = artifact.files[artifact.manifest.migrations[113].file];
const match = /create function clinical_core\.clinic_record_request\(_request jsonb\) returns jsonb\nlanguage plpgsql security definer set search_path='' as \$\$([^]*?)\$\$;/.exec(sql);
if (!match || sha(sql) !== c.extensionSha256) throw new Error('clinic_records_build_contract_invalid');
export const dispatcher = { schema: 'clinical_core', name: 'clinic_record_request', sha256: sha(match[1]) };
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const buildInfo = { sourceCommit, sourceClean, migrationCount: 114, migrationReleaseSha256: c.migrationReleaseSha256, extensionSha256: c.extensionSha256, dispatcher };
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/clinic-records-lambda.ts'], outfile: `${out}/index.js`, bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none',
  define: { __CLINIC_RECORDS_BUILD__: JSON.stringify(buildInfo) } });
const ref = name => ({ Ref: name }), sub = value => ({ 'Fn::Sub': value });
const nonempty = name => ({ 'Fn::Not': [{ 'Fn::Equals': [ref(name), ''] }] });
const hashParameter = { Type: 'String', Default: '', AllowedPattern: '^$|^[a-f0-9]{64}$' };
const reviewed = ['DatabaseReviewSha256', 'WorkforceMfaReviewSha256', 'DisclosureReviewSha256', 'RetentionReviewSha256', 'AlarmTopicArn'];
const required = ['ActivationEvidenceSha256', ...reviewed];
const routes = [['ConsumerClinicRecords', 'Consumer', 'consumer/clinic-records'], ['WorkforceClinicRecords', 'Workforce', 'workforce/clinic-records']];
const template = {
  AWSTemplateFormatVersion: '2010-09-09', Description: 'Artifact-bound clinic-record privacy routes (patient copies and corrections); blocked by default; no release, review or activation seeded',
  Parameters: {
    ApiId: { Type: 'String', AllowedPattern: '^[a-z0-9]{10}$' },
    ConsumerIssuer: { Type: 'String', AllowedPattern: '^https://cognito-idp\\.us-east-2\\.amazonaws\\.com/us-east-2_[A-Za-z0-9]+$' },
    WorkforceIssuer: { Type: 'String', AllowedPattern: '^https://cognito-idp\\.us-east-2\\.amazonaws\\.com/us-east-2_[A-Za-z0-9]+$' },
    ConsumerAudience: { Type: 'String', AllowedPattern: '^[a-zA-Z0-9]{20,128}$' }, WorkforceAudience: { Type: 'String', AllowedPattern: '^[a-zA-Z0-9]{20,128}$' },
    OrganizationId: { Type: 'String', AllowedPattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
    PhiAllowed: { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'] },
    Activation: { Type: 'String', Default: 'blocked', AllowedValues: ['blocked', 'approved'] },
    ActivationEvidenceSha256: hashParameter, DatabaseReviewSha256: hashParameter, WorkforceMfaReviewSha256: hashParameter,
    DisclosureReviewSha256: hashParameter, RetentionReviewSha256: hashParameter,
    DatabaseClusterArn: { Type: 'String', AllowedPattern: '^arn:aws:rds:us-east-2:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$' },
    DatabaseSecretArn: { Type: 'String', AllowedPattern: '^arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$' },
    DatabaseName: { Type: 'String', AllowedPattern: '^[a-z][a-z0-9_]{0,62}$' },
    SecretKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:us-east-2:[0-9]{12}:key/[a-f0-9-]{36}$' },
    LogsKmsKeyArn: { Type: 'String', AllowedPattern: '^arn:aws:kms:us-east-2:[0-9]{12}:key/[a-f0-9-]{36}$' },
    AlarmTopicArn: { Type: 'String', Default: '', AllowedPattern: '^$|^arn:aws:sns:us-east-2:[0-9]{12}:[A-Za-z0-9_-]+$' },
    CodeBucket: { Type: 'String', AllowedPattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' },
    CodeKey: { Type: 'String', AllowedPattern: '^[A-Za-z0-9/_.-]{1,1024}$' },
    CodeVersion: { Type: 'String', MinLength: 1, MaxLength: 1024, AllowedPattern: '^(?!null$).+$' },
    SourceCommit: { Type: 'String', AllowedValues: [sourceCommit] }, MigrationReleaseSha256: { Type: 'String', AllowedValues: [c.migrationReleaseSha256] },
    ClinicRecordsExtensionSha256: { Type: 'String', AllowedValues: [c.extensionSha256] },
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
      LogGroupName: sub('/aws/lambda/${ApiId}-clinic-records'), KmsKeyId: ref('LogsKmsKeyArn'), RetentionInDays: 30,
    } },
    Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } },
    ] }, Policies: [
      { PolicyName: 'bounded-logs', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: { 'Fn::GetAtt': ['Logs', 'Arn'] } },
      ] } },
      { 'Fn::If': ['Enabled', { PolicyName: 'reviewed-clinic-records', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction', 'rds-data:ExecuteStatement'], Resource: ref('DatabaseClusterArn') },
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('DatabaseSecretArn') },
        { Effect: 'Allow', Action: 'kms:Decrypt', Resource: ref('SecretKmsKeyArn'), Condition: { StringEquals: {
          'kms:ViaService': sub('secretsmanager.${AWS::Region}.amazonaws.com'), 'kms:CallerAccount': ref('AWS::AccountId'), 'kms:EncryptionContext:SecretARN': ref('DatabaseSecretArn'),
        } } },
      ] } }, ref('AWS::NoValue')] },
    ] } },
    Function: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: sub('${ApiId}-clinic-records'), Runtime: 'nodejs22.x', Handler: 'index.handler',
      Role: { 'Fn::GetAtt': ['Role', 'Arn'] }, Timeout: 29, MemorySize: 256, ReservedConcurrentExecutions: 2,
      Code: { S3Bucket: ref('CodeBucket'), S3Key: ref('CodeKey'), S3ObjectVersion: ref('CodeVersion') }, LoggingConfig: { LogGroup: ref('Logs') },
      Environment: { Variables: {
        CONSUMER_ISSUER: ref('ConsumerIssuer'), CONSUMER_AUDIENCE: ref('ConsumerAudience'), WORKFORCE_ISSUER: ref('WorkforceIssuer'), WORKFORCE_AUDIENCE: ref('WorkforceAudience'),
        CLINIC_RECORDS_ORGANIZATION_ID: ref('OrganizationId'), PHI_ALLOWED: ref('PhiAllowed'), CLINIC_RECORDS_ACTIVATION: ref('Activation'),
        CLINIC_RECORDS_EVIDENCE_SHA256: ref('ActivationEvidenceSha256'), DATABASE_REVIEW_SHA256: ref('DatabaseReviewSha256'),
        WORKFORCE_MFA_REVIEW_SHA256: ref('WorkforceMfaReviewSha256'), DISCLOSURE_REVIEW_SHA256: ref('DisclosureReviewSha256'), RETENTION_REVIEW_SHA256: ref('RetentionReviewSha256'),
        CLINICAL_DATABASE_CLUSTER_ARN: ref('DatabaseClusterArn'), CLINICAL_DATABASE_SECRET_ARN: ref('DatabaseSecretArn'), CLINICAL_DATABASE_NAME: ref('DatabaseName'),
        SOURCE_COMMIT: ref('SourceCommit'), MIGRATION_RELEASE_SHA256: ref('MigrationReleaseSha256'), CLINIC_RECORDS_EXTENSION_SHA256: ref('ClinicRecordsExtensionSha256'),
        DEPLOYMENT_ACCOUNT_ID: ref('AWS::AccountId'),
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
    MigrationReleaseSha256: { Value: ref('MigrationReleaseSha256') }, ClinicRecordsExtensionSha256: { Value: ref('ClinicRecordsExtensionSha256') },
    DatabaseName: { Value: ref('DatabaseName') }, QualificationExecution: { Value: { 'Fn::If': ['Qualification', 'enabled', 'disabled'] } }, FunctionName: { Value: ref('Function') } },
};
template.Conditions.QualificationPosture['Fn::And'].push(
  { 'Fn::Equals': [ref('AWS::AccountId'), '588966314750'] }, { 'Fn::Equals': [ref('AWS::Region'), 'us-east-2'] });
for (const pool of ['Consumer', 'Workforce']) template.Resources[`${pool}Authorizer`] = {
  Type: 'AWS::ApiGatewayV2::Authorizer', Properties: { ApiId: ref('ApiId'), Name: sub(`\${ApiId}-clinic-records-${pool.toLowerCase()}`), AuthorizerType: 'JWT',
    IdentitySource: ['$request.header.Authorization'], JwtConfiguration: { Issuer: ref(`${pool}Issuer`), Audience: [ref(`${pool}Audience`)] } },
};
for (const [name, pool, path] of routes) {
  template.Resources[`Route${name}`] = { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: ref('ApiId'), RouteKey: `POST /clinical-core/${path}`,
    AuthorizationType: 'JWT', AuthorizerId: ref(`${pool}Authorizer`), Target: { 'Fn::Join': ['/', ['integrations', ref('Integration')]] } } };
  template.Resources[`Invoke${name}`] = { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('Function'), Action: 'lambda:InvokeFunction',
    Principal: 'apigateway.amazonaws.com', SourceAccount: ref('AWS::AccountId'), SourceArn: sub(`arn:\${AWS::Partition}:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${ApiId}/*/POST/clinical-core/${path}`) } };
}
writeFileSync(`${out}/template.json`, JSON.stringify(template, null, 2) + '\n');
const code = readFileSync(`${out}/index.js`), zip = careMessagingZip(code);
writeFileSync(`${out}/deployment.zip`, zip);
writeFileSync(`${out}/artifact-manifest.json`, JSON.stringify({ contract: 'clinic-records-deployment/1', sourceCommit, sourceClean,
  migrationCount: 114, migrationReleaseSha256: c.migrationReleaseSha256, extensionSha256: c.extensionSha256, migrationFile: artifact.manifest.migrations[113].file,
  parentMigrationReleaseSha256: c.parentMigrationReleaseSha256, dispatcher, routes: routes.map(([, , path]) => `POST /clinical-core/${path}`),
  codeSha256: sha(code), templateSha256: sha(readFileSync(`${out}/template.json`)), deploymentZipSha256: sha(zip), deploymentZipBytes: zip.length,
  defaults: { phiAllowed: false, activation: 'blocked', qualification: 'disabled', disclosureReleases: 'none' }, deploymentPerformed: false, registered: false,
  remaining: ['release numbering coordinated by Codex (114 is a position, not a reservation)', 'owner disclosure release and retention review',
    'hosted qualification of the 30 mandatory cases', 'matched Desktop/V2 release', 'device acceptance'] }, null, 2) + '\n');
console.log('Built clinic-records deployment candidate: artifact-pinned, blocked by default, no disclosure release. No AWS access, registration or activation.');
