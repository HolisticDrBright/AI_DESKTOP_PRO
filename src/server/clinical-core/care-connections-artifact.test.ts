import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Build in an isolated temporary directory: no AWS access, shared dist race,
// upload, approval row or deployment. Shape placeholders are never real reviews.
let directory: string;
type Value = null | string | number | boolean | Value[] | { [name: string]: Value };
type Template = { Parameters: Record<string, { Default?: Value; AllowedValues?: string[] }>; Conditions: Record<string, Value>; Resources: Record<string, { Type: string; Properties: Record<string, Value> }>; Rules: Record<string, Value> };
let template: Template, manifest: { sourceCommit: string; sourceClean: boolean; migrationReleaseSha256: string; codeSha256: string; templateSha256: string; deploymentZipSha256: string; deploymentZipBytes: number; functions: unknown[]; claimFunctions: unknown[]; defaults: unknown };
function evaluate(value: Value, parameters: Record<string, Value>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => evaluate(v, parameters));
  if (typeof value.Ref === 'string') return parameters[value.Ref] ?? '';
  if (typeof value.Condition === 'string') return evaluate(template.Conditions[value.Condition], parameters);
  const list = (key: string) => evaluate(value[key], parameters) as unknown[];
  if (value['Fn::Equals']) { const [a, b] = list('Fn::Equals'); return a === b; }
  if (value['Fn::Not']) return !list('Fn::Not')[0];
  if (value['Fn::And']) return list('Fn::And').every(Boolean);
  if (value['Fn::Or']) return list('Fn::Or').some(Boolean);
  if (value['Fn::If']) { const [condition, yes, no] = value['Fn::If'] as Value[]; return evaluate(template.Conditions[condition as string], parameters) ? evaluate(yes, parameters) : evaluate(no, parameters); }
  throw new Error('unsupported_template_expression');
}
const reviews = ['DatabaseReviewSha256', 'WorkforceMfaReviewSha256', 'ConnectionReviewSha256', 'ConsentReviewSha256', 'RetentionReviewSha256', 'AlarmTopicArn'];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'care-connections-artifact-'));
  execFileSync(process.execPath, ['scripts/build-aws-care-connections.mjs', `--out-dir=${directory}`], { encoding: 'utf8', timeout: 60000 });
  template = JSON.parse(readFileSync(join(directory, 'template.json'), 'utf8'));
  manifest = JSON.parse(readFileSync(join(directory, 'artifact-manifest.json'), 'utf8'));
}, 65000);
afterAll(() => {
  if (!directory) return;
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('care-connections-artifact-')) throw new Error('temporary_cleanup_boundary_refused');
  rmSync(target, { recursive: true, force: true });
});
const defaults = () => Object.fromEntries(Object.entries(template.Parameters).map(([k, v]) => [k, v.Default ?? '']));
const qualified = (): Record<string, Value> => ({ ...defaults(), 'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2',
  QualificationExecution: 'enabled', QualificationAccountId: '588966314750', QualificationReviewSha256: 'fictional-review-placeholder',
  QualificationIdentitySubjects: 'fictional-consumer,fictional-workforce', DatabaseName: 'clinical_core_qualification',
  ...Object.fromEntries(reviews.map(key => [key, 'fictional-reviewed-shape'])) });
