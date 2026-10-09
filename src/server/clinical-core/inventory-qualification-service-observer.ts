if (typeof window !== 'undefined') throw Error('inventory qualification service observation is server-only');
import { execFileSync } from 'node:child_process';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha, type InventoryCandidateArtifact } from './inventory-qualification-artifacts';
import { inventoryCondition, type InventoryCandidateTarget } from './inventory-qualification-target';
import { inspectInventoryStackDeclarations, type InventoryResolvedResource, type InventoryStackSnapshot } from './inventory-qualification-stack-observer';

const account = '588966314750', region = 'us-east-2';
type Params = Record<string, string | string[]>;
export type InventoryServiceRead = (service: string, operation: string, parameters: Params) => Promise<unknown>;
const operations: Record<string, string[]> = {
  'lambda/get-function-configuration': ['FunctionName'], 'lambda/get-function-concurrency': ['FunctionName'],
  'lambda/get-policy': ['FunctionName'], 'lambda/get-function-url-config': ['FunctionName'],
  'lambda/get-function-event-invoke-config': ['FunctionName', 'Qualifier'],
  'lambda/list-aliases': ['FunctionName'], 'lambda/list-versions-by-function': ['FunctionName'],
  'iam/get-role': ['RoleName'], 'iam/list-role-policies': ['RoleName'], 'iam/get-role-policy': ['RoleName', 'PolicyName'],
  'iam/list-attached-role-policies': ['RoleName'], 'logs/describe-log-groups': ['LogGroupNamePrefix'],
  'apigatewayv2/get-authorizer': ['ApiId', 'AuthorizerId'], 'apigatewayv2/get-integration': ['ApiId', 'IntegrationId'],
  'apigatewayv2/get-route': ['ApiId', 'RouteId'], 'apigatewayv2/get-api': ['ApiId'], 'apigatewayv2/get-stages': ['ApiId'],
  'cloudwatch/describe-alarms': ['AlarmNames'], 'events/describe-rule': ['Name'], 'events/list-targets-by-rule': ['Rule'],
  'dynamodb/describe-table': ['TableName'], 'dynamodb/describe-continuous-backups': ['TableName'],
  'dynamodb/describe-time-to-live': ['TableName'], 'dynamodb/list-tags-of-resource': ['ResourceArn'], 'dynamodb/get-resource-policy': ['ResourceArn'],
  's3api/get-bucket-encryption': ['Bucket', 'ExpectedBucketOwner'], 's3api/get-bucket-versioning': ['Bucket', 'ExpectedBucketOwner'],
  's3api/get-bucket-ownership-controls': ['Bucket', 'ExpectedBucketOwner'], 's3api/get-public-access-block': ['Bucket', 'ExpectedBucketOwner'],
  's3api/get-bucket-notification-configuration': ['Bucket', 'ExpectedBucketOwner'], 's3api/get-bucket-tagging': ['Bucket', 'ExpectedBucketOwner'],
  's3api/get-bucket-policy': ['Bucket', 'ExpectedBucketOwner'], 's3api/get-bucket-lifecycle-configuration': ['Bucket', 'ExpectedBucketOwner'],
  's3api/get-bucket-replication': ['Bucket', 'ExpectedBucketOwner'], 's3api/get-object-lock-configuration': ['Bucket', 'ExpectedBucketOwner'],
  'stepfunctions/describe-state-machine': ['StateMachineArn'],
  'sqs/get-queue-attributes': ['QueueUrl', 'AttributeNames'], 'sqs/list-queue-tags': ['QueueUrl'],
};
// Absence is permitted only for explicitly absent optional configurations. It
// never turns AccessDenied, a timeout, an unknown provider error, or a missing
// required resource into a successfully observed state.
const absent: Record<string, string[]> = {
  'lambda/get-policy': ['ResourceNotFoundException'], 'lambda/get-function-url-config': ['ResourceNotFoundException'],
  'dynamodb/get-resource-policy': ['PolicyNotFoundException'],
  's3api/get-bucket-lifecycle-configuration': ['NoSuchLifecycleConfiguration'],
  's3api/get-bucket-replication': ['ReplicationConfigurationNotFoundError'],
  's3api/get-object-lock-configuration': ['ObjectLockConfigurationNotFoundError'],
  's3api/get-bucket-tagging': ['NoSuchTagSet'],
};
const awsOperationNames: Record<string, string> = { 'get-policy': 'GetPolicy', 'get-function-url-config': 'GetFunctionUrlConfig',
  'get-resource-policy': 'GetResourcePolicy', 'get-bucket-lifecycle-configuration': 'GetBucketLifecycleConfiguration',
  'get-bucket-replication': 'GetBucketReplication', 'get-object-lock-configuration': 'GetObjectLockConfiguration', 'get-bucket-tagging': 'GetBucketTagging' };
