import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { telehealthConsentTemplate } from './telehealth-consent-template.mjs';
import { crc32 } from './care-messaging-zip.mjs';
let directory, manifest, template;
const sha = v => createHash('sha256').update(v).digest('hex');
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'alp-telehealth-consent-'));
  execFileSync(process.execPath, ['scripts/build-aws-telehealth-consent.mjs', `--out-dir=${directory}`],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  manifest = JSON.parse(readFileSync(join(directory, 'artifact-manifest.json')));
  template = JSON.parse(readFileSync(join(directory, 'template.json')));
});
after(() => {
  if (!directory) return;
  const target = realpathSync(directory), parent = realpathSync(tmpdir());
  if (!target.startsWith(parent + '\\') && !target.startsWith(parent + '/')) throw Error('temp_cleanup_refused');
  if (!target.includes('alp-telehealth-consent-') || target === resolve('.')) throw Error('temp_cleanup_refused');
  rmSync(target, { recursive: true, force: true });
});
const evalCondition = (value, t, p) => {
  if (value === null || typeof value !== 'object') return value;
  if ('Ref' in value) { assert.ok(value.Ref in p); return p[value.Ref]; }
  if ('Condition' in value) return evalCondition(t.Conditions[value.Condition], t, p);
  if ('Fn::Equals' in value) return evalCondition(value['Fn::Equals'][0], t, p) === evalCondition(value['Fn::Equals'][1], t, p);
  if ('Fn::And' in value) return value['Fn::And'].every(v => evalCondition(v, t, p));
  if ('Fn::Or' in value) return value['Fn::Or'].some(v => evalCondition(v, t, p));
  if ('Fn::Not' in value) return !evalCondition(value['Fn::Not'][0], t, p);
  throw Error('condition_not_supported');
};
const fictionalParameters = t => ({ ...Object.fromEntries(Object.entries(t.Parameters).map(([key, value]) => [key, value.Default ?? 'fictional'])),
  ...Object.fromEntries(Object.keys(t.Parameters).filter(key => /ReviewSha256$/.test(key)).map(key => [key, '2'.repeat(64)])),
  SourceCommit: manifest.sourceCommit, SourceInputSha256: manifest.sourceInputSha256, SourceClean: 'true',
  MigrationReleaseSha256: manifest.migrationReleaseSha256, ConfigurationSha256: '3'.repeat(64), AlarmTopicArn: 'fictional-topic',
  QualificationExecution: 'enabled', QualificationAccountId: '588966314750', QualificationIdentitySubjects: 'fictional-consumer-00001',
  DatabaseName: 'clinical_core_qualification', 'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2' });
