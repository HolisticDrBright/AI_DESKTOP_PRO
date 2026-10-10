if (typeof window !== 'undefined') throw Error('inventory qualification stack observation is server-only');
import { execFileSync } from 'node:child_process';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha, type InventoryCandidateArtifact, type InventoryTemplate } from './inventory-qualification-artifacts';
import { inventoryCondition, type InventoryCandidateTarget } from './inventory-qualification-target';

const account = '588966314750', region = 'us-east-2';
const complete = ['CREATE_COMPLETE', 'UPDATE_COMPLETE'];
export type InventoryStackResource = { logicalId: string; type: string; physicalId: string };
export type InventoryResolvedResource = InventoryStackResource & { properties: Record<string, unknown> };
export type InventoryStackSnapshot = { stackId: string; resources: InventoryResolvedResource[]; outputs: Record<string, string> };
export type InventoryStackRead = (operation: 'describe-stacks' | 'get-template' | 'list-stack-resources', stackName: string) => Promise<unknown>;
const same = (a: unknown, b: unknown, category: string) => {
  if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse(category);
};
const string = (v: unknown): string => {
  if (typeof v !== 'string' || !v.length || v.length > 8192 || /[\x00-\x1f\x7f]/.test(v)) return inventoryRefuse('stack_value_refused');
  return v;
};
function pairs(value: unknown, key: string, field: string) {
  if (!Array.isArray(value) || value.length > 512) return inventoryRefuse('stack_shape_refused');
  const result: Record<string, string> = {};
  for (const row of value) {
    if (!inventoryRecord(row)) return inventoryRefuse('stack_shape_refused');
    const name = string(row[key]);
    // A public key parameter can legitimately contain line breaks. Other value
    // validation happens in the independently admitted target manifest.
    if (typeof row[field] !== 'string' || row[field].length > 8192 || Object.hasOwn(result, name)) return inventoryRefuse('stack_shape_refused');
    result[name] = row[field];
  }
  return result;
}
const types = new Set(['AWS::Logs::LogGroup', 'AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::Lambda::Function',
  'AWS::Lambda::Permission', 'AWS::Lambda::EventInvokeConfig', 'AWS::ApiGatewayV2::Integration', 'AWS::ApiGatewayV2::Route',
  'AWS::ApiGatewayV2::Authorizer', 'AWS::CloudWatch::Alarm', 'AWS::Events::Rule', 'AWS::DynamoDB::Table',
  'AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::StepFunctions::StateMachine', 'AWS::SQS::Queue', 'AWS::SQS::QueuePolicy',
  'AWS::KMS::Key', 'AWS::SNS::Topic', 'AWS::SNS::TopicPolicy', 'AWS::ApiGatewayV2::Api', 'AWS::ApiGatewayV2::Stage']);
const absent = Symbol('AWS::NoValue');
type Context = { template: InventoryTemplate; parameters: Record<string, string>; refs: Record<string, string>; attributes: Record<string, string> };

function condition(name: unknown, context: Context): boolean {
  if (typeof name !== 'string' || !Object.hasOwn(context.template.Conditions, name)) return inventoryRefuse('stack_condition_refused');
  const result = inventoryCondition(context.template.Conditions[name], context.template, context.parameters);
  if (typeof result !== 'boolean') return inventoryRefuse('stack_condition_refused');
  return result;
}

/** Deliberately bounded subset used by this exact fleet. Unknown intrinsics
 * never become literal objects. NoValue is omission, not a permissive string. */
