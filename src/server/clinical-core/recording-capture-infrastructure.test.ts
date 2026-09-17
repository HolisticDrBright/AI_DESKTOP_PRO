import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
let template: { Parameters: Record<string, { Default?: string }>; Conditions: Record<string, Json>; Rules: Record<string, Json>;
  Resources: Record<string, { Type: string; Properties: Record<string, Json>; DeletionPolicy?: string }> };
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-aws-recording-authority.mjs', '--capture'], { stdio: 'pipe' });
  template = JSON.parse(readFileSync('dist/aws-clinical-core/recording-capture/template.json', 'utf8'));
}, 20000);
function evaluate(value: Json, parameters: Record<string, string>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => evaluate(v, parameters));
  if (typeof value.Ref === 'string') return parameters[value.Ref] ?? '';
  if (value['Fn::Equals']) { const v = evaluate(value['Fn::Equals'], parameters) as unknown[]; return v[0] === v[1]; }
  if (value['Fn::Not']) return !(evaluate(value['Fn::Not'], parameters) as unknown[])[0];
  if (value['Fn::And']) return (evaluate(value['Fn::And'], parameters) as unknown[]).every(Boolean);
  throw new Error('unsupported_condition');
}
describe('independently blocked recording capture deployment', () => {
  it('binds both required runtime files and the template in the release manifest', () => {
    const manifest = JSON.parse(readFileSync('dist/aws-clinical-core/recording-capture/artifact-manifest.json', 'utf8')) as {
      contract: string; files: { path: string; bytes: number; sha256: string }[] };
    expect(manifest.contract).toBe('recording-capture-artifact/1');
    expect(manifest.files.map(f => f.path)).toEqual(['index.js', 'recording-capture-runtime.js', 'template.json']);
    for (const file of manifest.files) {
      const bytes = readFileSync('dist/aws-clinical-core/recording-capture/' + file.path);
      expect(bytes.length).toBe(file.bytes); expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
  });
  it('requires every capture/storage/retention/workforce/database review and alarm recipient before non-log permissions', () => {
    const defaults = Object.fromEntries(Object.entries(template.Parameters).map(([k, v]) => [k, v.Default ?? '']));
    const hashes = ['ActivationEvidenceSha256', 'DatabaseReviewSha256', 'WorkforceMfaReviewSha256', 'CaptureReviewSha256', 'StorageReviewSha256', 'RetentionReviewSha256'];
    const approved = { ...defaults, ...Object.fromEntries(hashes.map(h => [h, 'a'.repeat(64)])), PhiAllowed: 'true', Activation: 'approved', AlarmTopicArn: 'arn:aws:sns:us-east-2:123456789012:fictional' };
    expect(evaluate(template.Conditions.Active, defaults)).toBe(false);
    expect(evaluate(template.Conditions.Active, approved)).toBe(true);
    for (const key of [...hashes, 'PhiAllowed', 'Activation', 'AlarmTopicArn'])
      expect(evaluate(template.Conditions.Active, { ...approved, [key]: defaults[key] })).toBe(false);
    const policies = template.Resources.Role.Properties.Policies as Json[];
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|s3:|kms:|secretsmanager:/);
    expect((policies[1] as Record<string, Json>)['Fn::If']).toEqual(['Active', expect.any(Object), { Ref: 'AWS::NoValue' }]);
    const text = JSON.stringify(policies);
    expect(text).not.toMatch(/s3:Delete|s3:List|s3:\*|kms:\*|transcribe:|bedrock:|"Resource":"\*"/);
    expect(text).toContain('${RecordingBucket}/encounter-recordings/${OrganizationId}/*');
    expect(text).toContain('s3:ResourceAccount'); expect(text).toContain('kms:EncryptionContext:aws:s3:arn');
    expect(text).toContain('s3:x-amz-server-side-encryption-aws-kms-key-id');
    const activePolicy = ((policies[1] as Record<string, Json>)['Fn::If'] as Json[])[1] as { PolicyDocument: { Statement: { Action: Json; Condition?: Json }[] } };
    expect(activePolicy.PolicyDocument.Statement.find(s => s.Action === 's3:PutObject')?.Condition)
      .toMatchObject({ Null: { 's3:if-none-match': 'false' } });
    for (const hash of hashes) expect(JSON.stringify(template.Rules)).toContain(hash);
  });
  it('exposes exactly five JWT-protected POST routes with exact invocation scope, pinned code and encrypted retained logs', () => {
    const r = template.Resources;
    expect(Object.values(r).filter(v => v.Type === 'AWS::ApiGatewayV2::Route')).toHaveLength(5);
    expect(Object.values(r).some(v => v.Type === 'AWS::Lambda::Url')).toBe(false);
    for (const action of ['start', 'state', 'command', 'segment', 'reconcile']) {
      expect(r['Route_' + action].Properties).toMatchObject({ RouteKey: 'POST /clinical-core/workforce/encounter-recording/' + action,
        AuthorizationType: 'JWT', AuthorizerId: { Ref: 'Authorizer' } });
      expect(JSON.stringify(r['Invoke_' + action].Properties.SourceArn)).toContain('/POST/clinical-core/workforce/encounter-recording/' + action);
      expect(r['Invoke_' + action].Properties.SourceAccount).toEqual({ Ref: 'AWS::AccountId' });
    }
    expect(r.Authorizer.Properties.JwtConfiguration).toEqual({ Issuer: { Ref: 'WorkforceIssuer' }, Audience: [{ Ref: 'WorkforceAudience' }] });
    expect(r.Function.Properties.Code).toMatchObject({ S3ObjectVersion: { Ref: 'CodeVersion' } });
    expect(r.Function.Properties.Timeout).toBe(29); expect(r.Integration.Properties.TimeoutInMillis).toBe(30000);
    expect(r.Logs.Properties.KmsKeyId).toEqual({ Ref: 'LogsKmsKeyArn' }); expect(r.Logs.DeletionPolicy).toBe('Retain');
    expect(JSON.stringify(r.Function.Properties.Environment)).not.toContain('RECORDING_AUTHORITY_ACTIVATION');
    expect(r.ApiFailureAlarm.Properties.MetricName).toBe('5xx');
  });
  it('executes the built handler with capture blocked and no usable AWS/storage/database configuration', async () => {
    const child = await promisify(execFile)(process.execPath, ['-e', "require('./dist/aws-clinical-core/recording-capture/index.js').handler({}).then(response=>console.log(JSON.stringify({response,runtimeLoaded:Object.keys(require.cache).some(p=>p.endsWith('recording-capture-runtime.js'))})))"], {
      // Execute as a deployment child, without inherited test-runner preload,
      // credential or worker environment. Keep the outer five-second deadline.
      encoding: 'utf8', timeout: 4000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production',
        WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce',
        WORKFORCE_AUDIENCE: '12345678901234567890', RECORDING_ORGANIZATION_ID: '11111111-1111-4111-8111-111111111111',
        PHI_ALLOWED: 'false', RECORDING_CAPTURE_ACTIVATION: 'blocked', RECORDING_CAPTURE_RELEASE_ID: '',
        CLINICAL_DATABASE_CLUSTER_ARN: '', CLINICAL_DATABASE_SECRET_ARN: '', CLINICAL_DATABASE_NAME: '',
        AWS_EC2_METADATA_DISABLED: 'true', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
      } });
    expect(child.stderr).toBe('');
    const { response, runtimeLoaded } = JSON.parse(child.stdout); expect(response.statusCode).toBe(503); expect(runtimeLoaded).toBe(false);
    expect(readFileSync('dist/aws-clinical-core/recording-capture/recording-capture-runtime.js', 'utf8')).toContain('createRecordingCaptureRuntime');
    expect(JSON.parse(response.body)).toEqual({ error: 'production_not_activated', phiAllowed: false });
  });
});
