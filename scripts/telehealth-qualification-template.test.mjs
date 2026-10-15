import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { telehealthQualificationTemplate } from './telehealth-qualification-template.mjs';

const base = JSON.parse(readFileSync('infra/aws-clinical-core/telehealth-requests-extension.json', 'utf8'));
const sha = 'a'.repeat(40);
const example = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-target.example.json', 'utf8'));
const target = {
  ...example, sourceCommit: sha, migrationReleaseHash: 'b'.repeat(64),
  databaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-secret',
  identitySubjects: {
    consumer: '51cb2580-5051-70ca-eb9c-3a3a86cd9b8a',
    workforce: '41cb4540-b031-70a6-7027-836d074e4075',
    foreignConsumer: 'e18b95e0-d021-70e8-0969-d36f36ac8e1d',
    retentionService: 'svc-qualification-b7599066',
  },
};
const candidate = () => telehealthQualificationTemplate(base, target, sha);

test('pins qualification to the source, API and immutable code version, with providers off', () => {
  const template = candidate();
  assert.deepEqual(template.Parameters.ClinicalApiId.AllowedValues, [target.apiId]);
  assert.deepEqual(template.Parameters.SourceCommit.AllowedValues, [sha]);
  assert.deepEqual(template.Parameters.LambdaCodeKey.AllowedValues, [`telehealth-qualification/${sha}/deployment.zip`]);
  assert.deepEqual(template.Parameters.LambdaCodeBucket.AllowedValues, ['alp-qualification-code-588966314750-us-east-2']);
  assert.deepEqual(template.Parameters.ConsumerUserPoolId.AllowedValues, ['us-east-2_G2Hvf9wzJ']);
  assert.deepEqual(template.Parameters.ConsumerUserPoolClientId.AllowedValues, ['18q2q70rlsv8ti37knolpq7qsu']);
  assert.deepEqual(template.Parameters.WorkforceUserPoolId.AllowedValues, ['us-east-2_zGOVBoeGT']);
  assert.deepEqual(template.Parameters.WorkforceUserPoolClientId.AllowedValues, ['1ffcdpnh0k45b3gc2hm9938ebl']);
  assert.deepEqual(template.Parameters.ClinicalCoreKeyArn.AllowedValues,
    ['arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900']);
  assert.equal(template.Parameters.ChartAdmissionSecretArn.AllowedPattern, '^$');
  assert.deepEqual(template.Metadata.ClinicalCore.QualificationTarget.identitySubjects, target.identitySubjects);
  assert.deepEqual(template.Resources.TelehealthFunction.Properties.Code.S3ObjectVersion, { Ref: 'LambdaCodeVersion' });
  assert.equal(template.Parameters.LambdaCodeVersion.AllowedPattern, '^(?!null$)[A-Za-z0-9._~+=/-]{1,1024}$');
  assert.equal(template.Metadata.ClinicalCore.QualificationTarget.accountId, '588966314750');
  assert.equal(template.Resources.TelehealthFunction.Properties.Environment.Variables.PHI_ALLOWED, 'false');
  assert.equal(template.Resources.TelehealthFunction.Properties.Environment.Variables.RUNTIME_MODE, 'synthetic');
  for (const name of ['ZoomEnabled', 'ZoomBaaVerified', 'RemindersEnabled', 'StripeTestEnabled'])
    assert.deepEqual(template.Parameters[name].AllowedValues, ['false']);
  assert.equal(base.Parameters.ClinicalApiId.AllowedValues, undefined, 'the staging template must remain unchanged');
});

test('accepts the current messaging and connections qualification target schemas without changing their posture', () => {
  for (const schemaVersion of ['aws-clinical-core-qualification-target/2', 'aws-clinical-core-qualification-target/3']) {
    const template = telehealthQualificationTemplate(base, { ...target, schemaVersion }, sha);
    assert.equal(template.Metadata.ClinicalCore.QualificationTarget.accountId, '588966314750');
    assert.equal(template.Resources.TelehealthFunction.Properties.Environment.Variables.PHI_ALLOWED, 'false');
  }
});

test('refuses substituted source, API, account, database, PHI and provider posture', () => {
  for (const mutate of [
    t => { t.sourceCommit = 'c'.repeat(40); }, t => { t.apiId = 'aaaaaaaaaa'; },
    t => { t.awsAccountId = '173535830222'; }, t => { t.awsRegion = 'us-east-1'; },
    t => { t.databaseName = 'clinical_core'; }, t => { t.containsPhi = true; },
    t => { t.migrationReleaseHash = '0'.repeat(64); },
    t => { t.refused.stagingApiOrigin = t.apiOrigin; },
    t => { t.databaseSecretArn = example.databaseSecretArn; },
    t => { t.identitySubjects.consumer = example.identitySubjects.consumer; },
  ]) {
    const changed = structuredClone(target); mutate(changed);
    assert.throws(() => telehealthQualificationTemplate(base, changed, sha), /telehealth_qualification_target_invalid/);
  }
  for (const mutate of [
    b => { b.Metadata.ClinicalCore.DataClassification = 'phi'; },
    b => { b.Resources.TelehealthFunction.Properties.Environment.Variables.PHI_ALLOWED = 'true'; },
    b => { b.Resources.TelehealthFunction.Properties.Environment.Variables.RUNTIME_MODE = 'production'; },
    b => { b.Parameters.ZoomEnabled.Default = 'true'; },
    b => { b.Parameters.ConsumerUserPoolId.AllowedValues = ['us-east-2_nYngyyYGE']; },
    b => { b.Parameters.ChartAdmissionSecretArn.Default = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:wrong'; },
  ]) {
    const changed = structuredClone(base); mutate(changed);
    assert.throws(() => telehealthQualificationTemplate(changed, target, sha), /telehealth_qualification_target_invalid/);
  }
});