export function resolveInventoryTemplate(value: unknown, context: Context, depth = 0): unknown {
  if (depth > 64) return inventoryRefuse('stack_expression_refused');
  const next = (v: unknown) => resolveInventoryTemplate(v, context, depth + 1);
  if (Array.isArray(value)) {
    if (value.length > 4096) return inventoryRefuse('stack_expression_refused');
    return value.map(next).filter(v => v !== absent);
  }
  if (!inventoryRecord(value)) {
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
    return inventoryRefuse('stack_expression_refused');
  }
  const fields = Object.keys(value), intrinsic = fields.some(k => k === 'Ref' || k.startsWith('Fn::'));
  if (!intrinsic) {
    if (fields.length > 4096) return inventoryRefuse('stack_expression_refused');
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) { const resolved = next(v); if (resolved !== absent) result[k] = resolved; }
    return result;
  }
  if (fields.length !== 1) return inventoryRefuse('stack_expression_refused');
  if (Object.hasOwn(value, 'Ref')) {
    if (value.Ref === 'AWS::NoValue') return absent;
    const name = string(value.Ref);
    if (Object.hasOwn(context.parameters, name)) {
      const raw = context.parameters[name];
      return context.template.Parameters[name]?.Type === 'CommaDelimitedList' ? raw.split(',').map(v => v.trim()) : raw;
    }
    if (Object.hasOwn(context.refs, name)) return context.refs[name];
    return inventoryRefuse('stack_reference_refused');
  }
  if (Object.hasOwn(value, 'Fn::GetAtt')) {
    const v = value['Fn::GetAtt'], names = typeof v === 'string' ? v.split('.') : v;
    if (!Array.isArray(names) || names.length !== 2 || names.some(n => typeof n !== 'string')) return inventoryRefuse('stack_attribute_refused');
    const name = names.join('.');
    if (!Object.hasOwn(context.attributes, name)) return inventoryRefuse('stack_attribute_refused');
    return context.attributes[name];
  }
  if (Object.hasOwn(value, 'Fn::If')) {
    const terms = value['Fn::If'];
    if (!Array.isArray(terms) || terms.length !== 3) return inventoryRefuse('stack_expression_refused');
    return next(terms[condition(terms[0], context) ? 1 : 2]);
  }
  if (Object.hasOwn(value, 'Fn::Sub')) {
    const sub = value['Fn::Sub']; let source: string, overrides: Record<string, unknown> = {};
    if (typeof sub === 'string') source = sub;
    else if (Array.isArray(sub) && sub.length === 2 && typeof sub[0] === 'string' && inventoryRecord(sub[1])) { source = sub[0]; overrides = sub[1]; }
    else return inventoryRefuse('stack_expression_refused');
    if (source.length > 1024 * 1024) return inventoryRefuse('stack_expression_refused');
    return source.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
      if (name.startsWith('!')) return '${' + name.slice(1) + '}';
      const resolved = Object.hasOwn(overrides, name) ? next(overrides[name])
        : name.includes('.') ? next({ 'Fn::GetAtt': name }) : next({ Ref: name });
      if (!['string', 'number', 'boolean'].includes(typeof resolved)) return inventoryRefuse('stack_expression_refused');
      return String(resolved);
    });
  }
  for (const op of ['Fn::Join', 'Fn::Split', 'Fn::Select']) if (Object.hasOwn(value, op)) {
    const terms = value[op];
    if (!Array.isArray(terms) || terms.length !== 2) return inventoryRefuse('stack_expression_refused');
    const left = next(terms[0]), right = next(terms[1]);
    if (op === 'Fn::Join' && typeof left === 'string' && Array.isArray(right) && right.every(v => ['string', 'number'].includes(typeof v))) return right.join(left);
    if (op === 'Fn::Split' && typeof left === 'string' && left.length && typeof right === 'string') return right.split(left);
    if (op === 'Fn::Select' && (typeof left === 'number' || typeof left === 'string' && /^\d+$/.test(left))
      && Number.isSafeInteger(Number(left)) && Array.isArray(right) && Number(left) >= 0 && Number(left) < right.length) return right[Number(left)];
    return inventoryRefuse('stack_expression_refused');
  }
  return inventoryRefuse('stack_expression_refused');
}

/** Physical identities are observed from CloudFormation, not invented from a
 * target parameter. Attribute derivation is declaration mapping only; service
 * adapters must later compare these ARNs against actual AWS resource reads. */