export function inventoryServiceReader(execute: typeof execFileSync = execFileSync): InventoryServiceRead {
  return async (service, operation, parameters) => {
    const key = `${service}/${operation}`, names = operations[key];
    if (!names || Object.keys(parameters).sort().join(',') !== [...names].sort().join(',')) return inventoryRefuse('service_read_operation_refused');
    const args = [service, operation];
    for (const name of names) {
      const values = Array.isArray(parameters[name]) ? parameters[name] as string[] : [parameters[name]];
      if (!values.length || values.length > 100 || values.some(v => typeof v !== 'string' || !v.length || v.length > 2048 || v.startsWith('-') || /[\x00-\x1f\x7f]/.test(v))) return inventoryRefuse('service_read_operation_refused');
      args.push('--' + name.replace(/[A-Z]/g, (v, n) => (n ? '-' : '') + v.toLowerCase()), ...values);
    }
    if (Object.hasOwn(parameters, 'ExpectedBucketOwner') && parameters.ExpectedBucketOwner !== account) return inventoryRefuse('service_read_operation_refused');
    args.push('--profile', 'ai-synthetic-member', '--region', region, '--output', 'json', '--no-cli-pager');
    try { return JSON.parse(String(execute('aws', args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '1', AWS_CLI_AUTO_PROMPT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] }))); }
    catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim().replace(/^aws: \[ERROR\]: /, '') : '';
      const codes = absent[key] ?? [], providerOperation = awsOperationNames[operation];
      if (codes.some(code => stderr.startsWith(`An error occurred (${code}) when calling the ${providerOperation} operation: `))) return null;
      return inventoryRefuse('service_aws_read_failed');
    }
  };
}
const same = (a: unknown, b: unknown, category = 'service_configuration_refused') => {
  if (a === undefined || b === undefined) {
    if (a !== b) inventoryRefuse(category);
    return;
  }
  if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse(category);
};
const record = (v: unknown): Record<string, unknown> => inventoryRecord(v) ? v : inventoryRefuse('service_shape_refused');
const list = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 4096 ? v : inventoryRefuse('service_shape_refused');
const string = (v: unknown): string => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x1f]/.test(v) ? v : inventoryRefuse('service_shape_refused');
const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  if (v.length > 2 * 1024 * 1024) return inventoryRefuse('service_shape_refused');
  try { return JSON.parse(v); } catch { return inventoryRefuse('service_shape_refused'); }
};
function properties(r: InventoryResolvedResource, allowed: string[]) {
  if (Object.keys(r.properties).some(k => !allowed.includes(k))) return inventoryRefuse('service_property_coverage_refused');
  return r.properties;
}
function ordered(v: unknown): unknown[] { return list(v).map(v => structuredClone(v)).sort((a, b) => inventoryCanonical(a).localeCompare(inventoryCanonical(b))); }
export function inventoryObservedPolicy(input: unknown): unknown {
  let value = input;
  if (typeof value === 'string') {
    if (value.length > 2 * 1024 * 1024) return inventoryRefuse('service_policy_refused');
    try { value = JSON.parse(value); } catch {
      try { value = JSON.parse(decodeURIComponent(value as string)); } catch { return inventoryRefuse('service_policy_refused'); }
    }
  }
  const doc = record(value); if (!Array.isArray(doc.Statement)) return inventoryRefuse('service_policy_refused');
  const normalize = (v: unknown, depth = 0, statement = false): unknown => {
    if (depth > 64) return inventoryRefuse('service_policy_refused');
    if (Array.isArray(v)) return v.map(x => normalize(x, depth + 1, statement)).sort((a, b) => inventoryCanonical(a).localeCompare(inventoryCanonical(b)));
    if (!inventoryRecord(v)) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !(statement && k === 'Sid') && !(depth === 0 && k === 'Id')).map(([k, x]) => [k,
      normalize(['Action', 'NotAction', 'Resource', 'NotResource'].includes(k) && !Array.isArray(x) ? [x] : x, depth + 1, depth === 0 && k === 'Statement')]));
  };
  return normalize(doc);
}
const arn = (service: string, suffix: string) => `arn:aws:${service}:${region}:${account}:${suffix}`;
const fnName = (value: unknown) => string(value).replace(`arn:aws:lambda:${region}:${account}:function:`, '');

