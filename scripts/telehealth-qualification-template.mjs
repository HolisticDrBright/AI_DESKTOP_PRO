// Source-only candidate construction. The live account, S3 object and API must
// still be independently inspected before a qualification stack is deployed.
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const API_ID = /^[a-z0-9]{10}$/;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const fail = () => { throw new Error('telehealth_qualification_target_invalid'); };

export function telehealthQualificationTemplate(base, target, sourceCommit) {
  if (!SHA40.test(sourceCommit) || target?.schemaVersion !== 'aws-clinical-core-qualification-target/1'
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
    || !['consumer', 'workforce', 'foreignConsumer', 'retentionService'].every(name =>
      SUBJECT.test(target.identitySubjects?.[name] ?? '') && !/replace-with/i.test(target.identitySubjects[name]))
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
  };
  template.Parameters.ClinicalApiId.AllowedValues = [target.apiId];
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
  template.Outputs.SourceCommit = { Value: { Ref: 'SourceCommit' } };
  template.Outputs.ClinicalApiId = { Value: { Ref: 'ClinicalApiId' } };
  template.Outputs.LambdaCodeVersion = { Value: { Ref: 'LambdaCodeVersion' } };
  return template;
}