function resourceAttributes(resources: InventoryStackResource[], template: InventoryTemplate) {
  const attrs: Record<string, string> = {};
  for (const r of resources) {
    let arn: string | undefined;
    if (r.type === 'AWS::Lambda::Function') arn = `arn:aws:lambda:${region}:${account}:function:${r.physicalId}`;
    if (r.type === 'AWS::Logs::LogGroup') arn = `arn:aws:logs:${region}:${account}:log-group:${r.physicalId}:*`;
    if (r.type === 'AWS::S3::Bucket') arn = `arn:aws:s3:::${r.physicalId}`;
    if (r.type === 'AWS::KMS::Key') {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.physicalId)) return inventoryRefuse('stack_physical_id_refused');
      arn = `arn:aws:kms:${region}:${account}:key/${r.physicalId}`;
    }
    if (r.type === 'AWS::SNS::Topic') {
      if (!new RegExp(`^arn:aws:sns:${region}:${account}:[A-Za-z0-9_-]+$`).test(r.physicalId)) return inventoryRefuse('stack_physical_id_refused');
      arn = r.physicalId;
    }
    if (r.type === 'AWS::DynamoDB::Table') arn = `arn:aws:dynamodb:${region}:${account}:table/${r.physicalId}`;
    if (r.type === 'AWS::Events::Rule') {
      const bus = template.Resources[r.logicalId].Properties.EventBusName;
      if (bus !== undefined && bus !== 'default') return inventoryRefuse('stack_event_bus_refused');
      arn = `arn:aws:events:${region}:${account}:rule/${r.physicalId}`;
    }
    if (r.type === 'AWS::StepFunctions::StateMachine') {
      if (!r.physicalId.startsWith(`arn:aws:states:${region}:${account}:stateMachine:`)) return inventoryRefuse('stack_physical_id_refused');
      arn = r.physicalId;
    }
    if (r.type === 'AWS::SQS::Queue') {
      const prefix = `https://sqs.${region}.amazonaws.com/${account}/`;
      if (!r.physicalId.startsWith(prefix) || !/^[A-Za-z0-9_-]+(?:\.fifo)?$/.test(r.physicalId.slice(prefix.length))) return inventoryRefuse('stack_physical_id_refused');
      const name = r.physicalId.slice(prefix.length); arn = `arn:aws:sqs:${region}:${account}:${name}`; attrs[`${r.logicalId}.QueueName`] = name;
    }
    if (r.type === 'AWS::IAM::Role') {
      const path = template.Resources[r.logicalId].Properties.Path ?? '/';
      if (typeof path !== 'string' || !/^\/[\x21-\x7e]*\/$|^\/$/.test(path)) return inventoryRefuse('stack_role_path_refused');
      arn = `arn:aws:iam::${account}:role${path}${r.physicalId}`;
    }
    if (arn) attrs[`${r.logicalId}.Arn`] = arn;
  }
  return attrs;
}

/** CloudFormation declarations and physical mapping, not service state, code
 * contents, ledger, runtime acceptance, human review or PHI approval. */