// Fully resolved identifiers only, never a live process environment or secret.
const configurationInput = () => {
  const p = { ...fictionalParameters(template), QualificationExecution: 'disabled', QualificationReviewSha256: '',
    QualificationIdentitySubjects: '', ConsumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer',
    WorkforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce',
    ConsumerAudience: 'c'.repeat(26), WorkforceAudience: 'w'.repeat(26), OrganizationId: '11111111-1111-4111-8111-111111111111',
    DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12',
    ActivationEvidenceSha256: '', QualificationAccountId: '588966314750' };
  const variables = template.Resources.Function.Properties.Environment.Variables;
  const resolved = value => {
    if (value && typeof value === 'object' && 'Ref' in value) { assert.ok(value.Ref in p); return p[value.Ref]; }
    if (value && typeof value === 'object' && 'Fn::If' in value) {
      const [condition, yes, no] = value['Fn::If'];
      return resolved(evalCondition(template.Conditions[condition], template, p) ? yes : no);
    }
    assert.equal(typeof value, 'string'); return value;
  };
  return { contract: 'telehealth-consent-configuration/1', environment: { AWS_REGION: 'us-east-2',
    ...Object.fromEntries(Object.entries(variables).filter(([key]) => key !== 'TELEHEALTH_CONSENT_CONFIGURATION_SHA256')
      .map(([key, value]) => [key, resolved(value)])) } };
};
const identityCommand = (input, args = []) => execFileSync(process.execPath, [join(directory, 'configuration-identity.cjs'), ...args],
  { input, encoding: 'utf8', timeout: 15000, maxBuffer: 40000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
test('build pins actual source, 112 assembly, functions and every output byte without a hosted claim', () => {
  assert.equal(manifest.contract, 'telehealth-consent-deployment/1');
  assert.equal(manifest.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.match(manifest.sourceInputSha256, /^[a-f0-9]{64}$/); assert.equal(manifest.migrationCount, 112);
  assert.equal(manifest.migrationReleaseSha256, '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4');
  assert.equal(manifest.assemblySha256, '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9');
  assert.equal(manifest.sqlSha256, '5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e');
  assert.equal(manifest.functions.length, 7); assert.match(manifest.telehealthFunctionSha256, /^[a-f0-9]{64}$/);
  const code = readFileSync(join(directory, 'index.js')), zip = readFileSync(join(directory, 'deployment.zip'));
  assert.equal(manifest.codeSha256, sha(code)); assert.equal(manifest.templateSha256, sha(readFileSync(join(directory, 'template.json'))));
  assert.equal(manifest.deploymentZipSha256, sha(zip)); assert.equal(manifest.deploymentZipBytes, zip.length);
  assert.equal(manifest.configurationToolSha256, sha(readFileSync(join(directory, 'configuration-identity.cjs'))));
  assert.equal(manifest.lambdaCodeSha256, createHash('sha256').update(zip).digest('base64'));
  assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt32LE(14), crc32(code));
  assert.deepEqual(zip.subarray(38, 38 + code.length), code);
  for (const flag of ['deploymentPerformed', 'hostedVerified', 'activationApproved', 'seededApprovals', 'seededConsents']) assert.equal(manifest[flag], false);
});
test('actual configuration command hashes only the resolved ordered runtime identifiers and prints no input or approval', () => {
  const input = configurationInput(), reply = JSON.parse(identityCommand(JSON.stringify(input)));
  assert.deepEqual(Object.keys(reply), ['configurationSha256']); assert.match(reply.configurationSha256, /^[a-f0-9]{64}$/);
  const keys = ['AWS_REGION', ...Object.keys(template.Resources.Function.Properties.Environment.Variables)
    .filter(key => key !== 'TELEHEALTH_CONSENT_CONFIGURATION_SHA256')];
  assert.equal(keys.length, 26);
  // Input key order is not authority: the tool has a compiled canonical order.
  const reversed = { ...input, environment: Object.fromEntries(Object.entries(input.environment).reverse()) };
  assert.deepEqual(JSON.parse(identityCommand(JSON.stringify(reversed))), reply);
  for (const [key, value] of [['TELEHEALTH_CONSENT_ENABLED', 'true'], ['CONSENT_REVIEW_SHA256', '4'.repeat(64)],
    ['QUALIFICATION_IDENTITY_SUBJECTS', 'fictional-owner-00001']]) {
    assert.notEqual(JSON.parse(identityCommand(JSON.stringify({ ...input, environment: { ...input.environment, [key]: value } }))).configurationSha256,
      reply.configurationSha256, key);
  }
});
test('configuration command refuses omissions, credentials, coercion, oversized input and invalid UTF-8 without echoing', () => {
  const input = configurationInput();
  for (const [key, value] of Object.entries(input.environment)) {
    const missing = { ...input.environment }; delete missing[key];
    assert.throws(() => identityCommand(JSON.stringify({ ...input, environment: missing })), undefined, key);
    assert.throws(() => identityCommand(JSON.stringify({ ...input, environment: { ...input.environment, [key]: { value } } })), undefined, key);
  }
  const rejected = [JSON.stringify({ ...input, environment: { ...input.environment, AWS_SECRET_ACCESS_KEY: 'FICTIONAL-CREDENTIAL-DO-NOT-ECHO' } }),
    JSON.stringify({ ...input, approved: true }), JSON.stringify({ ...input, environment: { ...input.environment, PHI_ALLOWED: true } }),
    JSON.stringify({ ...input, environment: { ...input.environment, QUALIFICATION_IDENTITY_SUBJECTS: 'duplicate-owner,duplicate-owner' } }),
    ' '.repeat(20001), Buffer.from([0xff, 0xfe]), '{}', 'null'];
  for (const value of rejected) {
    try { identityCommand(value); assert.fail('unsafe input accepted'); }
    catch (error) {
      assert.equal(String(error.stderr), 'telehealth_consent_configuration_input_refused\n');
      assert.equal(String(error.stdout), '');
    }
  }
  assert.throws(() => identityCommand(JSON.stringify(input), ['--approve']));
});
test('actual compiled Lambda remains blocked without a database call or a qualification claim', () => {
  const input = configurationInput();
  const run = 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",async()=>{'
    + 'const i=JSON.parse(s);Object.assign(process.env,i.environment);'
    + 'const r=await require(process.argv[1]).handler({routeKey:"POST /clinical-core/consumer/telehealth-consent"});'
    + 'process.stdout.write(JSON.stringify(r));});';
  const reply = JSON.parse(execFileSync(process.execPath, ['--eval', run, join(directory, 'index.js')],
    { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, windowsHide: true }));
  assert.equal(reply.statusCode, 503); assert.equal(reply.headers['x-clinical-execution'], undefined);
  assert.deepEqual(JSON.parse(reply.body), { error: 'production_not_activated', phiAllowed: false });
});
test('pins uploaded code and runtime configuration in a published version, never $LATEST', () => {
  assert.deepEqual(template.Resources.Published.Properties, { FunctionName: { Ref: 'Function' }, CodeSha256: manifest.lambdaCodeSha256,
    Description: { 'Fn::Sub': '${SourceCommit}:${ConfigurationSha256}' } });
  assert.deepEqual(template.Resources.Integration.Properties.IntegrationUri, { Ref: 'Published' });
  assert.deepEqual(template.Resources.Invoke.Properties.FunctionName, { Ref: 'Published' });
  assert.deepEqual(template.Resources.Function.Properties.Code.S3ObjectVersion, { Ref: 'CodeVersion' });
  assert.deepEqual(template.Parameters.SourceCommit.AllowedValues, [manifest.sourceCommit]);
  assert.deepEqual(template.Parameters.SourceInputSha256.AllowedValues, [manifest.sourceInputSha256]);
  assert.deepEqual(template.Parameters.MigrationReleaseSha256.AllowedValues, [manifest.migrationReleaseSha256]);
});
test('exposes only the consumer consent route and exact invocation permission', () => {
  const routes = Object.values(template.Resources).filter(v => v.Type === 'AWS::ApiGatewayV2::Route');
  assert.equal(routes.length, 1); assert.equal(routes[0].Properties.RouteKey, 'POST /clinical-core/consumer/telehealth-consent');
  assert.equal(routes[0].Properties.AuthorizationType, 'JWT'); assert.deepEqual(routes[0].Properties.AuthorizerId, { Ref: 'ConsumerAuthorizer' });
  assert.equal(template.Resources.Invoke.Properties.SourceArn['Fn::Sub'],
    'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/POST/clinical-core/consumer/telehealth-consent');
  assert.deepEqual(template.Resources.ConsumerAuthorizer.Properties.JwtConfiguration, { Issuer: { Ref: 'ConsumerIssuer' }, Audience: [{ Ref: 'ConsumerAudience' }] });
});
test('default deployment is logs-only, grants disabled and no synthetic evidence is manufactured', () => {
  const p = Object.fromEntries(Object.entries(template.Parameters).map(([key, value]) => [key, value.Default ?? 'fictional']));
  Object.assign(p, { 'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2', SourceCommit: manifest.sourceCommit,
    SourceInputSha256: manifest.sourceInputSha256, MigrationReleaseSha256: manifest.migrationReleaseSha256 });
  assert.equal(evalCondition(template.Conditions.Enabled, template, p), false);
  assert.equal(template.Parameters.ConsentEnabled.Default, 'false');
  assert.deepEqual(template.Resources.Role.Properties.Policies[1]['Fn::If'][0], 'Enabled');
  assert.deepEqual(template.Resources.Role.Properties.Policies[1]['Fn::If'][2], { Ref: 'AWS::NoValue' });
  assert.equal(template.Resources.Logs.DeletionPolicy, 'Retain'); assert.deepEqual(template.Resources.Logs.Properties.KmsKeyId, { Ref: 'LogsKmsKeyArn' });
});
test('qualification requires every review and exact synthetic posture; production is separate', () => {
  const t = telehealthConsentTemplate({ ...manifest, sourceClean: true }, manifest.lambdaCodeSha256), p = fictionalParameters(t);
  assert.equal(evalCondition(t.Conditions.Qualification, t, p), true); assert.equal(evalCondition(t.Conditions.Active, t, p), false);
  for (const [key, value] of Object.entries({ 'AWS::AccountId': '173535830222', 'AWS::Region': 'us-west-2', SourceClean: 'false',
    QualificationExecution: 'disabled', PhiAllowed: 'true', Activation: 'approved', DatabaseName: 'clinical_core',
    SourceCommit: '4'.repeat(40), SourceInputSha256: '4'.repeat(64), MigrationReleaseSha256: '4'.repeat(64),
    ...Object.fromEntries(Object.keys(t.Parameters).filter(k => /ReviewSha256$/.test(k) || k === 'ConfigurationSha256' || k === 'AlarmTopicArn').map(k => [k, ''])) }))
    assert.equal(evalCondition(t.Conditions.Qualification, t, { ...p, [key]: value }), false, key);
  const prod = { ...p, QualificationExecution: 'disabled', PhiAllowed: 'true', Activation: 'approved', DatabaseName: 'clinical_core',
    'AWS::AccountId': '173535830222', ActivationEvidenceSha256: '5'.repeat(64) };
  assert.equal(evalCondition(t.Conditions.Active, t, prod), true); assert.equal(evalCondition(t.Conditions.Qualification, t, prod), false);
  assert.equal(evalCondition(t.Conditions.Active, t, { ...prod, ActivationEvidenceSha256: '' }), false);
});
test('all conditional operands fit CloudFormation limits and grant IAM has no storage/provider/admin access', () => {
  const walk = v => { if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) { if (key === 'Fn::And' || key === 'Fn::Or') assert.ok(value.length >= 2 && value.length <= 10); walk(value); } };
  walk(template);
  const policy = template.Resources.Role.Properties.Policies[1]['Fn::If'][1].PolicyDocument.Statement;
  assert.deepEqual(policy.map(v => v.Resource), [{ Ref: 'DatabaseClusterArn' }, { Ref: 'DatabaseSecretArn' }, { Ref: 'SecretKmsKeyArn' }]);
  assert.equal(JSON.stringify(policy).includes('"Resource":"*"'), false); assert.equal(/s3:|transcribe:|lambda:InvokeFunction/.test(JSON.stringify(policy)), false);
  assert.deepEqual(policy[2].Condition.StringEquals['kms:EncryptionContext:SecretARN'], { Ref: 'DatabaseSecretArn' });
});
test('malformed build identity and unreviewed flags are refused', () => {
  for (const build of [{ ...manifest, migrationCount: 111 }, { ...manifest, migrationReleaseSha256: '4'.repeat(64) },
    { ...manifest, sourceCommit: 'wrong' }, { ...manifest, sourceInputSha256: '' }, { ...manifest, sourceClean: 'true' }])
    assert.throws(() => telehealthConsentTemplate(build, manifest.lambdaCodeSha256), /binding_refused/);
  assert.throws(() => telehealthConsentTemplate(manifest, 'unrelated'), /binding_refused/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-aws-telehealth-consent.mjs', '--activate'], { stdio: 'pipe' }));
});