// Only documented operational counters/status timestamps are excluded from
// repeated configuration observations. Unknown/new configuration fields remain
// in the digest, and changed declarations still refuse. This is not a data or
// alarm-delivery acceptance check.
function configurationObservation(service: string, operation: string, input: unknown): unknown {
  const value = structuredClone(input);
  const omit = (row: unknown, names: string[]) => { if (inventoryRecord(row)) for (const name of names) delete row[name]; };
  if (service === 'dynamodb' && operation === 'describe-table' && inventoryRecord(value)) {
    const table = value.Table; omit(table, ['ItemCount', 'TableSizeBytes']);
    if (inventoryRecord(table) && Array.isArray(table.GlobalSecondaryIndexes))
      for (const index of table.GlobalSecondaryIndexes) omit(index, ['ItemCount', 'IndexSizeBytes']);
  }
  if (service === 'dynamodb' && operation === 'describe-continuous-backups' && inventoryRecord(value)
    && inventoryRecord(value.ContinuousBackupsDescription))
    omit(value.ContinuousBackupsDescription.PointInTimeRecoveryDescription, ['EarliestRestorableDateTime', 'LatestRestorableDateTime']);
  if (service === 'logs' && operation === 'describe-log-groups' && inventoryRecord(value) && Array.isArray(value.logGroups))
    for (const row of value.logGroups) omit(row, ['storedBytes']);
  if (service === 'cloudwatch' && operation === 'describe-alarms' && inventoryRecord(value) && Array.isArray(value.MetricAlarms))
    for (const row of value.MetricAlarms) omit(row, ['StateValue', 'StateReason', 'StateReasonData', 'StateUpdatedTimestamp', 'StateTransitionedTimestamp']);
  if (service === 'sqs' && operation === 'get-queue-attributes' && inventoryRecord(value))
    omit(value.Attributes, ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesDelayed', 'ApproximateNumberOfMessagesNotVisible']);
  return value;
}

/** This component requires already observed exact stack mappings and fresh
 * artifacts. Its default adapter makes service reads itself; transport doubles
 * remain unit-test evidence only. It does not verify source/principal/foundation,
 * uploaded versions, the database ledger, human reviews or runtime acceptance. */
export async function observeInventoryCandidateServices(supplied: InventoryStackSnapshot, suppliedCandidate: InventoryCandidateTarget,
  suppliedArtifact: InventoryCandidateArtifact, transport: InventoryServiceRead = inventoryServiceReader()) {
  const snapshot = structuredClone(supplied), candidate = structuredClone(suppliedCandidate), artifact = structuredClone(suppliedArtifact);
  if (candidate.candidate !== artifact.candidate || candidate.templateSha256 !== artifact.templateSha256 || candidate.manifestSha256 !== artifact.manifestSha256
    || new Set(snapshot.resources.map(r => r.logicalId)).size !== snapshot.resources.length) return inventoryRefuse('service_binding_refused');
  const stackPrefix = `arn:aws:cloudformation:${region}:${account}:stack/${candidate.stackName}/`;
  if (!snapshot.stackId.startsWith(stackPrefix) || snapshot.stackId.length <= stackPrefix.length) return inventoryRefuse('service_binding_refused');
  const parameters = { ...candidate.parameters, 'AWS::AccountId': account, 'AWS::Region': region, 'AWS::Partition': 'aws',
    'AWS::StackName': candidate.stackName, 'AWS::StackId': snapshot.stackId, 'AWS::URLSuffix': 'amazonaws.com' };
  const declarations = Object.entries(artifact.template.Resources).filter(([, r]) => !r.Condition
    || inventoryCondition(artifact.template.Conditions[r.Condition], artifact.template, parameters))
    .map(([logicalId, r]) => ({ logicalId, type: r.Type }));
  same(ordered(snapshot.resources.map(r => ({ logicalId: r.logicalId, type: r.type }))), ordered(declarations), 'service_resource_coverage_refused');
  // Re-derive property consistency from the exact artifact and physical mapping.
  // These in-memory declaration rows are NOT new AWS observations. The enclosing
  // observer must independently obtain and repeat actual CloudFormation reads.
  const derived = inspectInventoryStackDeclarations(candidate, artifact, {
    stack: { Stacks: [{ StackName: candidate.stackName, StackId: snapshot.stackId, StackStatus: 'CREATE_COMPLETE',
      Parameters: Object.entries(candidate.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Outputs: Object.entries(snapshot.outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] },
    template: { TemplateBody: artifact.template }, resources: { StackResourceSummaries: snapshot.resources.map(r => ({
      LogicalResourceId: r.logicalId, PhysicalResourceId: r.physicalId, ResourceType: r.type, ResourceStatus: 'CREATE_COMPLETE' })) },
  });
  same(snapshot, derived, 'service_binding_refused');
  const reads: Array<{ service: string; operation: string; parameters: Params; digest: string }> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    const value = await transport(service, operation, parameters);
    reads.push({ service, operation, parameters: structuredClone(parameters), digest: inventorySha(inventoryCanonical(configurationObservation(service, operation, value))) }); return value;
  };
  const roles = snapshot.resources.filter(r => r.type === 'AWS::IAM::Role'), functions = snapshot.resources.filter(r => r.type === 'AWS::Lambda::Function');
  const covered = new Set<string>();
  const resourceTags = (value: unknown, resource: InventoryResolvedResource) => {
    const tags = list(value).map(record), keys = tags.map(t => string(t.Key));
    if (new Set(keys).size !== keys.length) return inventoryRefuse('service_tags_refused');
    const platform: Record<string, string> = { 'aws:cloudformation:stack-id': snapshot.stackId,
      'aws:cloudformation:stack-name': candidate.stackName, 'aws:cloudformation:logical-id': resource.logicalId };
    return tags.filter(t => {
      if (!String(t.Key).startsWith('aws:')) return true;
      if (!Object.hasOwn(platform, String(t.Key)) || platform[String(t.Key)] !== t.Value) return inventoryRefuse('service_tags_refused');
      return false;
    });
  };
  // Combine inline and separately declared IAM policies by role. A named but
  // undeclared attached/inline policy is never ignored as platform metadata.
  for (const r of roles) {
    const p = properties(r, ['AssumeRolePolicyDocument', 'Policies']), output = record(await read('iam', 'get-role', { RoleName: r.physicalId })), role = record(output.Role);
    same(role.RoleName, r.physicalId); same(role.Arn, `arn:aws:iam::${account}:role/${r.physicalId}`);
    if (role.PermissionsBoundary !== undefined) return inventoryRefuse('service_iam_refused');
    same(inventoryObservedPolicy(role.AssumeRolePolicyDocument), inventoryObservedPolicy(p.AssumeRolePolicyDocument), 'service_iam_refused');
    const attached = record(await read('iam', 'list-attached-role-policies', { RoleName: r.physicalId }));
    same(attached.AttachedPolicies, []); if (attached.IsTruncated === true || attached.Marker !== undefined) return inventoryRefuse('service_iam_refused');
    const expected = list(p.Policies ?? []).map(record);
    for (const policy of snapshot.resources.filter(x => x.type === 'AWS::IAM::Policy')) {
      const q = properties(policy, ['PolicyName', 'Roles', 'PolicyDocument']);
      const targets = list(q.Roles).map(string);
      if (!targets.length || new Set(targets).size !== targets.length || targets.some(name => !roles.some(role => role.physicalId === name))) return inventoryRefuse('service_iam_refused');
      if (targets.includes(r.physicalId)) expected.push({ PolicyName: q.PolicyName, PolicyDocument: q.PolicyDocument });
      covered.add(policy.logicalId);
    }
    const names = expected.map(p => string(p.PolicyName)); if (new Set(names).size !== names.length) return inventoryRefuse('service_iam_refused');
    const inline = record(await read('iam', 'list-role-policies', { RoleName: r.physicalId }));
    if (inline.IsTruncated === true || inline.Marker !== undefined) return inventoryRefuse('service_iam_refused'); same(ordered(inline.PolicyNames), ordered(names));
    for (const policy of expected) {
      const name = string(policy.PolicyName), observed = record(await read('iam', 'get-role-policy', { RoleName: r.physicalId, PolicyName: name }));
      same(observed.RoleName, r.physicalId); same(observed.PolicyName, name);
      same(inventoryObservedPolicy(observed.PolicyDocument), inventoryObservedPolicy(policy.PolicyDocument), 'service_iam_refused');
    }
    covered.add(r.logicalId);
  }
  for (const r of functions) {
    const p = properties(r, ['FunctionName', 'Runtime', 'Handler', 'Role', 'Timeout', 'MemorySize', 'Code', 'Environment', 'LoggingConfig', 'ReservedConcurrentExecutions', 'Architectures']);
    const binding = artifact.bindings.find(b => b.logicalId === r.logicalId);
    const code = binding && candidate.packages.find(c => c.key === candidate.parameters[binding.keyParameter]);
    const packageArtifact = binding && artifact.packages.find(p => p.keyParameter === binding.keyParameter && p.bucketParameter === binding.bucketParameter && p.versionParameter === binding.versionParameter);
    if (!binding || !code || !packageArtifact || binding.handler !== p.Handler || code.file !== packageArtifact.file
      || code.sha256 !== packageArtifact.sha256 || code.bytes !== packageArtifact.bytes
      || !packageArtifact.files.some(f => f.name === binding.file)) return inventoryRefuse('service_code_binding_refused');
    same(p.Code, { S3Bucket: code.bucket, S3Key: code.key, S3ObjectVersion: code.versionId });
    const functionArn = arn('lambda', `function:${r.physicalId}`), f = record(await read('lambda', 'get-function-configuration', { FunctionName: functionArn }));
    const expected: Record<string, unknown> = { FunctionName: r.physicalId, FunctionArn: functionArn, State: 'Active', LastUpdateStatus: 'Successful',
      Runtime: p.Runtime, Handler: p.Handler, Role: p.Role, Timeout: Number(p.Timeout), MemorySize: Number(p.MemorySize), PackageType: 'Zip',
      CodeSize: code.bytes, CodeSha256: Buffer.from(code.sha256, 'hex').toString('base64'), Architectures: p.Architectures ?? ['x86_64'] };
    for (const [name, value] of Object.entries(expected)) same(f[name], value, 'service_lambda_refused');
    if (!f.RevisionId || f.Layers !== undefined && list(f.Layers).length || f.FileSystemConfigs !== undefined && list(f.FileSystemConfigs).length
      || inventoryRecord(f.VpcConfig) && (f.VpcConfig.VpcId || list(f.VpcConfig.SubnetIds ?? []).length || list(f.VpcConfig.SecurityGroupIds ?? []).length)
      || f.DeadLetterConfig !== undefined && Object.keys(record(f.DeadLetterConfig)).length || f.CodeSigningConfigArn || f.KMSKeyArn
      || inventoryRecord(f.SnapStart) && f.SnapStart.ApplyOn !== 'None') return inventoryRefuse('service_lambda_refused');
    const environment = record(f.Environment); if (environment.Error !== undefined) return inventoryRefuse('service_lambda_refused');
    same(environment.Variables, record(p.Environment).Variables, 'service_lambda_refused');
    const logging = record(f.LoggingConfig), loggingExpected = record(p.LoggingConfig);
    if (Object.keys(loggingExpected).some(k => !['LogGroup', 'LogFormat', 'ApplicationLogLevel', 'SystemLogLevel'].includes(k))) return inventoryRefuse('service_property_coverage_refused');
    same(logging.LogGroup, loggingExpected.LogGroup, 'service_lambda_refused');
    same(logging.LogFormat, loggingExpected.LogFormat ?? 'Text', 'service_lambda_refused');
    same(logging.ApplicationLogLevel, loggingExpected.ApplicationLogLevel, 'service_lambda_refused');
    same(logging.SystemLogLevel, loggingExpected.SystemLogLevel, 'service_lambda_refused');
    if (record(f.EphemeralStorage ?? { Size: 512 }).Size !== 512 || record(f.TracingConfig ?? {}).Mode !== undefined && record(f.TracingConfig).Mode !== 'PassThrough') return inventoryRefuse('service_lambda_refused');
    const aliases = record(await read('lambda', 'list-aliases', { FunctionName: functionArn }));
    same(aliases.Aliases, []); if (aliases.NextMarker !== undefined) return inventoryRefuse('service_lambda_refused');
    const versions = record(await read('lambda', 'list-versions-by-function', { FunctionName: functionArn }));
    if (versions.NextMarker !== undefined || list(versions.Versions).length !== 1) return inventoryRefuse('service_lambda_refused');
    const latest = record(list(versions.Versions)[0]); same(latest.Version, '$LATEST'); same(latest.FunctionArn, functionArn + ':$LATEST'); same(latest.CodeSha256, f.CodeSha256);
    const concurrency = record(await read('lambda', 'get-function-concurrency', { FunctionName: functionArn }));
    same(concurrency.ReservedConcurrentExecutions, Number(p.ReservedConcurrentExecutions), 'service_lambda_refused');
    if (await read('lambda', 'get-function-url-config', { FunctionName: functionArn }) !== null) return inventoryRefuse('service_public_function_url_refused');
    const permissions = snapshot.resources.filter(x => x.type === 'AWS::Lambda::Permission' && fnName(x.properties.FunctionName) === r.physicalId);
    const statements = permissions.map(permission => {
      const q = properties(permission, ['FunctionName', 'Action', 'Principal', 'SourceArn', 'SourceAccount']); covered.add(permission.logicalId);
      return { Effect: 'Allow', Action: q.Action, Resource: functionArn, Principal: { Service: q.Principal },
        Condition: { ...(q.SourceAccount === undefined ? {} : { StringEquals: { 'AWS:SourceAccount': q.SourceAccount } }),
          ArnLike: { 'AWS:SourceArn': q.SourceArn } } };
    });
    const policy = await read('lambda', 'get-policy', { FunctionName: functionArn });
    if (!statements.length) { if (policy !== null) return inventoryRefuse('service_invoke_refused'); }
    else same(inventoryObservedPolicy(record(policy).Policy), inventoryObservedPolicy({ Version: '2012-10-17', Statement: statements }), 'service_invoke_refused');
    covered.add(r.logicalId);
  }
  for (const r of snapshot.resources) {
    if (covered.has(r.logicalId)) continue;
    const id = r.physicalId;
    if (r.type === 'AWS::Logs::LogGroup') {
      const p = properties(r, ['LogGroupName', 'RetentionInDays', 'KmsKeyId']), groups = record(await read('logs', 'describe-log-groups', { LogGroupNamePrefix: id }));
      if (groups.nextToken !== undefined) return inventoryRefuse('service_logs_refused');
      const found = list(groups.logGroups).map(record).filter(g => g.logGroupName === id); if (found.length !== 1) return inventoryRefuse('service_logs_refused');
      same(found[0].arn, arn('logs', `log-group:${id}:*`)); same(found[0].retentionInDays, Number(p.RetentionInDays)); same(found[0].kmsKeyId, p.KmsKeyId);
      if (found[0].logGroupClass !== undefined && found[0].logGroupClass !== 'STANDARD') return inventoryRefuse('service_logs_refused');
    } else if (r.type.startsWith('AWS::ApiGatewayV2::')) {
      const suffix = r.type.split('::').at(-1)!, key = suffix + 'Id';
      const p = properties(r, suffix === 'Route' ? ['ApiId', 'RouteKey', 'AuthorizationType', 'AuthorizerId', 'Target']
        : suffix === 'Integration' ? ['ApiId', 'IntegrationType', 'IntegrationUri', 'PayloadFormatVersion', 'TimeoutInMillis']
          : suffix === 'Authorizer' ? ['ApiId', 'Name', 'AuthorizerType', 'IdentitySource', 'JwtConfiguration'] : []);
      const actual = record(await read('apigatewayv2', `get-${suffix.toLowerCase()}`, { ApiId: string(p.ApiId), [key]: id }));
      same(actual[key], id);
      for (const [name, value] of Object.entries(p)) if (name !== 'ApiId') same(actual[name], value, 'service_api_refused');
      if (suffix === 'Route' && (actual.ApiKeyRequired === true || list(actual.AuthorizationScopes ?? []).length)) return inventoryRefuse('service_api_refused');
      if (suffix === 'Integration' && (actual.CredentialsArn || actual.ConnectionType !== undefined && actual.ConnectionType !== 'INTERNET'
        || Object.keys(record(actual.RequestParameters ?? {})).length || Object.keys(record(actual.ResponseParameters ?? {})).length)) return inventoryRefuse('service_api_refused');
      if (suffix === 'Authorizer' && (actual.AuthorizerUri || actual.AuthorizerCredentialsArn)) return inventoryRefuse('service_api_refused');
    } else if (r.type === 'AWS::CloudWatch::Alarm') {
      const p = properties(r, ['Namespace', 'MetricName', 'Dimensions', 'Statistic', 'Period', 'EvaluationPeriods', 'Threshold', 'ComparisonOperator', 'TreatMissingData', 'AlarmActions', 'AlarmDescription', 'DatapointsToAlarm', 'ActionsEnabled']);
      const output = record(await read('cloudwatch', 'describe-alarms', { AlarmNames: [id] }));
      if (output.NextToken !== undefined || list(output.CompositeAlarms ?? []).length || list(output.MetricAlarms).length !== 1) return inventoryRefuse('service_alarm_refused');
      const actual = record(list(output.MetricAlarms)[0]); same(actual.AlarmName, id);
      for (const [name, value] of Object.entries(p)) same(name === 'Dimensions' ? ordered(actual[name]) : actual[name], name === 'Dimensions' ? ordered(value) : value, 'service_alarm_refused');
      same(actual.ActionsEnabled, p.ActionsEnabled ?? true); same(actual.DatapointsToAlarm, p.DatapointsToAlarm ?? p.EvaluationPeriods);
      if (list(actual.OKActions ?? []).length || list(actual.InsufficientDataActions ?? []).length || actual.ExtendedStatistic || list(actual.Metrics ?? []).length
        || actual.Unit !== undefined || actual.EvaluationCriteria !== undefined || actual.EvaluationWindow !== undefined || actual.EvaluationInterval !== undefined) return inventoryRefuse('service_alarm_refused');
    } else if (r.type === 'AWS::Events::Rule') {
      const p = properties(r, ['Name', 'ScheduleExpression', 'State', 'Targets', 'EventPattern']), actual = record(await read('events', 'describe-rule', { Name: id }));
      same(actual.Name, id); same(actual.Arn, arn('events', `rule/${id}`)); same(actual.State, p.State ?? 'ENABLED');
      same(actual.ScheduleExpression ?? null, p.ScheduleExpression ?? null);
      same(actual.EventPattern === undefined ? null : json(actual.EventPattern), p.EventPattern ?? null);
      if (actual.RoleArn || actual.EventBusName !== undefined && actual.EventBusName !== 'default') return inventoryRefuse('service_rule_refused');
      const targets = record(await read('events', 'list-targets-by-rule', { Rule: id })); if (targets.NextToken !== undefined) return inventoryRefuse('service_rule_refused');
      same(ordered(targets.Targets), ordered(p.Targets), 'service_rule_refused');
    } else if (r.type === 'AWS::Lambda::EventInvokeConfig') {
      const p = properties(r, ['FunctionName', 'Qualifier', 'MaximumRetryAttempts', 'MaximumEventAgeInSeconds', 'DestinationConfig']);
      const actual = record(await read('lambda', 'get-function-event-invoke-config', { FunctionName: string(p.FunctionName), Qualifier: string(p.Qualifier) }));
      same(actual.FunctionArn, arn('lambda', `function:${fnName(p.FunctionName)}:${p.Qualifier}`));
      same(actual.MaximumRetryAttempts, p.MaximumRetryAttempts); same(actual.MaximumEventAgeInSeconds, p.MaximumEventAgeInSeconds);
      const destination = record(actual.DestinationConfig); same(destination.OnFailure, record(p.DestinationConfig).OnFailure);
      if (inventoryRecord(destination.OnSuccess) && Object.keys(destination.OnSuccess).length) return inventoryRefuse('service_async_destination_refused');
    } else if (r.type === 'AWS::DynamoDB::Table') {
      const p = properties(r, ['BillingMode', 'AttributeDefinitions', 'KeySchema', 'GlobalSecondaryIndexes', 'PointInTimeRecoverySpecification', 'SSESpecification', 'Tags']);
      const tableArn = arn('dynamodb', `table/${id}`), table = record(record(await read('dynamodb', 'describe-table', { TableName: id })).Table);
      same(table.TableName, id); same(table.TableArn, tableArn); same(table.TableStatus, 'ACTIVE'); same(record(table.BillingModeSummary).BillingMode, p.BillingMode);
      same(ordered(table.AttributeDefinitions), ordered(p.AttributeDefinitions)); same(ordered(table.KeySchema), ordered(p.KeySchema));
      const indexes = list(table.GlobalSecondaryIndexes ?? []).map(record);
      if (indexes.some(i => i.IndexStatus !== 'ACTIVE' || i.Backfilling === true)) return inventoryRefuse('service_table_refused');
      const indexProjection = (i: Record<string, unknown>) => ({ IndexName: i.IndexName, KeySchema: ordered(i.KeySchema), Projection: i.Projection });
      same(ordered(indexes.map(indexProjection)), ordered(list(p.GlobalSecondaryIndexes ?? []).map(record).map(indexProjection)));
      if (list(table.LocalSecondaryIndexes ?? []).length || list(table.Replicas ?? []).length || record(table.StreamSpecification ?? {}).StreamEnabled === true
        || table.DeletionProtectionEnabled === true) return inventoryRefuse('service_table_refused');
      const sse = record(table.SSEDescription), expected = record(p.SSESpecification);
      same(sse.Status, 'ENABLED'); same(sse.SSEType, expected.SSEType); same(sse.KMSMasterKeyArn, expected.KMSMasterKeyId);
      if (sse.InaccessibleEncryptionDateTime !== undefined || expected.SSEEnabled !== true) return inventoryRefuse('service_table_refused');
      const backups = record(record(await read('dynamodb', 'describe-continuous-backups', { TableName: id })).ContinuousBackupsDescription);
      same(record(backups.PointInTimeRecoveryDescription).PointInTimeRecoveryStatus, record(p.PointInTimeRecoverySpecification).PointInTimeRecoveryEnabled === true ? 'ENABLED' : 'DISABLED');
      same(record(record(await read('dynamodb', 'describe-time-to-live', { TableName: id })).TimeToLiveDescription).TimeToLiveStatus, 'DISABLED');
      const tags = record(await read('dynamodb', 'list-tags-of-resource', { ResourceArn: tableArn })); if (tags.NextToken !== undefined) return inventoryRefuse('service_table_refused');
      same(ordered(resourceTags(tags.Tags, r)), ordered(p.Tags ?? []));
      if (await read('dynamodb', 'get-resource-policy', { ResourceArn: tableArn }) !== null) return inventoryRefuse('service_table_policy_refused');
    } else if (r.type === 'AWS::S3::Bucket') {
      const p = properties(r, ['NotificationConfiguration', 'BucketEncryption', 'OwnershipControls', 'PublicAccessBlockConfiguration', 'VersioningConfiguration', 'Tags']);
      const params = { Bucket: id, ExpectedBucketOwner: account };
      const encryption = record(await read('s3api', 'get-bucket-encryption', params));
      const rules = list(record(encryption.ServerSideEncryptionConfiguration).Rules).map(record);
      same(rules.map(q => ({ BucketKeyEnabled: q.BucketKeyEnabled, ServerSideEncryptionByDefault: q.ApplyServerSideEncryptionByDefault })), record(p.BucketEncryption).ServerSideEncryptionConfiguration);
      same(record(await read('s3api', 'get-bucket-ownership-controls', params)).OwnershipControls, p.OwnershipControls);
      same(record(await read('s3api', 'get-public-access-block', params)).PublicAccessBlockConfiguration, p.PublicAccessBlockConfiguration);
      const versioning = record(await read('s3api', 'get-bucket-versioning', params)); same(versioning.Status, record(p.VersioningConfiguration).Status);
      if (versioning.MFADelete !== undefined && versioning.MFADelete !== 'Disabled') return inventoryRefuse('service_bucket_refused');
      const notification = record(await read('s3api', 'get-bucket-notification-configuration', params)), desired = record(p.NotificationConfiguration ?? {});
      if (Object.keys(desired).some(k => k !== 'EventBridgeConfiguration') || Object.keys(record(desired.EventBridgeConfiguration ?? {})).some(k => k !== 'EventBridgeEnabled')) return inventoryRefuse('service_property_coverage_refused');
      same(notification, record(desired.EventBridgeConfiguration ?? {}).EventBridgeEnabled === true ? { EventBridgeConfiguration: {} } : {});
      const tagResponse = await read('s3api', 'get-bucket-tagging', params);
      same(ordered(resourceTags(tagResponse === null ? [] : record(tagResponse).TagSet, r)), ordered(p.Tags ?? []));
      for (const operation of ['get-bucket-lifecycle-configuration', 'get-bucket-replication', 'get-object-lock-configuration']) {
        if (await read('s3api', operation, params) !== null) return inventoryRefuse('service_undeclared_bucket_control_refused');
      }
    } else if (r.type === 'AWS::S3::BucketPolicy') {
      const p = properties(r, ['Bucket', 'PolicyDocument']);
      const output = record(await read('s3api', 'get-bucket-policy', { Bucket: string(p.Bucket), ExpectedBucketOwner: account }));
      same(inventoryObservedPolicy(output.Policy), inventoryObservedPolicy(p.PolicyDocument), 'service_bucket_policy_refused');
    } else if (r.type === 'AWS::StepFunctions::StateMachine') {
      const p = properties(r, ['StateMachineName', 'StateMachineType', 'RoleArn', 'DefinitionString']), actual = record(await read('stepfunctions', 'describe-state-machine', { StateMachineArn: id }));
      same(actual.stateMachineArn, id); same(actual.name, p.StateMachineName); same(actual.type, p.StateMachineType); same(actual.status, 'ACTIVE'); same(actual.roleArn, p.RoleArn);
      same(json(actual.definition), json(p.DefinitionString));
      if (record(actual.loggingConfiguration ?? {}).level !== undefined && record(actual.loggingConfiguration).level !== 'OFF'
        || record(actual.tracingConfiguration ?? {}).enabled === true || record(actual.encryptionConfiguration ?? {}).type !== undefined && record(actual.encryptionConfiguration).type !== 'AWS_OWNED_KEY') return inventoryRefuse('service_state_machine_refused');
    } else if (r.type === 'AWS::SQS::Queue' || r.type === 'AWS::SQS::QueuePolicy') {
      if (r.type === 'AWS::SQS::QueuePolicy') continue; // Verified with its queue, never separately accepted.
      const p = properties(r, ['SqsManagedSseEnabled', 'MessageRetentionPeriod', 'Tags']);
      const q = record(record(await read('sqs', 'get-queue-attributes', { QueueUrl: id, AttributeNames: ['All'] })).Attributes);
      const prefix = `https://sqs.${region}.amazonaws.com/${account}/`; if (!id.startsWith(prefix)) return inventoryRefuse('service_queue_refused');
      same(q.QueueArn, arn('sqs', id.slice(prefix.length))); same(q.SqsManagedSseEnabled, String(p.SqsManagedSseEnabled)); same(q.MessageRetentionPeriod, String(p.MessageRetentionPeriod));
      if (q.KmsMasterKeyId || q.RedrivePolicy || q.RedriveAllowPolicy || q.FifoQueue === 'true' || q.ContentBasedDeduplication === 'true') return inventoryRefuse('service_queue_refused');
      const policies = snapshot.resources.filter(x => x.type === 'AWS::SQS::QueuePolicy' && list(x.properties.Queues).includes(id));
      if (policies.length !== 1) return inventoryRefuse('service_queue_policy_refused');
      const expected = properties(policies[0], ['Queues', 'PolicyDocument']); same(expected.Queues, [id]);
      same(inventoryObservedPolicy(q.Policy), inventoryObservedPolicy(expected.PolicyDocument), 'service_queue_policy_refused'); covered.add(policies[0].logicalId);
      const tags = record(record(await read('sqs', 'list-queue-tags', { QueueUrl: id })).Tags);
      same(ordered(resourceTags(Object.entries(tags).map(([Key, Value]) => ({ Key, Value })), r)), ordered(p.Tags ?? []));
    } else return inventoryRefuse('service_resource_coverage_refused');
    covered.add(r.logicalId);
  }
  same([...covered].sort(), snapshot.resources.map(r => r.logicalId).sort(), 'service_resource_coverage_refused');
  // Repeat exact reads rather than taking environment assertions as live state.
  // This detects changes during the window; it is not an atomic AWS snapshot.
  for (const observed of reads) same(inventorySha(inventoryCanonical(configurationObservation(observed.service, observed.operation,
    await transport(observed.service, observed.operation, observed.parameters)))), observed.digest, 'service_observation_changed');
  return { contract: 'inventory-qualification-service-observation/1', serviceDeclarationsVerified: true, candidate: candidate.candidate,
    resources: covered.size, observations: reads.length, observationSha256: inventorySha(inventoryCanonical(reads)),
    sourcePrincipalFoundationVerified: false, uploadedVersionsVerified: false, wholeLedgerVerified: false,
    acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
}