export function inspectInventoryStackDeclarations(candidate: InventoryCandidateTarget, artifact: InventoryCandidateArtifact,
  observations: { stack: unknown; template: unknown; resources: unknown }): InventoryStackSnapshot {
  if (candidate.candidate !== artifact.candidate || candidate.templateSha256 !== artifact.templateSha256
    || candidate.manifestSha256 !== artifact.manifestSha256) return inventoryRefuse('stack_artifact_refused');
  const { stack, template: observed, resources: listing } = observations;
  if (!inventoryRecord(stack) || !Array.isArray(stack.Stacks) || stack.Stacks.length !== 1 || !inventoryRecord(stack.Stacks[0])) return inventoryRefuse('stack_shape_refused');
  const s = stack.Stacks[0], prefix = `arn:aws:cloudformation:${region}:${account}:stack/${candidate.stackName}/`;
  if (s.StackName !== candidate.stackName || typeof s.StackId !== 'string' || !s.StackId.startsWith(prefix)
    || !complete.includes(String(s.StackStatus)) || s.DeletionTime !== undefined) return inventoryRefuse('stack_state_refused');
  same(pairs(s.Parameters, 'ParameterKey', 'ParameterValue'), candidate.parameters, 'stack_parameters_refused');
  if (!inventoryRecord(observed) || !Object.hasOwn(observed, 'TemplateBody')) return inventoryRefuse('stack_template_refused');
  let actual = observed.TemplateBody;
  if (typeof actual === 'string') { try { actual = JSON.parse(actual); } catch { return inventoryRefuse('stack_template_refused'); } }
  same(actual, artifact.template, 'stack_template_refused');
  const parameters = { ...candidate.parameters, 'AWS::AccountId': account, 'AWS::Region': region, 'AWS::Partition': 'aws',
    'AWS::StackName': candidate.stackName, 'AWS::StackId': s.StackId, 'AWS::URLSuffix': 'amazonaws.com' };
  const context: Context = { template: artifact.template, parameters, refs: {}, attributes: {} };
  const active = Object.entries(artifact.template.Resources).filter(([, r]) => r.Condition === undefined || condition(r.Condition, context));
  if (active.some(([, r]) => !types.has(r.Type))) return inventoryRefuse('stack_resource_type_refused');
  if (!inventoryRecord(listing) || !Array.isArray(listing.StackResourceSummaries) || listing.NextToken !== undefined
    || listing.StackResourceSummaries.length > 512) return inventoryRefuse('stack_resources_refused');
  const resources: InventoryStackResource[] = [], logical = new Set<string>();
  for (const row of listing.StackResourceSummaries) {
    if (!inventoryRecord(row)) return inventoryRefuse('stack_resources_refused');
    const logicalId = string(row.LogicalResourceId), physicalId = string(row.PhysicalResourceId), type = string(row.ResourceType);
    const expected = active.find(([id]) => id === logicalId);
    if (logical.has(logicalId) || !expected || expected[1].Type !== type || !complete.includes(String(row.ResourceStatus))) return inventoryRefuse('stack_resources_refused');
    logical.add(logicalId); resources.push({ logicalId, physicalId, type });
  }
  same([...logical].sort(), active.map(([id]) => id).sort(), 'stack_resources_refused');
  context.refs = Object.fromEntries(resources.map(r => [r.logicalId, r.physicalId]));
  context.attributes = resourceAttributes(resources, artifact.template);
  const resolved = resources.map(r => {
    const properties = resolveInventoryTemplate(artifact.template.Resources[r.logicalId].Properties, context);
    if (!inventoryRecord(properties)) return inventoryRefuse('stack_expression_refused');
    const nameProperty: Record<string, string> = { 'AWS::Lambda::Function': 'FunctionName', 'AWS::Logs::LogGroup': 'LogGroupName',
      'AWS::S3::Bucket': 'BucketName', 'AWS::DynamoDB::Table': 'TableName', 'AWS::Events::Rule': 'Name', 'AWS::IAM::Role': 'RoleName', 'AWS::CloudWatch::Alarm': 'AlarmName' };
    const name = nameProperty[r.type];
    if (name && properties[name] !== undefined && properties[name] !== r.physicalId) return inventoryRefuse('stack_physical_id_refused');
    if (r.type === 'AWS::StepFunctions::StateMachine' && properties.StateMachineName !== undefined
      && r.physicalId !== `arn:aws:states:${region}:${account}:stateMachine:${properties.StateMachineName}`) return inventoryRefuse('stack_physical_id_refused');
    if (r.type === 'AWS::SQS::Queue' && properties.QueueName !== undefined && context.attributes[`${r.logicalId}.QueueName`] !== properties.QueueName) return inventoryRefuse('stack_physical_id_refused');
    if (r.type === 'AWS::SNS::Topic' && properties.TopicName !== undefined
      && r.physicalId !== `arn:aws:sns:${region}:${account}:${properties.TopicName}`) return inventoryRefuse('stack_physical_id_refused');
    if (r.type === 'AWS::ApiGatewayV2::Api' && !/^[a-z0-9]{10}$/.test(r.physicalId)) return inventoryRefuse('stack_physical_id_refused');
    if (r.type === 'AWS::ApiGatewayV2::Stage' && r.physicalId !== properties.StageName) return inventoryRefuse('stack_physical_id_refused');
    return { ...r, properties };
  });
  const outputs: Record<string, string> = {};
  for (const [name, entry] of Object.entries(artifact.template.Outputs)) {
    if (!inventoryRecord(entry) || !Object.hasOwn(entry, 'Value')) return inventoryRefuse('stack_outputs_refused');
    if (entry.Condition !== undefined && !condition(entry.Condition, context)) continue;
    const value = resolveInventoryTemplate(entry.Value, context);
    if (!['string', 'number', 'boolean'].includes(typeof value)) return inventoryRefuse('stack_outputs_refused');
    outputs[name] = String(value);
  }
  same(pairs(s.Outputs, 'OutputKey', 'OutputValue'), outputs, 'stack_outputs_refused');
  return structuredClone({ stackId: s.StackId, outputs, resources: resolved });
}

