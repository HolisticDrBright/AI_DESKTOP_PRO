import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  digestTemplate, reviewedParentSha256, reviewedCandidateSha256,
} from './build-aws-synthetic-data-api-audit-review.mjs';

export const account = '588966314750';
export const region = 'us-east-2';
export const stackName = 'ai-clinical-core-synthetic-staging';

const refuse = () => { throw new Error('Synthetic Data API audit live parent is not reviewable'); };
const params = rows => Object.fromEntries((rows ?? []).map(row => [row.ParameterKey, row.ParameterValue]));

export function assessAuditLiveParent({ caller, stack, template, trailResource, bucketResource,
  clusterResource, selectors, trailStatus }) {
  if (caller?.Account !== account ||
      !String(caller.Arn ?? '').startsWith(`arn:aws:sts::${account}:assumed-role/`) ||
      stack?.StackName !== stackName ||
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) refuse();
  const p = params(stack.Parameters);
  if (p.ProjectName !== 'ai-clinical-core' || p.EnvironmentName !== 'synthetic-staging' ||
      p.DataClassification !== 'synthetic_only' || p.DatabaseName !== 'clinical_core') refuse();
  if (digestTemplate(template) !== reviewedParentSha256) refuse();
  if (trailResource?.LogicalResourceId !== 'AuditTrail' ||
      trailResource.PhysicalResourceId !== stackName ||
      bucketResource?.LogicalResourceId !== 'ClinicalDocumentsBucket' ||
      !/^ai-clinical-core-synthetic-clinicaldocumentsbucket-[a-z0-9]+$/.test(bucketResource.PhysicalResourceId ?? '') ||
      clusterResource?.LogicalResourceId !== 'ClinicalDatabaseCluster' ||
      !/^ai-clinical-core-synthetic-clinicaldatabasecluster-[a-z0-9]+$/.test(clusterResource.PhysicalResourceId ?? '')) refuse();
  if (selectors?.AdvancedEventSelectors?.length || selectors?.EventSelectors?.length !== 1) refuse();
  const selector = selectors.EventSelectors[0];
  if (selector.IncludeManagementEvents !== true || selector.ReadWriteType !== 'All' ||
      (selector.ExcludeManagementEventSources?.length ?? 0) !== 0 ||
      selector.DataResources?.length !== 1 ||
      selector.DataResources[0].Type !== 'AWS::S3::Object' ||
      selector.DataResources[0].Values?.length !== 1 ||
      selector.DataResources[0].Values[0] !== `arn:aws:s3:::${bucketResource.PhysicalResourceId}/`) refuse();
  if (trailStatus?.IsLogging !== true || trailStatus.LatestDeliveryError ||
      trailStatus.LatestCloudWatchLogsDeliveryError) refuse();
  return { account, region, stack: stackName, parentSha256: reviewedParentSha256,
    candidateSha256: reviewedCandidateSha256, physicalSelectorsMatch: true,
    deliveryHealthy: true, reviewable: true, executionAuthorized: false };
}

function aws(profile, ...args) {
  return JSON.parse(execFileSync('aws', [
    ...args, '--profile', profile, '--region', region, '--output', 'json',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

export function readLiveAuditParent(profile) {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) refuse();
  const caller = aws(profile, 'sts', 'get-caller-identity');
  if (caller.Account !== account) refuse();
  const stack = aws(profile, 'cloudformation', 'describe-stacks', '--stack-name', stackName).Stacks?.[0];
  const body = aws(profile, 'cloudformation', 'get-template', '--stack-name', stackName,
    '--template-stage', 'Original').TemplateBody;
  const template = typeof body === 'string' ? JSON.parse(body) : body;
  const resource = id => aws(profile, 'cloudformation', 'describe-stack-resource',
    '--stack-name', stackName, '--logical-resource-id', id).StackResourceDetail;
  const trailResource = resource('AuditTrail');
  const bucketResource = resource('ClinicalDocumentsBucket');
  const clusterResource = resource('ClinicalDatabaseCluster');
  if (trailResource?.PhysicalResourceId !== stackName) refuse();
  const selectors = aws(profile, 'cloudtrail', 'get-event-selectors', '--trail-name', stackName);
  const trailStatus = aws(profile, 'cloudtrail', 'get-trail-status', '--name', stackName);
  return assessAuditLiveParent({ caller, stack, template, trailResource, bucketResource,
    clusterResource, selectors, trailStatus });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--read-only-profile') {
    console.error('Usage: node scripts/check-aws-synthetic-data-api-audit-live-parent.mjs --read-only-profile <profile>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(readLiveAuditParent(process.argv[3]))); }
    catch { console.error('Synthetic Data API audit live parent refused'); process.exitCode = 1; }
  }
}
