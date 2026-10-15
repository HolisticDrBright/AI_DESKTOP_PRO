import { createHash } from 'node:crypto';
import { TELEHEALTH_QUALIFICATION_RESOURCES, TELEHEALTH_QUALIFICATION_SUBJECTS }
  from './telehealth-qualification-template.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = field => { throw new Error(`telehealth_qualification_preflight_refused:${field}`); };
const outputs = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));

/** Verify captured read-only AWS observations against one local immutable artifact. No AWS calls or writes here. */
export function verifyTelehealthQualificationPreflight(input) {
  const { artifact, template, target, targetBytes, templateBytes, codeBytes, localZipBytes,
    downloadedZipBytes, versionId, sourceCommit, caller, foundation, api, versioning, objectHead,
    stackAbsent, rebuilt, consumerPool, workforcePool, consumerClient, workforceClient,
    consumerUser, foreignConsumerUser, workforceUser, clinicalKey } = input;
  if (artifact?.contract !== 'telehealth-qualification-deployment/1' || artifact.dataClassification !== 'synthetic_only'
    || artifact.containsPhi !== false || artifact.deployed !== false || artifact.phiApproved !== false
    || artifact.sourceClean !== true || artifact.sourceCommit !== sourceCommit || target?.sourceCommit !== sourceCommit
    || target.awsAccountId !== '588966314750' || target.awsRegion !== 'us-east-2'
    || target.apiId !== artifact.apiId || target.databaseName !== artifact.databaseName
    || target.migrationReleaseHash !== artifact.migrationReleaseHash
    || sha(targetBytes) !== artifact.targetManifestSha256 || sha(templateBytes) !== artifact.templateSha256
    || sha(codeBytes) !== artifact.codeSha256 || sha(localZipBytes) !== artifact.deploymentZipSha256
    || localZipBytes.length !== artifact.deploymentZipBytes
    || rebuilt?.codeSha256 !== artifact.codeSha256
    || rebuilt?.deploymentZipSha256 !== artifact.deploymentZipSha256
    || rebuilt?.templateSha256 !== artifact.templateSha256) refuse('artifact');
  const q = template?.Metadata?.ClinicalCore?.QualificationTarget;
  const fn = template?.Resources?.TelehealthFunction?.Properties;
  if (q?.accountId !== target.awsAccountId || q?.apiId !== target.apiId || q?.sourceCommit !== sourceCommit
    || ['consumer', 'workforce', 'foreignConsumer'].some(name =>
      q?.identitySubjects?.[name] !== TELEHEALTH_QUALIFICATION_SUBJECTS[name]
      || target.identitySubjects?.[name] !== TELEHEALTH_QUALIFICATION_SUBJECTS[name])
    || Object.entries(TELEHEALTH_QUALIFICATION_RESOURCES).some(([name, value]) =>
      template.Parameters?.[name]?.AllowedValues?.length !== 1
      || template.Parameters[name].AllowedValues[0] !== value)
    || template?.Parameters?.ClinicalApiId?.AllowedValues?.length !== 1
    || template.Parameters.ClinicalApiId.AllowedValues[0] !== target.apiId
    || template.Parameters?.SourceCommit?.AllowedValues?.[0] !== sourceCommit
    || template.Parameters?.LambdaCodeKey?.AllowedValues?.[0] !== artifact.codeKey
    || fn?.Code?.S3ObjectVersion?.Ref !== 'LambdaCodeVersion'
    || fn?.Environment?.Variables?.PHI_ALLOWED !== 'false'
    || fn.Environment.Variables.RUNTIME_MODE !== 'synthetic'
    || template.Parameters?.ChartAdmissionSecretArn?.AllowedPattern !== '^$'
    || ['ZoomEnabled', 'ZoomBaaVerified', 'RemindersEnabled', 'StripeTestEnabled']
      .some(name => template.Parameters?.[name]?.AllowedValues?.join(',') !== 'false')) refuse('template');
  if (caller?.Account !== target.awsAccountId
    || !new RegExp(`^arn:aws:sts::${target.awsAccountId}:assumed-role/`).test(caller.Arn ?? '')) refuse('caller');
  if (foundation?.StackStatus !== 'CREATE_COMPLETE' && foundation?.StackStatus !== 'UPDATE_COMPLETE') refuse('foundation_status');
  const f = outputs(foundation);
  if (f.PhiAllowed !== 'false' || f.Activation !== 'blocked' || f.QualificationExecution !== 'disabled'
    || f.QualificationInfrastructure !== 'prepared_no_candidates' || f.Environment !== 'synthetic-staging'
    || f.DataClassification !== 'synthetic_only' || f.ApiId !== target.apiId || f.ApiOrigin !== target.apiOrigin
    || f.DatabaseName !== target.databaseName || f.DatabaseClusterArn !== target.databaseClusterArn
    || f.DatabaseSecretArn !== target.databaseSecretArn || !/^alp-qualification-code-588966314750-us-east-2$/.test(f.CodeBucket ?? '')) refuse('foundation');
  if (api?.ApiId !== target.apiId || api.ApiEndpoint !== target.apiOrigin || api.ProtocolType !== 'HTTP') refuse('api');
  const resources = TELEHEALTH_QUALIFICATION_RESOURCES;
  for (const [pool, id, mfa] of [
    [consumerPool, resources.ConsumerUserPoolId, 'OPTIONAL'],
    [workforcePool, resources.WorkforceUserPoolId, 'ON'],
  ]) {
    if (pool?.Id !== id || pool.Arn !== `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${id}`
      || pool.MfaConfiguration !== mfa || pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true)
      refuse('identity_pool');
  }
  for (const [client, id, pool] of [
    [consumerClient, resources.ConsumerUserPoolClientId, resources.ConsumerUserPoolId],
    [workforceClient, resources.WorkforceUserPoolClientId, resources.WorkforceUserPoolId],
  ]) {
    if (client?.ClientId !== id || client.UserPoolId !== pool || client.ClientSecret !== undefined
      || !Array.isArray(client.ExplicitAuthFlows)
      || !client.ExplicitAuthFlows.includes('ALLOW_USER_PASSWORD_AUTH')) refuse('identity_client');
  }
  for (const [user, subject, workforce] of [
    [consumerUser, TELEHEALTH_QUALIFICATION_SUBJECTS.consumer, false],
    [foreignConsumerUser, TELEHEALTH_QUALIFICATION_SUBJECTS.foreignConsumer, false],
    [workforceUser, TELEHEALTH_QUALIFICATION_SUBJECTS.workforce, true],
  ]) {
    const subs = user?.UserAttributes?.filter(attribute => attribute.Name === 'sub');
    if (user?.Username !== subject || user.Enabled !== true || user.UserStatus !== 'CONFIRMED'
      || subs?.length !== 1 || subs[0].Value !== subject
      || (workforce && !user.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA'))) refuse('identity_subject');
  }
  if (clinicalKey?.Arn !== resources.ClinicalCoreKeyArn || clinicalKey.Enabled !== true
    || clinicalKey.KeyState !== 'Enabled' || clinicalKey.KeyUsage !== 'ENCRYPT_DECRYPT') refuse('clinical_key');
  if (versioning?.Status !== 'Enabled' || !versionId || versionId === 'null') refuse('versioning');
  if (objectHead?.VersionId !== versionId || objectHead.ContentLength !== localZipBytes.length
    || sha(downloadedZipBytes) !== artifact.deploymentZipSha256) refuse('code_object');
  if (stackAbsent !== true) refuse('stack_exists');
  return {
    contract: 'telehealth-qualification-preflight/1', accountId: target.awsAccountId,
    apiId: target.apiId, sourceCommit, codeBucket: f.CodeBucket, codeKey: artifact.codeKey,
    codeVersionId: versionId, codeSha256: artifact.codeSha256,
    deploymentZipSha256: artifact.deploymentZipSha256,
    stackName: 'ai-clinical-core-qualification-telehealth-requests',
    observedOnly: true, deploymentPerformed: false, phiApproved: false,
  };
}