/** Re-derive a supplied snapshot against artifact declarations. These synthetic
 * shape rows are consistency checks, NEVER observations of live CloudFormation.
 * The complete observer must separately make and repeat real stack reads. */
export function assertInventorySnapshotConsistency(snapshot: InventoryStackSnapshot, candidate: InventoryCandidateTarget,
  artifact: InventoryCandidateArtifact, category = 'stack_snapshot_refused') {
  const derived = inspectInventoryStackDeclarations(candidate, artifact, {
    stack: { Stacks: [{ StackName: candidate.stackName, StackId: snapshot.stackId, StackStatus: 'CREATE_COMPLETE',
      Parameters: Object.entries(candidate.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Outputs: Object.entries(snapshot.outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] },
    template: { TemplateBody: artifact.template }, resources: { StackResourceSummaries: snapshot.resources.map(r => ({
      LogicalResourceId: r.logicalId, PhysicalResourceId: r.physicalId, ResourceType: r.type, ResourceStatus: 'CREATE_COMPLETE' })) },
  });
  same(snapshot, derived, category);
}

/** Fixed read-only transport. Missing is only AWS's exact DescribeStacks
 * not-found reply; denied/timeout/parsing errors cannot mean not deployed. */
export function inventoryStackReader(execute: typeof execFileSync = execFileSync): InventoryStackRead {
  return async (operation, stackName) => {
    if (!['describe-stacks', 'get-template', 'list-stack-resources'].includes(operation) || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) return inventoryRefuse('stack_read_operation_refused');
    const args = ['cloudformation', operation, '--stack-name', stackName,
      ...(operation === 'get-template' ? ['--template-stage', 'Original'] : []), '--profile', 'ai-synthetic-member', '--region', region,
      '--output', 'json', '--no-cli-pager'];
    try {
      return JSON.parse(String(execute('aws', args, { encoding: 'utf8', windowsHide: true, timeout: 30000,
        maxBuffer: 4 * 1024 * 1024, env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
          AWS_MAX_ATTEMPTS: '1', AWS_CLI_AUTO_PROMPT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })));
    } catch (error) {
      const message = `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
      if (operation === 'describe-stacks' && [message, 'aws: [ERROR]: ' + message].includes(stderr)) return inventoryRefuse('inventory_stack_missing');
      return inventoryRefuse('stack_aws_read_failed');
    }
  };
}

/** Every read is repeated for drift detection. This is not an atomic AWS
 * snapshot, and no partial declaration check can issue an acceptance verdict. */
export async function observeInventoryStackDeclarations(candidate: InventoryCandidateTarget, artifact: InventoryCandidateArtifact,
  read: InventoryStackRead = inventoryStackReader()) {
  const c = structuredClone(candidate), a = structuredClone(artifact);
  const initial = { stack: await read('describe-stacks', c.stackName), template: await read('get-template', c.stackName),
    resources: await read('list-stack-resources', c.stackName) };
  const snapshot = inspectInventoryStackDeclarations(c, a, initial);
  const final = { stack: await read('describe-stacks', c.stackName), template: await read('get-template', c.stackName),
    resources: await read('list-stack-resources', c.stackName) };
  same(initial, final, 'stack_observation_changed');
  return { contract: 'inventory-qualification-stack-declarations/1', declarationsVerified: true,
    liveServicesVerified: false, wholeLedgerVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false,
    mutations: false, candidate: c.candidate, stackName: c.stackName, snapshotSha256: inventorySha(inventoryCanonical(snapshot)), snapshot };
}