describe('care connections deployment artifact', () => {
  it('pins immutable object version, compiled source/release and exact emitted byte hashes', () => {
    const sha = (file: string) => createHash('sha256').update(readFileSync(join(directory, file))).digest('hex');
    expect(manifest.codeSha256).toBe(sha('index.js')); expect(manifest.templateSha256).toBe(sha('template.json'));
    expect(manifest.deploymentZipSha256).toBe(sha('deployment.zip'));
    expect(manifest.deploymentZipBytes).toBe(readFileSync(join(directory, 'deployment.zip')).length);
    expect(template.Parameters.SourceCommit.AllowedValues).toEqual([manifest.sourceCommit]);
    expect(template.Parameters.MigrationReleaseSha256.AllowedValues).toEqual([manifest.migrationReleaseSha256]);
    expect(manifest.migrationReleaseSha256).toBe('514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b');
    expect(manifest.functions).toHaveLength(7);
    expect(manifest.claimFunctions).toHaveLength(2);
    expect(template.Parameters.ClaimRecoveryEnabled.Default).toBe('false');
    expect(template.Parameters.ClaimRecoveryReviewSha256.Default).toBe('');
    expect(template.Parameters.EnabledConsentScopes.Default).toBe('');
    expect(template.Resources.Function.Properties.Code).toEqual({ S3Bucket: { Ref: 'CodeBucket' }, S3Key: { Ref: 'CodeKey' }, S3ObjectVersion: { Ref: 'CodeVersion' } });
    expect(template.Parameters.CodeVersion).not.toHaveProperty('Default');
    expect(manifest.defaults).toEqual({ phiAllowed: false, activation: 'blocked', qualification: 'disabled', claimRecoveryEnabled: false });
  });
  it('has logs-only permissions by default and no broad data/third-party/administrative grants', () => {
    const p = defaults(); expect(evaluate(template.Conditions.Enabled, p)).toBe(false);
    const policies = template.Resources.Role.Properties.Policies as Value[];
    expect(policies).toHaveLength(2); expect(evaluate(policies[1], p)).toBe(''); // AWS::NoValue means omitted.
    expect(policies[0]).toMatchObject({ PolicyDocument: { Statement: [{ Action: ['logs:CreateLogStream', 'logs:PutLogEvents'] }] } });
    const reviewedPolicy = (policies[1] as { [name: string]: Value })['Fn::If'] as Value[];
    const text = JSON.stringify(reviewedPolicy[1]);
    expect(text).not.toMatch(/"Resource":"\*"|secretsmanager:\*|rds:\*|s3:|ses:|transcribe:|bedrock:|kms:GenerateDataKey|iam:/);
    expect(text).toContain('kms:ViaService'); expect(text).toContain('kms:EncryptionContext:SecretARN'); expect(text).toContain('kms:CallerAccount');
  });
  it('runs the actual emitted Lambda in blocked mode without credentials or a database', () => {
    const configuration = { SOURCE_COMMIT: manifest.sourceCommit, MIGRATION_RELEASE_SHA256: manifest.migrationReleaseSha256,
      AWS_REGION: 'us-east-2', PHI_ALLOWED: 'false', CARE_CONNECTIONS_ACTIVATION: 'blocked', QUALIFICATION_EXECUTION: 'disabled',
      CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
      WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
      CARE_CONNECTIONS_ORGANIZATION_ID: '11111111-1111-4111-8111-111111111111' };
    const script = `Object.assign(process.env,JSON.parse(process.argv[1])); require(process.argv[2]).handler({routeKey:'POST /clinical-core/consumer/connection'}).then(r=>{process.stdout.write(JSON.stringify(r));});`;
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(configuration), join(directory, 'index.js')], {
      encoding: 'utf8', timeout: 10000, env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AWS_EC2_METADATA_DISABLED: 'true' },
    }));
    expect(actual.statusCode).toBe(503); expect(actual.headers).not.toHaveProperty('x-clinical-execution');
    expect(JSON.parse(actual.body)).toEqual({ error: 'production_not_activated', phiAllowed: false });
  });
  it('refuses missing independent reviews and separates qualification from production and other accounts/regions', () => {
    const p = qualified(); expect(evaluate(template.Conditions.Qualification, p)).toBe(true);
    expect(evaluate(template.Conditions.Active, p)).toBe(false);
    for (const key of reviews) expect(evaluate(template.Conditions.Enabled, { ...p, [key]: '' })).toBe(false);
    const alteredCases: Record<string, Value>[] = [{ 'AWS::AccountId': '173535830222' }, { 'AWS::AccountId': '123456789012' }, { 'AWS::Region': 'us-west-2' },
      { PhiAllowed: 'true' }, { Activation: 'approved' }, { DatabaseName: 'clinical_core' }, { DatabaseName: 'other_qualification' }];
    for (const altered of alteredCases) {
      expect(evaluate(template.Conditions.Enabled, { ...p, ...altered })).toBe(false);
    }
    const live = { ...p, 'AWS::AccountId': '173535830222', PhiAllowed: 'true', Activation: 'approved', ActivationEvidenceSha256: 'fictional-production-review', QualificationExecution: 'disabled' };
    expect(evaluate(template.Conditions.Active, live)).toBe(true);
    expect(evaluate(template.Conditions.Qualification, live)).toBe(false);
    expect(evaluate(template.Conditions.Active, { ...live, ActivationEvidenceSha256: '' })).toBe(false);
    expect(evaluate(template.Conditions.Active, { ...live, 'AWS::AccountId': '588966314750' })).toBe(false);
    // CloudFormation Fn::And has a ten-condition limit; do not repeat the old lint bug.
    for (const condition of Object.values(template.Conditions)) if (condition && typeof condition === 'object' && !Array.isArray(condition) && condition['Fn::And']) {
      expect((condition['Fn::And'] as Value[]).length).toBeLessThanOrEqual(10);
    }
  });
  it('creates three JWT-authorized routes, separate pools and exact invoke permissions', () => {
    const routes = Object.values(template.Resources).filter(r => r.Type === 'AWS::ApiGatewayV2::Route');
    expect(routes.map(r => r.Properties.RouteKey).sort()).toEqual(['POST /clinical-core/consumer/connection', 'POST /clinical-core/consumer/connection-claims', 'POST /clinical-core/workforce/connection']);
    for (const route of routes) {
      expect(route.Properties.AuthorizationType).toBe('JWT');
      expect(route.Properties.AuthorizerId).toEqual({ Ref: String(route.Properties.RouteKey).includes('/workforce/') ? 'WorkforceAuthorizer' : 'ConsumerAuthorizer' });
    }
    expect(Object.values(template.Resources).filter(r => r.Type === 'AWS::ApiGatewayV2::Authorizer')).toHaveLength(2);
    const invoke = Object.values(template.Resources).filter(r => r.Type === 'AWS::Lambda::Permission');
    expect(invoke).toHaveLength(3); for (const permission of invoke) {
      expect(permission.Properties.SourceAccount).toEqual({ Ref: 'AWS::AccountId' });
      expect(JSON.stringify(permission.Properties.SourceArn)).toMatch(/\/POST\/clinical-core\/(consumer|workforce)\/connection/);
      expect(JSON.stringify(permission.Properties.SourceArn)).not.toContain('/*/*/');
    }
    expect(template.Resources.Integration.Properties.TimeoutInMillis).toBe(30000); expect(template.Resources.Function.Properties.Timeout).toBe(29);
  });
  it('cannot enable recovery merely by enabling connections; opt-in and independent review are both required', () => {
    const p = qualified(); expect(evaluate(template.Conditions.Enabled, p)).toBe(true);
    expect(evaluate(template.Conditions.RecoveryEnabled, p)).toBe(false);
    expect(evaluate(template.Conditions.RecoveryEnabled, { ...p, ClaimRecoveryEnabled: 'true' })).toBe(false);
    const reviewed = { ...p, ClaimRecoveryEnabled: 'true', ClaimRecoveryReviewSha256: 'fictional-reviewed-shape' };
    expect(evaluate(template.Conditions.RecoveryEnabled, reviewed)).toBe(true);
    for (const key of reviews) expect(evaluate(template.Conditions.RecoveryEnabled, { ...reviewed, [key]: '' })).toBe(false);
    expect(evaluate(template.Conditions.RecoveryEnabled, { ...reviewed, PhiAllowed: 'true' })).toBe(false);
    expect(template.Rules.ReviewedRecovery).toMatchObject({ RuleCondition: { 'Fn::Equals': [{ Ref: 'ClaimRecoveryEnabled' }, 'true'] } });
  });
  it('uses count-only API 5xx and Lambda alarms with actions disabled when blocked', () => {
    expect(template.Resources.ApiServerErrors.Properties).toMatchObject({ Namespace: 'AWS/ApiGateway', MetricName: '5xx', Dimensions: [{ Name: 'ApiId', Value: { Ref: 'ApiId' } }] });
    for (const name of ['Errors', 'ApiServerErrors']) {
      expect(evaluate(template.Resources[name].Properties.ActionsEnabled, defaults())).toBe(false);
      expect(evaluate(template.Resources[name].Properties.ActionsEnabled, qualified())).toBe(true);
    }
    expect(JSON.stringify(template.Resources)).not.toContain('$request.body');
    expect(JSON.stringify(template.Resources.Logs.Properties)).not.toContain('$request.header.Authorization');
  });
});
