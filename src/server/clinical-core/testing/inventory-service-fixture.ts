// FICTIONAL service responses for credential-free tests. Never imported by an
// operator, deployment, runtime or evidence command; not AWS acceptance evidence.
import type { InventoryCandidateArtifact } from '../inventory-qualification-artifacts';
import type { InventoryCandidateTarget } from '../inventory-qualification-target';
import type { InventoryStackSnapshot } from '../inventory-qualification-stack-observer';
import type { InventoryServiceRead } from '../inventory-qualification-service-observer';

const account = '588966314750', region = 'us-east-2';
const arn = (s: string, tail: string) => `arn:aws:${s}:${region}:${account}:${tail}`;
const fnName = (v: unknown) => String(v).replace(arn('lambda', 'function:'), '');
type Row = Record<string, unknown>;
const obj = (v: unknown) => v as Row;
const arr = (v: unknown) => v as Row[];
export function fictionalInventoryServices(snapshot: InventoryStackSnapshot, candidate: InventoryCandidateTarget, artifact: InventoryCandidateArtifact) {
  const responses = new Map<string, unknown>();
  const key = (service: string, operation: string, parameters: Record<string, string | string[]>) => `${service}/${operation}/${JSON.stringify(parameters)}`;
  const set = (s: string, o: string, p: Record<string, string | string[]>, v: unknown) => responses.set(key(s, o, p), structuredClone(v));
  for (const r of snapshot.resources) {
    const p = r.properties, id = r.physicalId;
    if (r.type === 'AWS::IAM::Role') {
      const params = { RoleName: id };
      const policies = [...arr(p.Policies ?? []), ...snapshot.resources.filter(q => q.type === 'AWS::IAM::Policy' && (q.properties.Roles as string[]).includes(id))
        .map(q => ({ PolicyName: q.properties.PolicyName, PolicyDocument: q.properties.PolicyDocument }))];
      set('iam', 'get-role', params, { Role: { RoleName: id, Arn: `arn:aws:iam::${account}:role/${id}`, AssumeRolePolicyDocument: p.AssumeRolePolicyDocument } });
      set('iam', 'list-attached-role-policies', params, { AttachedPolicies: [], IsTruncated: false });
      set('iam', 'list-role-policies', params, { PolicyNames: policies.map(q => q.PolicyName), IsTruncated: false });
      for (const policy of policies) set('iam', 'get-role-policy', { RoleName: id, PolicyName: String(policy.PolicyName) }, { RoleName: id, ...policy });
    } else if (r.type === 'AWS::Lambda::Function') {
      const binding = artifact.bindings.find(b => b.logicalId === r.logicalId)!;
      const code = candidate.packages.find(c => c.key === candidate.parameters[binding.keyParameter])!;
      const params = { FunctionName: arn('lambda', `function:${id}`) };
      set('lambda', 'get-function-configuration', params, { FunctionName: id, FunctionArn: params.FunctionName, State: 'Active', LastUpdateStatus: 'Successful',
        Runtime: p.Runtime, Handler: p.Handler, Role: p.Role, Timeout: Number(p.Timeout), MemorySize: Number(p.MemorySize), PackageType: 'Zip',
        CodeSize: code.bytes, CodeSha256: Buffer.from(code.sha256, 'hex').toString('base64'), Architectures: p.Architectures ?? ['x86_64'],
        RevisionId: 'fictional-revision', Environment: p.Environment, LoggingConfig: { LogFormat: 'Text', ...obj(p.LoggingConfig) } });
      set('lambda', 'list-aliases', params, { Aliases: [] });
      set('lambda', 'list-versions-by-function', params, { Versions: [{ Version: '$LATEST', FunctionArn: params.FunctionName + ':$LATEST', CodeSha256: Buffer.from(code.sha256, 'hex').toString('base64') }] });
      set('lambda', 'get-function-concurrency', params, { ReservedConcurrentExecutions: Number(p.ReservedConcurrentExecutions) });
      set('lambda', 'get-function-url-config', params, null);
      const statements = snapshot.resources.filter(q => q.type === 'AWS::Lambda::Permission' && fnName(q.properties.FunctionName) === id).map(q => ({
        Sid: q.logicalId, Effect: 'Allow', Action: q.properties.Action, Resource: params.FunctionName, Principal: { Service: q.properties.Principal },
        Condition: { ...(q.properties.SourceAccount === undefined ? {} : { StringEquals: { 'AWS:SourceAccount': q.properties.SourceAccount } }),
          ArnLike: { 'AWS:SourceArn': q.properties.SourceArn } } }));
      set('lambda', 'get-policy', params, statements.length ? { Policy: JSON.stringify({ Version: '2012-10-17', Id: 'default', Statement: statements }), RevisionId: 'fictional-policy' } : null);
    } else if (r.type === 'AWS::Logs::LogGroup') {
      set('logs', 'describe-log-groups', { LogGroupNamePrefix: id }, { logGroups: [{ logGroupName: id, arn: arn('logs', `log-group:${id}:*`),
        retentionInDays: Number(p.RetentionInDays), kmsKeyId: p.KmsKeyId, logGroupClass: 'STANDARD', storedBytes: 0 }] });
    } else if (r.type.startsWith('AWS::ApiGatewayV2::')) {
      const suffix = r.type.split('::').at(-1)!, { ApiId, ...properties } = p;
      set('apigatewayv2', `get-${suffix.toLowerCase()}`, { ApiId: String(ApiId), [suffix + 'Id']: id }, { [suffix + 'Id']: id, ...properties });
    } else if (r.type === 'AWS::CloudWatch::Alarm') {
      set('cloudwatch', 'describe-alarms', { AlarmNames: [id] }, { MetricAlarms: [{ AlarmName: id, ...p,
        ActionsEnabled: p.ActionsEnabled ?? true, DatapointsToAlarm: p.DatapointsToAlarm ?? p.EvaluationPeriods, StateValue: 'OK', StateUpdatedTimestamp: 'fictional-time' }], CompositeAlarms: [] });
    } else if (r.type === 'AWS::Events::Rule') {
      const { Targets, EventPattern, ...properties } = p;
      set('events', 'describe-rule', { Name: id }, { Name: id, Arn: arn('events', `rule/${id}`), State: 'ENABLED', ...properties,
        ...(EventPattern ? { EventPattern: JSON.stringify(EventPattern) } : {}) });
      set('events', 'list-targets-by-rule', { Rule: id }, { Targets });
    } else if (r.type === 'AWS::Lambda::EventInvokeConfig') {
      set('lambda', 'get-function-event-invoke-config', { FunctionName: String(p.FunctionName), Qualifier: String(p.Qualifier) }, {
        FunctionArn: arn('lambda', `function:${fnName(p.FunctionName)}:${p.Qualifier}`), MaximumRetryAttempts: p.MaximumRetryAttempts,
        MaximumEventAgeInSeconds: p.MaximumEventAgeInSeconds, DestinationConfig: p.DestinationConfig });
    } else if (r.type === 'AWS::DynamoDB::Table') {
      const tableArn = arn('dynamodb', `table/${id}`), params = { TableName: id };
      set('dynamodb', 'describe-table', params, { Table: { TableName: id, TableArn: tableArn, TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: p.BillingMode }, AttributeDefinitions: p.AttributeDefinitions, KeySchema: p.KeySchema,
        GlobalSecondaryIndexes: arr(p.GlobalSecondaryIndexes ?? []).map(q => ({ ...q, IndexStatus: 'ACTIVE', ItemCount: 0, IndexSizeBytes: 0 })),
        SSEDescription: { Status: 'ENABLED', SSEType: obj(p.SSESpecification).SSEType, KMSMasterKeyArn: obj(p.SSESpecification).KMSMasterKeyId }, ItemCount: 0, TableSizeBytes: 0 } });
      set('dynamodb', 'describe-continuous-backups', params, { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: {
        PointInTimeRecoveryStatus: obj(p.PointInTimeRecoverySpecification).PointInTimeRecoveryEnabled ? 'ENABLED' : 'DISABLED', LatestRestorableDateTime: 'fictional-time' } } });
      set('dynamodb', 'describe-time-to-live', params, { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } });
      set('dynamodb', 'list-tags-of-resource', { ResourceArn: tableArn }, { Tags: p.Tags ?? [] });
      set('dynamodb', 'get-resource-policy', { ResourceArn: tableArn }, null);
    } else if (r.type === 'AWS::S3::Bucket') {
      const params = { Bucket: id, ExpectedBucketOwner: account };
      set('s3api', 'get-bucket-encryption', params, { ServerSideEncryptionConfiguration: { Rules: arr(obj(p.BucketEncryption).ServerSideEncryptionConfiguration)
        .map(q => ({ BucketKeyEnabled: q.BucketKeyEnabled, ApplyServerSideEncryptionByDefault: q.ServerSideEncryptionByDefault })) } });
      set('s3api', 'get-bucket-ownership-controls', params, { OwnershipControls: p.OwnershipControls });
      set('s3api', 'get-public-access-block', params, { PublicAccessBlockConfiguration: p.PublicAccessBlockConfiguration });
      set('s3api', 'get-bucket-versioning', params, p.VersioningConfiguration);
      set('s3api', 'get-bucket-notification-configuration', params, obj(p.NotificationConfiguration ?? {}).EventBridgeConfiguration ? { EventBridgeConfiguration: {} } : {});
      set('s3api', 'get-bucket-tagging', params, { TagSet: [...arr(p.Tags ?? []),
        { Key: 'aws:cloudformation:stack-id', Value: snapshot.stackId }, { Key: 'aws:cloudformation:stack-name', Value: candidate.stackName },
        { Key: 'aws:cloudformation:logical-id', Value: r.logicalId }] });
      for (const op of ['get-bucket-lifecycle-configuration', 'get-bucket-replication', 'get-object-lock-configuration']) set('s3api', op, params, null);
    } else if (r.type === 'AWS::S3::BucketPolicy') {
      set('s3api', 'get-bucket-policy', { Bucket: String(p.Bucket), ExpectedBucketOwner: account }, { Policy: JSON.stringify(p.PolicyDocument) });
    } else if (r.type === 'AWS::StepFunctions::StateMachine') {
      set('stepfunctions', 'describe-state-machine', { StateMachineArn: id }, { stateMachineArn: id, name: p.StateMachineName, type: p.StateMachineType,
        status: 'ACTIVE', roleArn: p.RoleArn, definition: p.DefinitionString, loggingConfiguration: { level: 'OFF' }, tracingConfiguration: { enabled: false }, encryptionConfiguration: { type: 'AWS_OWNED_KEY' } });
    } else if (r.type === 'AWS::SQS::Queue') {
      const policy = snapshot.resources.find(q => q.type === 'AWS::SQS::QueuePolicy' && (q.properties.Queues as string[]).includes(id))!;
      set('sqs', 'get-queue-attributes', { QueueUrl: id, AttributeNames: ['All'] }, { Attributes: {
        QueueArn: arn('sqs', id.split('/').at(-1)!), SqsManagedSseEnabled: String(p.SqsManagedSseEnabled), MessageRetentionPeriod: String(p.MessageRetentionPeriod),
        Policy: JSON.stringify(policy.properties.PolicyDocument), ApproximateNumberOfMessages: '0' } });
      set('sqs', 'list-queue-tags', { QueueUrl: id }, { Tags: Object.fromEntries(arr(p.Tags).map(q => [String(q.Key), q.Value])) });
    }
  }
  const read: InventoryServiceRead = async (s, o, p) => {
    const id = key(s, o, p); if (!responses.has(id)) throw Error(`fictional response missing: ${s}/${o}`);
    // AWS CLI JSON omits optional fields rather than emitting JavaScript
    // undefined. Match that wire shape, including optional SSE/permission keys.
    return JSON.parse(JSON.stringify(responses.get(id)));
  };
  return { read, responses, key };
}
