// Source-only candidate construction. The live account, S3 object and API must
// still be independently inspected before a qualification stack is deployed.
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const API_ID = /^[a-z0-9]{10}$/;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const fail = () => { throw new Error('telehealth_qualification_target_invalid'); };
// Observed isolated fictional pools and synthetic resources. This candidate is
// intentionally not reusable against the shared staging or production pools.
export const TELEHEALTH_QUALIFICATION_RESOURCES = Object.freeze({
  ConsumerUserPoolId: 'us-east-2_G2Hvf9wzJ',
  ConsumerUserPoolClientId: '18q2q70rlsv8ti37knolpq7qsu',
  WorkforceUserPoolId: 'us-east-2_zGOVBoeGT',
  WorkforceUserPoolClientId: '1ffcdpnh0k45b3gc2hm9938ebl',
  ClinicalCoreKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900',
  LambdaCodeBucket: 'alp-qualification-code-588966314750-us-east-2',
});
export const TELEHEALTH_QUALIFICATION_SUBJECTS = Object.freeze({
  consumer: '51cb2580-5051-70ca-eb9c-3a3a86cd9b8a',
  workforce: '41cb4540-b031-70a6-7027-836d074e4075',
  foreignConsumer: 'e18b95e0-d021-70e8-0969-d36f36ac8e1d',
});

export function telehealthQualificationTemplate(base, target, sourceCommit) {
  if (!SHA40.test(sourceCommit) || ![
    'aws-clinical-core-qualification-target/1',
    'aws-clinical-core-qualification-target/2',
    'aws-clinical-core-qualification-target/3',
  ].includes(target?.schemaVersion)
    || target.environment !== 'synthetic-staging' || target.dataClassification !== 'synthetic_only'
    || target.containsPhi !== false || target.awsAccountId !== '588966314750'
    || target.awsRegion !== 'us-east-2' || target.databaseName !== 'clinical_core_qualification'
    || !API_ID.test(target.apiId ?? '') || target.apiOrigin !== `https://${target.apiId}.execute-api.us-east-2.amazonaws.com`
    || target.refused?.stagingApiOrigin === target.apiOrigin || target.refused?.stagingDatabaseName === target.databaseName
    || target.sourceCommit !== sourceCommit || !SHA64.test(target.migrationReleaseHash ?? '')
    || /^0+$/.test(target.migrationReleaseHash) || !base?.Metadata?.ClinicalCore
    || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]+$/.test(target.databaseClusterArn ?? '')
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@-]+$/.test(target.databaseSecretArn ?? '')
    || /replace-with/i.test(target.databaseSecretArn ?? '')
    || !['consumer', 'workforce', 'foreignConsumer'].every(name =>
      SUBJECT.test(target.identitySubjects?.[name] ?? '') && !/replace-with/i.test(target.identitySubjects[name]))
    || (target.identitySubjects?.retentionService !== undefined
      && (!SUBJECT.test(target.identitySubjects.retentionService)
        || /replace-with/i.test(target.identitySubjects.retentionService)))
    || ['consumer', 'workforce', 'foreignConsumer'].some(name =>
      target.identitySubjects[name] !== TELEHEALTH_QUALIFICATION_SUBJECTS[name])
    || target.refused?.stagingDatabaseName !== 'clinical_core'
    || !/^https:\/\/[a-z0-9]{10}\.execute-api\.us-east-2\.amazonaws\.com$/.test(target.refused?.stagingApiOrigin ?? '')
    || Number.isNaN(Date.parse(target.reviewedAt ?? ''))
    || base.Metadata.ClinicalCore.DataClassification !== 'synthetic_only'
    || base.Metadata.ClinicalCore.PhiAllowed !== false
    || base.Resources?.TelehealthFunction?.Properties?.Environment?.Variables?.RUNTIME_MODE !== 'synthetic'
    || base.Resources.TelehealthFunction.Properties.Environment.Variables.PHI_ALLOWED !== 'false') fail();

  const template = structuredClone(base);
  template.Description = 'Exact-source, synthetic-only telehealth qualification candidate. No PHI or provider activation.';
  template.Metadata.ClinicalCore.QualificationTarget = {
    accountId: target.awsAccountId, region: target.awsRegion, apiId: target.apiId,
    databaseName: target.databaseName, sourceCommit, migrationReleaseHash: target.migrationReleaseHash,
    identitySubjects: structuredClone(target.identitySubjects),
  };
  template.Parameters.ClinicalApiId.AllowedValues = [target.apiId];
  for (const [name, value] of Object.entries(TELEHEALTH_QUALIFICATION_RESOURCES)) {
    const parameter = template.Parameters?.[name];
    if (!parameter || parameter.Default !== undefined || parameter.AllowedValues !== undefined) fail();
    parameter.AllowedValues = [value];
  }
  template.Parameters.SourceCommit = { Type: 'String', AllowedValues: [sourceCommit] };
  template.Parameters.LambdaCodeKey.AllowedValues = [`telehealth-qualification/${sourceCommit}/deployment.zip`];
  template.Parameters.LambdaCodeVersion = {
    Type: 'String', AllowedPattern: '^(?!null$)[A-Za-z0-9._~+=/-]{1,1024}$',
  };
  template.Resources.TelehealthFunction.Properties.Code.S3ObjectVersion = { Ref: 'LambdaCodeVersion' };
  template.Resources.TelehealthFunction.Properties.Description = { 'Fn::Sub': 'Synthetic qualification, source ${SourceCommit}' };
  for (const name of ['ZoomEnabled', 'ZoomBaaVerified', 'RemindersEnabled', 'StripeTestEnabled']) {
    if (template.Parameters[name]?.Default !== 'false') fail();
    template.Parameters[name].AllowedValues = ['false'];
  }
  for (const name of ['ZoomSecretArn', 'StripeSecretArn', 'ReminderSender']) {
    if (template.Parameters[name]?.Default !== '') fail();
    template.Parameters[name].AllowedPattern = '^$';
  }
  if (template.Parameters.ChartAdmissionSecretArn?.Default !== '') fail();
  template.Parameters.ChartAdmissionSecretArn.AllowedPattern = '^$';
  template.Outputs.SourceCommit = { Value: { Ref: 'SourceCommit' } };
  template.Outputs.ClinicalApiId = { Value: { Ref: 'ClinicalApiId' } };
  template.Outputs.LambdaCodeVersion = { Value: { Ref: 'LambdaCodeVersion' } };
  return template;
}
