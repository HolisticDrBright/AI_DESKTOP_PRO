if (typeof window !== 'undefined') throw Error('inventory qualification foundation observation is server-only');
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha, type InventoryCandidateArtifact, type InventoryTemplate } from './inventory-qualification-artifacts';
import { inventoryObservedPolicy, inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';
import { inspectInventoryStackDeclarations, inventoryStackReader, type InventoryStackRead } from './inventory-qualification-stack-observer';
import type { InventoryCandidateTarget } from './inventory-qualification-target';

const account = '588966314750', region = 'us-east-2';
// The infrastructure preparation has its own historical source identity. It is
// never substituted for the current candidate fleet's source identity.
export const INVENTORY_FOUNDATION_BASE = '12bc93e4e372b99fa91446463fa40b36376077ff';
export type InventoryFoundationBinding = { foundationStackName: string; databaseClusterArn: string; databaseSecretArn: string;
  apiId: string; apiOrigin: string; artifactBucket: string; exportBucket: string };
type Row = Record<string, unknown>;
const object = (v: unknown): Row => inventoryRecord(v) ? v : inventoryRefuse('foundation_shape_refused');
const rows = (v: unknown): Row[] => Array.isArray(v) && v.length <= 512 ? v.map(object) : inventoryRefuse('foundation_shape_refused');
const equal = (a: unknown, b: unknown) => { if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('foundation_configuration_refused'); };
const sorted = (v: unknown): Row[] => rows(v).sort((a, b) => inventoryCanonical(a).localeCompare(inventoryCanonical(b)));
function fields(v: Row, names: string[]) { if (Object.keys(v).some(k => !names.includes(k))) inventoryRefuse('foundation_property_coverage_refused'); }
function parse(v: unknown): unknown {
  if (typeof v !== 'string' || v.length > 2 * 1024 * 1024) return inventoryRefuse('foundation_shape_refused');
  try { return JSON.parse(v); } catch { return inventoryRefuse('foundation_shape_refused'); }
}
function validateBinding(b: InventoryFoundationBinding) {
  if (!inventoryRecord(b) || Object.keys(b).sort().join(',') !== 'apiId,apiOrigin,artifactBucket,databaseClusterArn,databaseSecretArn,exportBucket,foundationStackName'
    || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(b.foundationStackName) || !/^[a-z0-9]{10}$/.test(b.apiId)
    || b.apiOrigin !== `https://${b.apiId}.execute-api.${region}.amazonaws.com`
    || b.artifactBucket !== `alp-qualification-code-${account}-${region}` || b.exportBucket !== `alp-qualification-exports-${account}-${region}`)
    return inventoryRefuse('foundation_binding_refused');
  const template = buildQualificationFoundation();
  if (!template.Parameters.DatabaseClusterArn.AllowedValues.includes(b.databaseClusterArn)
    || !new RegExp(template.Parameters.DatabaseSecretArn.AllowedPattern).test(b.databaseSecretArn)) return inventoryRefuse('foundation_binding_refused');
}
function tags(input: unknown, expected: unknown, stackId: string, stackName: string, logicalId: string, map = false) {
  const raw = map ? Object.entries(object(input)).map(([Key, Value]) => ({ Key, Value })) : rows(input);
  const keys = raw.map(t => t.Key);
  if (keys.some(k => typeof k !== 'string') || new Set(keys).size !== keys.length) return inventoryRefuse('foundation_tags_refused');
  const platform: Row = { 'aws:cloudformation:stack-id': stackId, 'aws:cloudformation:stack-name': stackName, 'aws:cloudformation:logical-id': logicalId };
  const own = raw.filter(t => {
    fields(t, ['Key', 'Value']);
    if (!String(t.Key).startsWith('aws:')) return true;
    if (!Object.hasOwn(platform, String(t.Key)) || platform[String(t.Key)] !== t.Value) return inventoryRefuse('foundation_tags_refused');
    return false;
  });
  equal(sorted(own), sorted(inventoryRecord(expected) ? Object.entries(expected).map(([Key, Value]) => ({ Key, Value })) : expected));
}

/** Translate only this foundation's declared rules. Tags, sizes, transitions,
 * dates, duplicate IDs and extra actions never collapse into an equivalent
 * prefix. Candidate bucket checks still require absent undeclared lifecycle. */
export function inventoryFoundationLifecycle(input: unknown, declared: unknown) {
  const actual = object(input); fields(actual, ['Rules', 'TransitionDefaultMinimumObjectSize']);
  equal(actual.TransitionDefaultMinimumObjectSize ?? 'all_storage_classes_128K', 'all_storage_classes_128K');
  const desired = rows(object(declared).Rules).map(r => {
    fields(r, ['Id', 'Status', 'Prefix', 'AbortIncompleteMultipartUpload', 'NoncurrentVersionExpiration', 'ExpirationInDays', 'ExpiredObjectDeleteMarker']);
    const rule: Row = { ID: r.Id, Status: r.Status, Filter: { Prefix: r.Prefix ?? '' } };
    if (r.AbortIncompleteMultipartUpload !== undefined) rule.AbortIncompleteMultipartUpload = r.AbortIncompleteMultipartUpload;
    if (r.NoncurrentVersionExpiration !== undefined) rule.NoncurrentVersionExpiration = r.NoncurrentVersionExpiration;
    if (r.ExpirationInDays !== undefined) rule.Expiration = { Days: r.ExpirationInDays };
    if (r.ExpiredObjectDeleteMarker !== undefined) rule.Expiration = { ExpiredObjectDeleteMarker: r.ExpiredObjectDeleteMarker };
    return rule;
  });
  const observed = rows(actual.Rules).map((r): Row => {
    fields(r, ['ID', 'Status', 'Prefix', 'Filter', 'AbortIncompleteMultipartUpload', 'NoncurrentVersionExpiration', 'Expiration']);
    if (r.Filter !== undefined && r.Prefix !== undefined) return inventoryRefuse('foundation_lifecycle_refused');
    if (r.Filter !== undefined) fields(object(r.Filter), ['Prefix']);
    const { Prefix, ...rest } = r;
    return { ...rest, Filter: r.Filter ?? { Prefix: Prefix ?? '' } };
  });
  const ids = observed.map(r => r.ID);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return inventoryRefuse('foundation_lifecycle_refused');
  equal(sorted(observed), sorted(desired));
}

function configuration(service: string, operation: string, supplied: unknown): unknown {
  const value = structuredClone(supplied);
  const omit = (r: unknown, names: string[]) => { if (inventoryRecord(r)) for (const name of names) delete r[name]; };
  if (service === 'logs' && operation === 'describe-log-groups' && inventoryRecord(value)) for (const r of rows(value.logGroups)) omit(r, ['storedBytes']);
  if (service === 'cloudwatch' && operation === 'describe-alarms' && inventoryRecord(value)) for (const r of rows(value.MetricAlarms))
    omit(r, ['StateValue', 'StateReason', 'StateReasonData', 'StateUpdatedTimestamp', 'StateTransitionedTimestamp']);
  if (service === 'kms' && operation === 'get-key-rotation-status') omit(value, ['NextRotationDate']);
  if (service === 'sns' && operation === 'get-topic-attributes' && inventoryRecord(value))
    omit(value.Attributes, ['SubscriptionsPending', 'SubscriptionsConfirmed', 'SubscriptionsDeleted']);
  return value;
}

/** Actual infrastructure reads only. Does not read secret values, provider
 * keys, clinical records or subscription endpoints. Repeated reads detect
 * ordinary drift, not atomicity. No caller assertion can issue acceptance. */
export async function observeInventoryFoundation(supplied: InventoryFoundationBinding,
  transport: InventoryServiceRead = inventoryServiceReader(), stacks: InventoryStackRead = inventoryStackReader()) {
  const b = structuredClone(supplied); validateBinding(b);
  const observations: Array<{ service: string; operation: string; parameters: Record<string, string | string[]>; digest: string }> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    const value = await transport(service, operation, parameters);
    observations.push({ service, operation, parameters: structuredClone(parameters), digest: inventorySha(inventoryCanonical(configuration(service, operation, value))) });
    return value;
  };
  const caller = object(await read('sts', 'get-caller-identity', {}));
  if (caller.Account !== account || typeof caller.Arn !== 'string'
    || !caller.Arn.startsWith(`arn:aws:sts::${account}:assumed-role/OrganizationAccountAccessRole/`)
    || typeof caller.UserId !== 'string' || !caller.UserId.length) return inventoryRefuse('foundation_principal_refused');
  const template = buildQualificationFoundation() as InventoryTemplate;
  const templateSha256 = inventorySha(JSON.stringify(template, null, 2) + '\n');
  const artifact: InventoryCandidateArtifact = { candidate: 'qualification-foundation', templateSha256, manifestSha256: templateSha256,
    template, packages: [], bindings: [] };
  const candidate: InventoryCandidateTarget = { candidate: artifact.candidate, stackName: b.foundationStackName, templateSha256,
    manifestSha256: templateSha256, packages: [], parameters: { DatabaseClusterArn: b.databaseClusterArn, DatabaseSecretArn: b.databaseSecretArn,
      BaseSourceCommit: INVENTORY_FOUNDATION_BASE, TemplateSha256: templateSha256 } };
  const initial = { stack: await stacks('describe-stacks', b.foundationStackName), template: await stacks('get-template', b.foundationStackName),
    resources: await stacks('list-stack-resources', b.foundationStackName) };
  const snapshot = inspectInventoryStackDeclarations(candidate, artifact, initial), o = snapshot.outputs;
  for (const [name, value] of Object.entries({ ApiId: b.apiId, ApiOrigin: b.apiOrigin, CodeBucket: b.artifactBucket, ExportBucketName: b.exportBucket })) equal(o[name], value);
  const covered = new Set<string>();
  for (const r of snapshot.resources) {
    const p = r.properties, id = r.physicalId;
    const resourceTags = (input: unknown, map = false) => tags(input, p.Tags ?? [], snapshot.stackId, b.foundationStackName, r.logicalId, map);
    if (r.type === 'AWS::KMS::Key') {
      fields(p, ['Description', 'EnableKeyRotation', 'PendingWindowInDays', 'Tags', 'KeyPolicy']);
      equal(p.PendingWindowInDays, 30);
      const keyArn = `arn:aws:kms:${region}:${account}:key/${id}`, params = { KeyId: keyArn };
      const key = object(object(await read('kms', 'describe-key', params)).KeyMetadata);
      fields(key, ['AWSAccountId', 'KeyId', 'Arn', 'CreationDate', 'Enabled', 'Description', 'KeyUsage', 'KeyState', 'Origin', 'KeyManager',
        'CustomerMasterKeySpec', 'KeySpec', 'EncryptionAlgorithms', 'MultiRegion', 'CurrentKeyMaterialId', 'DeletionDate', 'ExpirationModel',
        'ValidTo', 'CustomKeyStoreId', 'XksKeyConfiguration']);
      for (const [name, expected] of Object.entries({ AWSAccountId: account, KeyId: id, Arn: keyArn, Enabled: true, KeyState: 'Enabled', KeyManager: 'CUSTOMER',
        Origin: 'AWS_KMS', KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT', CustomerMasterKeySpec: 'SYMMETRIC_DEFAULT', MultiRegion: false, Description: p.Description })) equal(key[name], expected);
      equal(key.EncryptionAlgorithms, ['SYMMETRIC_DEFAULT']);
      if (key.DeletionDate !== undefined || key.ExpirationModel !== undefined && key.ExpirationModel !== 'KEY_MATERIAL_DOES_NOT_EXPIRE'
        || key.ValidTo !== undefined || key.CustomKeyStoreId !== undefined || key.XksKeyConfiguration !== undefined) return inventoryRefuse('foundation_key_refused');
      const rotation = object(await read('kms', 'get-key-rotation-status', params));
      fields(rotation, ['KeyId', 'KeyRotationEnabled', 'RotationPeriodInDays', 'NextRotationDate', 'OnDemandRotationStartDate']);
      equal(rotation.KeyId, keyArn); equal(rotation.KeyRotationEnabled, p.EnableKeyRotation);
      equal(rotation.RotationPeriodInDays ?? 365, 365); if (rotation.OnDemandRotationStartDate !== undefined) return inventoryRefuse('foundation_key_refused');
      const policy = object(await read('kms', 'get-key-policy', { ...params, PolicyName: 'default' }));
      equal(inventoryObservedPolicy(policy.Policy), inventoryObservedPolicy(p.KeyPolicy));
      const grants = object(await read('kms', 'list-grants', params)); fields(grants, ['Grants', 'Truncated', 'NextMarker']);
      equal(grants.Grants, []); if (grants.Truncated === true || grants.NextMarker !== undefined) return inventoryRefuse('foundation_key_grants_refused');
      const keyTags = object(await read('kms', 'list-resource-tags', params)); if (keyTags.Truncated === true || keyTags.NextMarker !== undefined) return inventoryRefuse('foundation_tags_refused');
      resourceTags(rows(keyTags.Tags).map(t => { fields(t, ['TagKey', 'TagValue']); return { Key: t.TagKey, Value: t.TagValue }; }));
    } else if (r.type === 'AWS::S3::Bucket') {
      fields(p, ['BucketName', 'PublicAccessBlockConfiguration', 'OwnershipControls', 'VersioningConfiguration', 'BucketEncryption', 'LifecycleConfiguration', 'Tags']);
      const params = { Bucket: id, ExpectedBucketOwner: account };
      const encryption = object(await read('s3api', 'get-bucket-encryption', params));
      const rules = rows(object(encryption.ServerSideEncryptionConfiguration).Rules).map(q => {
        fields(q, ['BucketKeyEnabled', 'ApplyServerSideEncryptionByDefault', 'BlockedEncryptionTypes']);
        // This foundation needs service-managed encryption. Missing or altered
        // customer-key blocking is not interpreted as equivalent protection.
        equal(q.BlockedEncryptionTypes, { EncryptionType: ['SSE-C'] });
        if (q.BucketKeyEnabled === true) return inventoryRefuse('foundation_bucket_refused');
        return { ServerSideEncryptionByDefault: q.ApplyServerSideEncryptionByDefault };
      });
      equal(rules, object(p.BucketEncryption).ServerSideEncryptionConfiguration);
      equal(object(await read('s3api', 'get-bucket-ownership-controls', params)).OwnershipControls, p.OwnershipControls);
      equal(object(await read('s3api', 'get-public-access-block', params)).PublicAccessBlockConfiguration, p.PublicAccessBlockConfiguration);
      const versioning = object(await read('s3api', 'get-bucket-versioning', params)); fields(versioning, ['Status', 'MFADelete']); equal(versioning.Status, 'Enabled');
      if (versioning.MFADelete !== undefined && versioning.MFADelete !== 'Disabled') return inventoryRefuse('foundation_bucket_refused');
      equal(await read('s3api', 'get-bucket-notification-configuration', params), {});
      resourceTags(object(await read('s3api', 'get-bucket-tagging', params)).TagSet);
      inventoryFoundationLifecycle(await read('s3api', 'get-bucket-lifecycle-configuration', params), p.LifecycleConfiguration);
      for (const operation of ['get-bucket-replication', 'get-object-lock-configuration'])
        if (await read('s3api', operation, params) !== null) return inventoryRefuse('foundation_bucket_refused');
    } else if (r.type === 'AWS::S3::BucketPolicy') {
      fields(p, ['Bucket', 'PolicyDocument']); equal(id, p.Bucket);
      equal(inventoryObservedPolicy(object(await read('s3api', 'get-bucket-policy', { Bucket: String(p.Bucket), ExpectedBucketOwner: account })).Policy), inventoryObservedPolicy(p.PolicyDocument));
    } else if (r.type === 'AWS::SNS::Topic' || r.type === 'AWS::SNS::TopicPolicy') {
      if (r.type === 'AWS::SNS::TopicPolicy') continue; // Checked with the topic, including its exact resource mapping.
      fields(p, ['TopicName', 'KmsMasterKeyId', 'Tags']);
      const a = object(object(await read('sns', 'get-topic-attributes', { TopicArn: id })).Attributes);
      fields(a, ['Owner', 'TopicArn', 'DisplayName', 'KmsMasterKeyId', 'Policy', 'SubscriptionsPending', 'SubscriptionsConfirmed', 'SubscriptionsDeleted', 'EffectiveDeliveryPolicy']);
      equal(a.Owner, account); equal(a.TopicArn, id); equal(a.DisplayName, ''); equal(a.KmsMasterKeyId, p.KmsMasterKeyId);
      for (const counter of ['SubscriptionsPending', 'SubscriptionsConfirmed', 'SubscriptionsDeleted']) if (typeof a[counter] !== 'string' || !/^\d+$/.test(String(a[counter]))) return inventoryRefuse('foundation_topic_refused');
      // The provider's default HTTP retry policy is not a delivery guarantee.
      equal(parse(a.EffectiveDeliveryPolicy), { http: { defaultHealthyRetryPolicy: { minDelayTarget: 20, maxDelayTarget: 20, numRetries: 3,
        numMaxDelayRetries: 0, numNoDelayRetries: 0, numMinDelayRetries: 0, backoffFunction: 'linear' }, disableSubscriptionOverrides: false,
        defaultRequestPolicy: { headerContentType: 'text/plain; charset=UTF-8' } } });
      const policies = snapshot.resources.filter(x => x.type === 'AWS::SNS::TopicPolicy');
      if (policies.length !== 1) return inventoryRefuse('foundation_topic_refused');
      const policy = policies[0]; fields(policy.properties, ['Topics', 'PolicyDocument']); equal(policy.physicalId, id); equal(policy.properties.Topics, [id]);
      equal(inventoryObservedPolicy(a.Policy), inventoryObservedPolicy(policy.properties.PolicyDocument)); covered.add(policy.logicalId);
      resourceTags(object(await read('sns', 'list-tags-for-resource', { ResourceArn: id })).Tags);
    } else if (r.type === 'AWS::Logs::LogGroup') {
      fields(p, ['LogGroupName', 'RetentionInDays', 'KmsKeyId', 'Tags']);
      const groups = object(await read('logs', 'describe-log-groups', { LogGroupNamePrefix: id })); if (groups.nextToken !== undefined) return inventoryRefuse('foundation_logs_refused');
      const found = rows(groups.logGroups); if (found.length !== 1) return inventoryRefuse('foundation_logs_refused'); const g = found[0];
      equal(g.logGroupName, id); equal(g.arn, `arn:aws:logs:${region}:${account}:log-group:${id}:*`); equal(g.retentionInDays, p.RetentionInDays); equal(g.kmsKeyId, p.KmsKeyId);
      equal(g.logGroupClass ?? 'STANDARD', 'STANDARD');
      resourceTags(object(await read('logs', 'list-tags-for-resource', { ResourceArn: `arn:aws:logs:${region}:${account}:log-group:${id}` })).tags, true);
    } else if (r.type === 'AWS::CloudWatch::Alarm') {
      fields(p, ['AlarmName', 'AlarmDescription', 'Namespace', 'MetricName', 'Dimensions', 'Statistic', 'Period', 'EvaluationPeriods', 'Threshold',
        'ComparisonOperator', 'TreatMissingData', 'AlarmActions', 'Tags']);
      const output = object(await read('cloudwatch', 'describe-alarms', { AlarmNames: [id] }));
      if (output.NextToken !== undefined || rows(output.CompositeAlarms ?? []).length || rows(output.MetricAlarms).length !== 1) return inventoryRefuse('foundation_alarm_refused');
      const actual = rows(output.MetricAlarms)[0];
      for (const [name, expected] of Object.entries(p)) if (name !== 'Tags') equal(name === 'Dimensions' ? sorted(actual[name]) : actual[name], name === 'Dimensions' ? sorted(expected) : expected);
      equal(actual.ActionsEnabled, true); equal(actual.DatapointsToAlarm ?? p.EvaluationPeriods, p.EvaluationPeriods);
      if (rows(actual.OKActions ?? []).length || rows(actual.InsufficientDataActions ?? []).length || actual.Metrics !== undefined || actual.ExtendedStatistic !== undefined
        || actual.Unit !== undefined || actual.EvaluationCriteria !== undefined || actual.EvaluationWindow !== undefined || actual.EvaluationInterval !== undefined) return inventoryRefuse('foundation_alarm_refused');
      const alarmArn = `arn:aws:cloudwatch:${region}:${account}:alarm:${id}`; equal(actual.AlarmArn, alarmArn);
      resourceTags(object(await read('cloudwatch', 'list-tags-for-resource', { ResourceARN: alarmArn })).Tags);
    } else if (r.type === 'AWS::ApiGatewayV2::Api') {
      fields(p, ['Name', 'ProtocolType', 'Tags']); const api = object(await read('apigatewayv2', 'get-api', { ApiId: id }));
      fields(api, ['ApiId', 'ApiEndpoint', 'ApiKeySelectionExpression', 'CreatedDate', 'DisableExecuteApiEndpoint', 'IpAddressType', 'Name', 'ProtocolType',
        'RouteSelectionExpression', 'Tags', 'ApiGatewayManaged', 'DisableSchemaValidation']);
      equal(api.ApiId, b.apiId); equal(api.ApiEndpoint, b.apiOrigin); equal(api.Name, p.Name); equal(api.ProtocolType, p.ProtocolType);
      equal(api.RouteSelectionExpression, '$request.method $request.path'); equal(api.ApiKeySelectionExpression, '$request.header.x-api-key');
      equal(api.DisableExecuteApiEndpoint ?? false, false); equal(api.IpAddressType ?? 'ipv4', 'ipv4'); equal(api.ApiGatewayManaged ?? false, false); equal(api.DisableSchemaValidation ?? false, false);
      resourceTags(api.Tags, true);
    } else if (r.type === 'AWS::ApiGatewayV2::Stage') {
      fields(p, ['ApiId', 'StageName', 'AutoDeploy', 'DefaultRouteSettings', 'AccessLogSettings', 'Tags']);
      const output = object(await read('apigatewayv2', 'get-stages', { ApiId: String(p.ApiId) })); fields(output, ['Items', 'NextToken']);
      if (output.NextToken !== undefined || rows(output.Items).length !== 1) return inventoryRefuse('foundation_stage_refused'); const stage = rows(output.Items)[0];
      fields(stage, ['StageName', 'AutoDeploy', 'DefaultRouteSettings', 'AccessLogSettings', 'Tags', 'CreatedDate', 'DeploymentId',
        'LastDeploymentStatusMessage', 'LastUpdatedDate', 'RouteSettings', 'StageVariables', 'ApiGatewayManaged']);
      equal(stage.StageName, '$default'); equal(stage.AutoDeploy, true); equal(stage.DefaultRouteSettings, p.DefaultRouteSettings);
      equal(stage.RouteSettings ?? {}, {}); equal(stage.StageVariables ?? {}, {}); equal(stage.ApiGatewayManaged ?? false, false);
      const log = object(p.AccessLogSettings); equal(stage.AccessLogSettings, { ...log, DestinationArn: String(log.DestinationArn).replace(/:\*$/, '') });
      if (typeof stage.DeploymentId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(stage.DeploymentId)
        || stage.LastDeploymentStatusMessage !== `Successfully deployed stage with deployment ID '${stage.DeploymentId}'`) return inventoryRefuse('foundation_stage_refused');
      resourceTags(stage.Tags, true);
    } else return inventoryRefuse('foundation_resource_coverage_refused');
    covered.add(r.logicalId);
  }
  equal([...covered].sort(), snapshot.resources.map(r => r.logicalId).sort());
  for (const observation of observations) equal(inventorySha(inventoryCanonical(configuration(observation.service, observation.operation,
    await transport(observation.service, observation.operation, observation.parameters)))), observation.digest);
  equal(initial, { stack: await stacks('describe-stacks', b.foundationStackName), template: await stacks('get-template', b.foundationStackName),
    resources: await stacks('list-stack-resources', b.foundationStackName) });
  return { contract: 'inventory-qualification-foundation-observation/1', principalVerified: true, foundationInfrastructureVerified: true,
    foundationStackId: snapshot.stackId, foundationBaseSourceCommit: INVENTORY_FOUNDATION_BASE, foundationTemplateSha256: templateSha256,
    resources: covered.size, observations: observations.length, observationSha256: inventorySha(inventoryCanonical(observations)),
    dependenciesVerified: false, sharedApiInventoryVerified: false, uploadedVersionsVerified: false, wholeLedgerVerified: false,
    liveFleetVerified: false, acceptance: false, alarmDeliveryVerified: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
}
