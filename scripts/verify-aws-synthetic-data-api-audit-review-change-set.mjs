import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSyntheticDataApiAuditReview, digestTemplate,
  reviewedCandidateSha256, reviewedParentSha256 } from './build-aws-synthetic-data-api-audit-review.mjs';
import { account, region, stackName,
  readLiveAuditParent } from './check-aws-synthetic-data-api-audit-live-parent.mjs';

export const reviewedChangeSetName = 'review-synthetic-data-api-audit-371d8136-20261017';
export const reviewedChangeSetArn = 'arn:aws:cloudformation:us-east-2:588966314750:changeSet/review-synthetic-data-api-audit-371d8136-20261017/35c4d073-8627-431f-8d89-9ff0581807c0';

function sameParameters(current, proposed) {
  if (!Array.isArray(current) || !Array.isArray(proposed) || current.length !== 7 || proposed.length !== 7) return false;
  const values = new Map();
  for (const item of current) {
    if (!item?.ParameterKey || values.has(item.ParameterKey)) return false;
    values.set(item.ParameterKey, item.ParameterValue);
  }
  const seen = new Set();
  for (const item of proposed) {
    if (!item?.ParameterKey || seen.has(item.ParameterKey) || !values.has(item.ParameterKey)
      || values.get(item.ParameterKey) !== item.ParameterValue) return false;
    seen.add(item.ParameterKey);
  }
  return seen.size === values.size;
}

function exactTrailChange(changes) {
  if (!Array.isArray(changes) || changes.length !== 1) return false;
  const change = changes[0]?.ResourceChange;
  const details = change?.Details;
  if (change?.Action !== 'Modify' || change.LogicalResourceId !== 'AuditTrail'
    || change.PhysicalResourceId !== stackName || change.ResourceType !== 'AWS::CloudTrail::Trail'
    || change.Replacement !== 'False' || JSON.stringify(change.Scope) !== JSON.stringify(['Properties'])
    || !Array.isArray(details) || details.length !== 2) return false;
  const names = details.map(item => item.Target?.Name).sort();
  return JSON.stringify(names) === JSON.stringify(['AdvancedEventSelectors', 'EventSelectors'])
    && details.every(item => item.ChangeSource === 'DirectModification'
      && item.Evaluation === 'Static' && item.Target?.Attribute === 'Properties'
      && item.Target.RequiresRecreation === 'Never');
}

/** An exact match is review evidence only; it never authorizes execution. */
export function assessSyntheticAuditChangeSet({ livePreflight, stack, liveTemplate, changeSet, submittedTemplate }) {
  const reasons = [];
  if (livePreflight?.account !== account || livePreflight?.region !== region
    || livePreflight?.stack !== stackName || livePreflight?.reviewable !== true
    || livePreflight?.physicalSelectorsMatch !== true || livePreflight?.deliveryHealthy !== true
    || livePreflight?.executionAuthorized !== false
    || livePreflight?.parentSha256 !== reviewedParentSha256
    || livePreflight?.candidateSha256 !== reviewedCandidateSha256
    || stack?.StackName !== stackName || stack?.StackStatus !== 'UPDATE_COMPLETE'
    || !String(stack?.StackId ?? '').startsWith(`arn:aws:cloudformation:${region}:${account}:stack/${stackName}/`)) {
    reasons.push('live_target_changed');
  }
  if (digestTemplate(liveTemplate) !== reviewedParentSha256) reasons.push('parent_changed');
  try {
    if (digestTemplate(buildSyntheticDataApiAuditReview(liveTemplate)) !== reviewedCandidateSha256) {
      reasons.push('candidate_changed');
    }
  } catch { reasons.push('candidate_changed'); }
  if (digestTemplate(submittedTemplate) !== reviewedCandidateSha256) reasons.push('submitted_template_changed');
  if (changeSet?.ChangeSetName !== reviewedChangeSetName || changeSet?.ChangeSetId !== reviewedChangeSetArn
    || changeSet?.StackId !== stack?.StackId || changeSet?.Status !== 'CREATE_COMPLETE'
    || changeSet?.ExecutionStatus !== 'AVAILABLE') reasons.push('change_set_not_available');
  if (!sameParameters(stack?.Parameters, changeSet?.Parameters)) reasons.push('parameters_changed');
  if (!exactTrailChange(changeSet?.Changes)) reasons.push('resource_delta_changed');
  return { reviewable: reasons.length === 0, reasons, executionAuthorized: false };
}

function awsJson(profile, args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 20_000, maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

export function inspectSyntheticAuditChangeSet(profile) {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error('An explicit AWS profile is required');
  const livePreflight = readLiveAuditParent(profile);
  const stack = awsJson(profile, ['cloudformation', 'describe-stacks', '--stack-name', stackName]).Stacks?.[0];
  const parentResponse = awsJson(profile, ['cloudformation', 'get-template', '--stack-name', stackName,
    '--template-stage', 'Original']);
  const liveTemplate = typeof parentResponse.TemplateBody === 'string'
    ? JSON.parse(parentResponse.TemplateBody) : parentResponse.TemplateBody;
  const changeSet = awsJson(profile, ['cloudformation', 'describe-change-set', '--change-set-name', reviewedChangeSetArn,
    '--stack-name', stackName]);
  const submittedResponse = awsJson(profile, ['cloudformation', 'get-template', '--change-set-name', reviewedChangeSetArn,
    '--stack-name', stackName, '--template-stage', 'Processed']);
  const submittedTemplate = typeof submittedResponse.TemplateBody === 'string'
    ? JSON.parse(submittedResponse.TemplateBody) : submittedResponse.TemplateBody;
  return assessSyntheticAuditChangeSet({ livePreflight, stack, liveTemplate, changeSet, submittedTemplate });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--profile') {
    console.error('Usage: node scripts/verify-aws-synthetic-data-api-audit-review-change-set.mjs --profile <explicit-profile>');
    process.exitCode = 2;
  } else {
    try {
      const result = inspectSyntheticAuditChangeSet(process.argv[3]);
      console.log(JSON.stringify(result));
      if (!result.reviewable) process.exitCode = 1;
    } catch {
      console.error('Synthetic Data API audit change-set review could not be verified; execution remains refused');
      process.exitCode = 2;
    }
  }
}
