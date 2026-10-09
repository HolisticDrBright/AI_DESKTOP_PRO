import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { awsReader } from './preflight-qualification-create.mjs';

const ACCOUNT = '588966314750', REGION = 'us-east-2';
const FOUNDATION = 'ai-clinical-core-qualification-foundation';
const STACK = 'ai-clinical-core-qualification-personal-storage';
const FUNCTION = '6zt8e9qz04-personal-storage', LOG = `/aws/lambda/${FUNCTION}`;
const fail = code => { throw new Error(`qualification_log_recovery_refused:${code}`); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stackRow(value, name, status) {
  const row = value?.Stacks?.[0];
  if (value?.Stacks?.length !== 1 || row.StackName !== name || row.StackStatus !== status
    || !row.StackId?.startsWith(`arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/`)) fail('stack_identity');
  return row;
}
function pairs(rows, key, value) {
  if (!Array.isArray(rows)) fail('metadata_shape');
  const result = Object.create(null);
  for (const row of rows) {
    if (typeof row?.[key] !== 'string' || typeof row[value] !== 'string' || Object.hasOwn(result, row[key])) fail('metadata_shape');
    result[row[key]] = row[value];
  }
  return result;
}

/** Pure observations -> proposal. This never certifies that a deletion/import is safe to execute. */
export function planLogRecovery(observed) {
  if (observed.identity?.Account !== ACCOUNT) fail('account');
  const foundation = stackRow(observed.foundation, FOUNDATION, 'CREATE_COMPLETE');
  const outputs = pairs(foundation.Outputs, 'OutputKey', 'OutputValue');
  if (outputs.ApiId !== '6zt8e9qz04' || outputs.DatabaseName !== 'clinical_core_qualification'
    || outputs.PhiAllowed !== 'false' || outputs.Activation !== 'blocked'
    || outputs.QualificationExecution !== 'disabled') fail('foundation_boundary');
  const stack = stackRow(observed.stack, STACK, 'ROLLBACK_COMPLETE');
  const parameters = pairs(stack.Parameters, 'ParameterKey', 'ParameterValue');
  if (parameters.ApiId !== outputs.ApiId || parameters.PhiAllowed !== 'false'
    || parameters.Activation !== 'blocked' || parameters.QualificationAccountId !== ACCOUNT
    || parameters.QualificationExecution !== 'enabled' || parameters.DatabaseName !== outputs.DatabaseName
    || parameters.LogsKmsKeyArn !== outputs.LogsKmsKeyArn) fail('candidate_boundary');
  const resources = observed.resources?.StackResources;
  const expected = { Logs: 'AWS::Logs::LogGroup', Function: 'AWS::Lambda::Function',
    Role: 'AWS::IAM::Role', ConsumerAuthorizer: 'AWS::ApiGatewayV2::Authorizer', ApiFailureAlarm: 'AWS::CloudWatch::Alarm' };
  if (!Array.isArray(resources) || resources.length !== 5 || new Set(resources.map(r => r.LogicalResourceId)).size !== 5) fail('resource_inventory');
  for (const resource of resources) {
    if (!Object.hasOwn(expected, resource.LogicalResourceId) || expected[resource.LogicalResourceId] !== resource.ResourceType
      || resource.StackId !== stack.StackId
      || resource.ResourceStatus !== (resource.LogicalResourceId === 'Logs' ? 'DELETE_SKIPPED' : 'DELETE_COMPLETE')) fail('resource_inventory');
  }
  if (resources.find(r => r.LogicalResourceId === 'Logs').PhysicalResourceId !== LOG
    || resources.find(r => r.LogicalResourceId === 'Function').PhysicalResourceId !== FUNCTION
    || observed.function !== null) fail('resource_identity');
  let template = observed.template?.TemplateBody;
  if (typeof template === 'string') { try { template = JSON.parse(template); } catch { fail('template_shape'); } }
  const oldLog = template?.Resources?.Logs;
  if (oldLog?.Type !== 'AWS::Logs::LogGroup' || oldLog.DeletionPolicy !== 'Retain' || oldLog.UpdateReplacePolicy !== 'Retain'
    || JSON.stringify(Object.keys(oldLog.Properties ?? {}).sort()) !== JSON.stringify(['KmsKeyId','LogGroupName','RetentionInDays'])
    || oldLog.Properties.RetentionInDays !== 30 || oldLog.Properties.KmsKeyId?.Ref !== 'LogsKmsKeyArn'
    || oldLog.Properties.LogGroupName?.['Fn::Sub'] !== '/aws/lambda/${ApiId}-personal-storage') fail('retention_template');
  if (!Array.isArray(observed.logs?.logGroups)) fail('log_observation');
  const matches = observed.logs.logGroups.filter(row => row.logGroupName === LOG);
  if (matches.length !== 1) fail('log_observation');
  const log = matches[0], key = observed.key?.KeyMetadata;
  if (log.retentionInDays !== 30 || log.logGroupClass !== 'STANDARD' || log.kmsKeyId !== outputs.LogsKmsKeyArn
    || !Number.isSafeInteger(log.creationTime) || !Number.isSafeInteger(log.storedBytes) || log.storedBytes < 0
    || !new RegExp(`^arn:aws:kms:${REGION}:${ACCOUNT}:key/[a-f0-9-]{36}$`).test(log.kmsKeyId)
    || key?.Arn !== log.kmsKeyId || key.Enabled !== true || key.KeyState !== 'Enabled'
    || key.KeyUsage !== 'ENCRYPT_DECRYPT') fail('log_or_key_configuration');
  const importTemplate = { AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Qualification retained log import proposal only; not candidate deployment or activation',
    Resources: { Logs: { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: { LogGroupName: LOG, RetentionInDays: 30, KmsKeyId: log.kmsKeyId } } } };
  const proposal = { contract: 'qualification-log-recovery-plan/1', account: ACCOUNT, region: REGION,
    stack: STACK, observedStackId: stack.StackId, foundationStackId: foundation.StackId,
    logGroupName: LOG, observedCreationTime: log.creationTime, observedStoredBytes: log.storedBytes,
    importTemplate, resourcesToImport: [{ ResourceType: 'AWS::Logs::LogGroup', LogicalResourceId: 'Logs', ResourceIdentifier: { LogGroupName: LOG } }],
    observedTemplateSha256: digest(template), proposalTemplateSha256: digest(importTemplate),
    readOnlyAws: true, deploymentPerformed: false, activationEvidence: false, executionAuthorized: false,
    requiredNextChecks: ['review_resource_preservation_plan', 'fresh_inventory_before_any_stack_removal',
      'preserve_log_and_key_then_verify_identity', 'review_import_only_changeset', 'verify_import_and_drift',
      'verify_capacity_and_full_candidate_target_manifest', 'review_candidate_update_changeset_and_hosted_acceptance'],
    limitations: 'Metadata-only non-atomic observations; no log events read, deleted or certified preserved by execution. No stack removal, import, changeset or deployment performed. Stored bytes, including zero, are not deletion authority. Re-observe before every reviewed mutation.' };
  return { ...proposal, proposalSha256: digest(proposal) };
}

export function observeLogRecovery(aws) {
  const identity = aws(['sts','get-caller-identity']);
  if (identity?.Account !== ACCOUNT) fail('account');
  const foundation = aws(['cloudformation','describe-stacks','--stack-name',FOUNDATION]);
  const stack = aws(['cloudformation','describe-stacks','--stack-name',STACK]);
  const resources = aws(['cloudformation','describe-stack-resources','--stack-name',STACK]);
  const template = aws(['cloudformation','get-template','--stack-name',STACK,'--template-stage','Original']);
  const fn = aws(['lambda','get-function-configuration','--function-name',FUNCTION], 'function');
  const logs = aws(['logs','describe-log-groups','--log-group-name-prefix',LOG]);
  const kms = logs?.logGroups?.find(row => row.logGroupName === LOG)?.kmsKeyId;
  if (!new RegExp(`^arn:aws:kms:${REGION}:${ACCOUNT}:key/[a-f0-9-]{36}$`).test(kms ?? '')) fail('key_boundary');
  const key = aws(['kms','describe-key','--key-id',kms]);
  return planLogRecovery({ identity, foundation, stack, resources, template, function: fn, logs, key });
}

export function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) fail('arguments');
  const report = observeLogRecovery(awsReader('ai-synthetic-staging'));
  // Exclusive creation preserves older proposals and avoids overwriting reviewed evidence.
  writeFileSync(argv[1], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ contract: report.contract, proposalSha256: report.proposalSha256,
    readOnlyAws: true, deploymentPerformed: false, executionAuthorized: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message?.startsWith('qualification_log_recovery_refused:') ? error.message : 'qualification_log_recovery_refused:input_or_observation');
    process.exitCode = 1;
  }
}
