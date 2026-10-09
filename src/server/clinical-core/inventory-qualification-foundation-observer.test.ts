import { expect, it } from 'vitest';
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical, inventorySha, type InventoryTemplate } from './inventory-qualification-artifacts';
import { INVENTORY_FOUNDATION_BASE, inventoryFoundationLifecycle, observeInventoryFoundation, type InventoryFoundationBinding } from './inventory-qualification-foundation-observer';
import { resolveInventoryTemplate, type InventoryStackRead } from './inventory-qualification-stack-observer';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';
import type { execFileSync } from 'node:child_process';

type R = Record<string, unknown>;
const account = '588966314750', region = 'us-east-2';
const arn = (service: string, tail: string) => `arn:aws:${service}:${region}:${account}:${tail}`;
const obj = (v: unknown) => v as R;
const arr = (v: unknown) => v as R[];
function fixture() {
  const template = buildQualificationFoundation() as InventoryTemplate;
  const binding: InventoryFoundationBinding = { foundationStackName: 'fictional-qualification-foundation',
    databaseClusterArn: String(template.Parameters.DatabaseClusterArn.AllowedValues![0]),
    databaseSecretArn: arn('secretsmanager', 'secret:rds!cluster-fictional-secret'), apiId: 'abcdefghij',
    apiOrigin: 'https://abcdefghij.execute-api.us-east-2.amazonaws.com',
    artifactBucket: `alp-qualification-code-${account}-${region}`, exportBucket: `alp-qualification-exports-${account}-${region}` };
  const stackId = arn('cloudformation', `stack/${binding.foundationStackName}/fictional`);
  const logs = '/aws/apigateway/qualification/abcdefghij', topic = arn('sns', 'ai-clinical-core-qualification-alarms');
  const refs = { Api: binding.apiId, ExportKey: '11111111-1111-4111-8111-111111111111', LogsKey: '22222222-2222-4222-8222-222222222222',
    CodeBucket: binding.artifactBucket, ExportBucket: binding.exportBucket, CodeBucketPolicy: binding.artifactBucket, ExportBucketPolicy: binding.exportBucket,
    AccessLogs: logs, Stage: '$default', AlarmTopic: topic, AlarmTopicPolicy: topic, ApiFailureAlarm: 'ai-clinical-core-qualification-api-failures' };
  const params = { DatabaseClusterArn: binding.databaseClusterArn, DatabaseSecretArn: binding.databaseSecretArn,
    BaseSourceCommit: INVENTORY_FOUNDATION_BASE, TemplateSha256: inventorySha(JSON.stringify(template, null, 2) + '\n') };
  const attributes = { 'ExportKey.Arn': arn('kms', `key/${refs.ExportKey}`), 'LogsKey.Arn': arn('kms', `key/${refs.LogsKey}`),
    'CodeBucket.Arn': `arn:aws:s3:::${binding.artifactBucket}`, 'ExportBucket.Arn': `arn:aws:s3:::${binding.exportBucket}`,
    'AccessLogs.Arn': arn('logs', `log-group:${logs}:*`), 'AlarmTopic.Arn': topic };
  const context = { template, parameters: { ...params, 'AWS::AccountId': account, 'AWS::Region': region, 'AWS::Partition': 'aws',
    'AWS::StackName': binding.foundationStackName, 'AWS::StackId': stackId }, refs, attributes };
  const properties = Object.fromEntries(Object.entries(template.Resources).map(([id, r]) => [id, obj(resolveInventoryTemplate(r.Properties, context))]));
  const snapshots: Record<string, unknown> = {
    'describe-stacks': { Stacks: [{ StackName: binding.foundationStackName, StackId: stackId, StackStatus: 'CREATE_COMPLETE',
      Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Outputs: Object.entries(template.Outputs).map(([OutputKey, v]) => ({ OutputKey, OutputValue: String(resolveInventoryTemplate(obj(v).Value, context)) })) }] },
    'get-template': { TemplateBody: template }, 'list-stack-resources': { StackResourceSummaries: Object.entries(template.Resources).map(([id, r]) => ({
      LogicalResourceId: id, ResourceType: r.Type, PhysicalResourceId: refs[id as keyof typeof refs], ResourceStatus: 'CREATE_COMPLETE' })) },
  };
  const responses = new Map<string, unknown>();
  const key = (s: string, o: string, p: unknown) => `${s}/${o}/${inventoryCanonical(p)}`;
  const set = (s: string, o: string, p: unknown, v: unknown) => responses.set(key(s, o, p), structuredClone(v));
  set('sts', 'get-caller-identity', {}, { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/OrganizationAccountAccessRole/fictional`, UserId: 'fictional-id' });
  for (const name of ['ExportKey', 'LogsKey'] as const) {
    const p = properties[name], KeyId = attributes[`${name}.Arn`];
    set('kms', 'describe-key', { KeyId }, { KeyMetadata: { AWSAccountId: account, KeyId: refs[name], Arn: KeyId, Enabled: true, KeyState: 'Enabled',
      KeyManager: 'CUSTOMER', Origin: 'AWS_KMS', KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT', CustomerMasterKeySpec: 'SYMMETRIC_DEFAULT',
      MultiRegion: false, Description: p.Description, EncryptionAlgorithms: ['SYMMETRIC_DEFAULT'] } });
    set('kms', 'get-key-rotation-status', { KeyId }, { KeyId, KeyRotationEnabled: true, RotationPeriodInDays: 365 });
    set('kms', 'get-key-policy', { KeyId, PolicyName: 'default' }, { Policy: JSON.stringify(p.KeyPolicy) });
    set('kms', 'list-grants', { KeyId }, { Grants: [], Truncated: false });
    set('kms', 'list-resource-tags', { KeyId }, { Tags: arr(p.Tags).map(t => ({ TagKey: t.Key, TagValue: t.Value })), Truncated: false });
  }
  for (const name of ['CodeBucket', 'ExportBucket'] as const) {
    const p = properties[name], params = { Bucket: refs[name], ExpectedBucketOwner: account };
    set('s3api', 'get-bucket-encryption', params, { ServerSideEncryptionConfiguration: { Rules: arr(obj(p.BucketEncryption).ServerSideEncryptionConfiguration)
      .map(q => ({ ApplyServerSideEncryptionByDefault: q.ServerSideEncryptionByDefault, BucketKeyEnabled: false })) } });
    set('s3api', 'get-bucket-ownership-controls', params, { OwnershipControls: p.OwnershipControls });
    set('s3api', 'get-public-access-block', params, { PublicAccessBlockConfiguration: p.PublicAccessBlockConfiguration });
    set('s3api', 'get-bucket-versioning', params, { Status: 'Enabled' }); set('s3api', 'get-bucket-notification-configuration', params, {});
    set('s3api', 'get-bucket-tagging', params, { TagSet: p.Tags });
    // Hand-written provider-shaped lifecycle, independent of the translator.
    set('s3api', 'get-bucket-lifecycle-configuration', params, { TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K', Rules: name === 'CodeBucket'
      ? [{ ID: 'AbortIncompleteCodeUploads', Filter: { Prefix: '' }, Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }]
      : [{ ID: 'AbortIncompleteExports', Filter: { Prefix: 'personal-exports/' }, Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
        { ID: 'ExpireNoncurrentExports', Filter: { Prefix: 'personal-exports/' }, Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
        { ID: 'ExpireCurrentExports', Filter: { Prefix: 'personal-exports/' }, Status: 'Enabled', Expiration: { Days: 3 } },
        { ID: 'RemoveExpiredDeleteMarkers', Filter: { Prefix: 'personal-exports/' }, Status: 'Enabled', Expiration: { ExpiredObjectDeleteMarker: true } }] });
    set('s3api', 'get-bucket-replication', params, null); set('s3api', 'get-object-lock-configuration', params, null);
    set('s3api', 'get-bucket-policy', params, { Policy: JSON.stringify(properties[name + 'Policy'].PolicyDocument) });
  }
  set('sns', 'get-topic-attributes', { TopicArn: topic }, { Attributes: { Owner: account, TopicArn: topic, DisplayName: '', KmsMasterKeyId: attributes['LogsKey.Arn'],
    Policy: JSON.stringify(properties.AlarmTopicPolicy.PolicyDocument), SubscriptionsPending: '0', SubscriptionsConfirmed: '1', SubscriptionsDeleted: '0',
    EffectiveDeliveryPolicy: JSON.stringify({ http: { defaultHealthyRetryPolicy: { minDelayTarget: 20, maxDelayTarget: 20, numRetries: 3,
      numMaxDelayRetries: 0, numNoDelayRetries: 0, numMinDelayRetries: 0, backoffFunction: 'linear' }, disableSubscriptionOverrides: false,
      defaultRequestPolicy: { headerContentType: 'text/plain; charset=UTF-8' } } }) } });
  set('sns', 'list-tags-for-resource', { ResourceArn: topic }, { Tags: properties.AlarmTopic.Tags });
  set('logs', 'describe-log-groups', { LogGroupNamePrefix: logs }, { logGroups: [{ logGroupName: logs, arn: attributes['AccessLogs.Arn'],
    retentionInDays: 30, kmsKeyId: attributes['LogsKey.Arn'], logGroupClass: 'STANDARD', storedBytes: 0 }] });
  set('logs', 'list-tags-for-resource', { ResourceArn: arn('logs', `log-group:${logs}`) }, { tags: Object.fromEntries(arr(properties.AccessLogs.Tags).map(t => [String(t.Key), t.Value])) });
  const AlarmArn = arn('cloudwatch', `alarm:${refs.ApiFailureAlarm}`), { Tags: _tags, ...alarm } = properties.ApiFailureAlarm;
  set('cloudwatch', 'describe-alarms', { AlarmNames: [refs.ApiFailureAlarm] }, { MetricAlarms: [{ ...alarm, AlarmArn, ActionsEnabled: true,
    DatapointsToAlarm: 1, StateValue: 'OK', StateUpdatedTimestamp: 'fictional-time' }], CompositeAlarms: [] });
  set('cloudwatch', 'list-tags-for-resource', { ResourceARN: AlarmArn }, { Tags: properties.ApiFailureAlarm.Tags });
  set('apigatewayv2', 'get-api', { ApiId: binding.apiId }, { ApiId: binding.apiId, ApiEndpoint: binding.apiOrigin, Name: properties.Api.Name,
    ProtocolType: 'HTTP', RouteSelectionExpression: '$request.method $request.path', ApiKeySelectionExpression: '$request.header.x-api-key', Tags: properties.Api.Tags });
  set('apigatewayv2', 'get-stages', { ApiId: binding.apiId }, { Items: [{ StageName: '$default', AutoDeploy: true,
    DefaultRouteSettings: properties.Stage.DefaultRouteSettings, AccessLogSettings: { ...obj(properties.Stage.AccessLogSettings), DestinationArn: arn('logs', `log-group:${logs}`) },
    DeploymentId: 'fixture', LastDeploymentStatusMessage: "Successfully deployed stage with deployment ID 'fixture'", Tags: properties.Stage.Tags }] });
  let calls = 0;
  const transport: InventoryServiceRead = async (s, o, p) => { calls++; const k = key(s, o, p); if (!responses.has(k)) throw Error('unmodeled fixture operation'); return structuredClone(responses.get(k)); };
  const stacks: InventoryStackRead = async (o, name) => { expect(name).toBe(binding.foundationStackName); return structuredClone(snapshots[o]); };
  return { binding, template, snapshots, properties, responses, transport, stacks, key, calls: () => calls };
}
it('observes all twelve foundation resources, principal and repeats read-only state without claiming a fleet or acceptance', async () => {
  const f = fixture(), report = await observeInventoryFoundation(f.binding, f.transport, f.stacks);
  expect(report.resources).toBe(12); expect(report.observations).toBeGreaterThan(35); expect(f.calls()).toBe(report.observations * 2);
  expect(report.principalVerified).toBe(true); expect(report.foundationInfrastructureVerified).toBe(true);
  for (const flag of ['dependenciesVerified', 'sharedApiInventoryVerified', 'uploadedVersionsVerified', 'wholeLedgerVerified', 'liveFleetVerified',
    'acceptance', 'alarmDeliveryVerified', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const) expect(report[flag]).toBe(false);
});
it('rejects altered infrastructure, missing resources, keys, policies, lifecycle, public API and stage settings from an admitted baseline', async () => {
  const baseline = fixture(); await observeInventoryFoundation(baseline.binding, baseline.transport, baseline.stacks);
  const changes: Array<[string, (r: R) => void]> = [];
  const matching = (s: string, o: string) => [...baseline.responses.keys()].find(k => k.startsWith(`${s}/${o}/`))!;
  const add = (s: string, o: string, mutate: (r: R) => void) => changes.push([matching(s, o), mutate]);
  add('sts', 'get-caller-identity', r => { r.Account = '173535830222'; });
  add('sts', 'get-caller-identity', r => { r.Arn = arn('iam', 'root'); });
  for (const [field, value] of Object.entries({ Enabled: false, KeyState: 'PendingDeletion', KeyManager: 'AWS', MultiRegion: true, Origin: 'EXTERNAL',
    Arn: 'foreign', AWSAccountId: '173535830222', CustomKeyStoreId: 'foreign', XksKeyConfiguration: {}, EncryptionAlgorithms: ['RSAES_OAEP_SHA_256'], UnknownSetting: true }))
    add('kms', 'describe-key', r => { obj(r.KeyMetadata)[field] = value; });
  add('kms', 'get-key-rotation-status', r => { r.KeyRotationEnabled = false; });
  add('kms', 'get-key-rotation-status', r => { r.RotationPeriodInDays = 730; });
  add('kms', 'list-grants', r => { r.Grants = [{ GranteePrincipal: 'foreign', Operations: ['Decrypt'] }]; });
  add('kms', 'list-grants', r => { r.NextMarker = 'unfinished'; });
  add('kms', 'get-key-policy', r => { const p = obj(JSON.parse(String(r.Policy))); arr(p.Statement).push({ Effect: 'Allow', Action: '*', Principal: '*', Resource: '*' }); r.Policy = JSON.stringify(p); });
  add('kms', 'list-resource-tags', r => { r.Truncated = true; });
  add('s3api', 'get-bucket-encryption', r => { arr(obj(r.ServerSideEncryptionConfiguration).Rules)[0].BucketKeyEnabled = true; });
  add('s3api', 'get-bucket-ownership-controls', r => { r.OwnershipControls = { Rules: [{ ObjectOwnership: 'ObjectWriter' }] }; });
  add('s3api', 'get-public-access-block', r => { obj(r.PublicAccessBlockConfiguration).BlockPublicAcls = false; });
  add('s3api', 'get-bucket-versioning', r => { r.Status = 'Suspended'; });
  add('s3api', 'get-bucket-notification-configuration', r => { r.EventBridgeConfiguration = {}; });
  add('s3api', 'get-bucket-lifecycle-configuration', r => { arr(r.Rules)[0].Filter = { Prefix: 'foreign/' }; });
  add('s3api', 'get-bucket-lifecycle-configuration', r => { arr(r.Rules).push({ ID: 'foreign', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } }); });
  add('s3api', 'get-bucket-policy', r => { r.Policy = JSON.stringify({ Statement: [] }); });
  add('sns', 'get-topic-attributes', r => { obj(r.Attributes).Owner = '173535830222'; });
  add('sns', 'get-topic-attributes', r => { obj(r.Attributes).KmsMasterKeyId = 'foreign'; });
  add('sns', 'get-topic-attributes', r => { obj(r.Attributes).DeliveryPolicy = '{}'; });
  add('sns', 'list-tags-for-resource', r => { arr(r.Tags).push({ Key: 'aws:foreign', Value: 'foreign' }); });
  add('logs', 'describe-log-groups', r => { arr(r.logGroups)[0].retentionInDays = 1; });
  add('cloudwatch', 'describe-alarms', r => { arr(r.MetricAlarms)[0].ActionsEnabled = false; });
  add('cloudwatch', 'describe-alarms', r => { arr(r.MetricAlarms)[0].AlarmActions = [arn('sns', 'foreign')]; });
  add('apigatewayv2', 'get-api', r => { r.CorsConfiguration = { AllowOrigins: ['*'] }; });
  add('apigatewayv2', 'get-stages', r => { arr(r.Items)[0].StageVariables = { target: 'foreign' }; });
  for (const [key, mutate] of changes) {
    const f = fixture(), response = obj(f.responses.get(key)), before = inventoryCanonical(response); mutate(response);
    expect(inventoryCanonical(response)).not.toBe(before); await expect(observeInventoryFoundation(f.binding, f.transport, f.stacks)).rejects.toThrow();
  }
  for (const operation of ['describe-stacks', 'get-template', 'list-stack-resources']) {
    const f = fixture();
    if (operation === 'describe-stacks') obj(arr(obj(f.snapshots[operation]).Stacks)[0]).StackStatus = 'UPDATE_ROLLBACK_COMPLETE';
    if (operation === 'get-template') obj(obj(f.snapshots[operation]).TemplateBody).Metadata = {};
    if (operation === 'list-stack-resources') arr(obj(f.snapshots[operation]).StackResourceSummaries).pop();
    await expect(observeInventoryFoundation(f.binding, f.transport, f.stacks)).rejects.toThrow();
  }
});
it('distinguishes legacy Prefix syntax without discarding a tag filter, date, transition or missing rule', () => {
  const declared = { Rules: [{ Id: 'test', Status: 'Enabled', Prefix: 'test/', ExpirationInDays: 3 }] };
  const baseline = { Rules: [{ ID: 'test', Status: 'Enabled', Prefix: 'test/', Expiration: { Days: 3 } }] };
  expect(() => inventoryFoundationLifecycle(baseline, declared)).not.toThrow();
  const changes = [
    { ...baseline, Rules: [{ ...baseline.Rules[0], Filter: { Prefix: 'test/' } }] },
    { Rules: [{ ID: 'test', Status: 'Enabled', Filter: { Prefix: 'test/', Tag: { Key: 'bypass', Value: 'yes' } }, Expiration: { Days: 3 } }] },
    { Rules: [{ ...baseline.Rules[0], Transitions: [{ Days: 1, StorageClass: 'GLACIER' }] }] },
    { Rules: [{ ...baseline.Rules[0], Expiration: { Date: '2026-10-10' } }] },
    { Rules: [] }, { Rules: [baseline.Rules[0], baseline.Rules[0]] },
  ];
  for (const changed of changes) expect(() => inventoryFoundationLifecycle(changed, declared)).toThrow();
});
it('refuses a changing read but tolerates only documented operational counters without claiming delivery', async () => {
  const f = fixture(); let callers = 0;
  await expect(observeInventoryFoundation(f.binding, async (s, o, p) => {
    const r = await f.transport(s, o, p); if (s === 'sts' && ++callers === 2) obj(r).UserId = 'different'; return r;
  }, f.stacks)).rejects.toThrow();
  const counters = fixture(); let reads = 0;
  const report = await observeInventoryFoundation(counters.binding, async (s, o, p) => {
    const r = await counters.transport(s, o, p);
    if (s === 'sns' && o === 'get-topic-attributes') obj(obj(r).Attributes).SubscriptionsConfirmed = String(++reads);
    return r;
  }, counters.stacks);
  expect(report.alarmDeliveryVerified).toBe(false); expect(report.acceptance).toBe(false);
});
it('allows no secret contents, key mutation or caller profile overrides through the actual read transport', async () => {
  const calls: string[][] = [];
  const execute = ((_file: string, args: string[]) => { calls.push(args); return '{}'; }) as unknown as typeof execFileSync;
  const read = inventoryServiceReader(execute);
  await read('cloudwatch', 'list-tags-for-resource', { ResourceARN: 'fictional' });
  expect(calls[0]).toContain('--resource-arn'); expect(calls[0]).not.toContain('--resource-a-r-n');
  await expect(read('secretsmanager', 'get-secret-value', { SecretId: 'fictional' })).rejects.toThrow();
  await expect(read('kms', 'create-grant', { KeyId: 'fictional' })).rejects.toThrow();
  await expect(read('sns', 'subscribe', { TopicArn: 'fictional' })).rejects.toThrow();
  await expect(read('sts', 'get-caller-identity', { Profile: 'production' })).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
