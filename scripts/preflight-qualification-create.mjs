import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ACCOUNT = '588966314750';
const REGION = 'us-east-2';
// AWS PutFunctionConcurrency requires 100 executions to remain unreserved.
const UNRESERVED_FLOOR = 100;
function refuse(code) { throw new Error(`qualification_preflight_refused:${code}`); }
function resolve(value, parameters) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value?.Ref && Object.hasOwn(parameters, value.Ref)) return parameters[value.Ref];
  if (typeof value?.['Fn::Sub'] === 'string') return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (!Object.hasOwn(parameters, key)) refuse('unresolved_resource_name');
    return parameters[key];
  });
  refuse('unsupported_resource_expression');
}

export function inspectCreateInputs({ templateBytes, templateSha256, parameters, stack }) {
  if (!/^[a-f0-9]{64}$/.test(templateSha256 ?? '') || createHash('sha256').update(templateBytes).digest('hex') !== templateSha256) refuse('template_digest');
  if (!/^ai-clinical-core-qualification-[a-z0-9-]+$/.test(stack ?? '')) refuse('stack_name');
  if (!Array.isArray(parameters)) refuse('parameters');
  const values = {};
  for (const row of parameters) {
    if (typeof row?.ParameterKey !== 'string' || typeof row.ParameterValue !== 'string' || Object.hasOwn(values, row.ParameterKey)) refuse('parameter_shape');
    values[row.ParameterKey] = row.ParameterValue;
  }
  if (values.PhiAllowed !== 'false' || values.Activation !== 'blocked' || values.QualificationExecution !== 'enabled' || values.QualificationAccountId !== ACCOUNT) refuse('qualification_boundary');
  const template = JSON.parse(templateBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const functions = [], logs = [];
  let reserved = 0;
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type === 'AWS::Lambda::Function') {
      const name = resolve(resource.Properties?.FunctionName, values);
      const raw = resolve(resource.Properties?.ReservedConcurrentExecutions, values);
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) refuse('unbounded_or_unresolved_concurrency');
      if (typeof name !== 'string' || !/^[a-zA-Z0-9-_]{1,64}$/.test(name)) refuse('function_name');
      functions.push(name); reserved += raw;
    }
    if (resource.Type === 'AWS::Logs::LogGroup') {
      const name = resolve(resource.Properties?.LogGroupName, values);
      if (typeof name !== 'string' || !/^\/aws\/lambda\/[a-zA-Z0-9-_]{1,64}$/.test(name)) refuse('log_name');
      logs.push(name);
    }
  }
  if (!functions.length || !Number.isSafeInteger(reserved) || new Set(functions).size !== functions.length || new Set(logs).size !== logs.length) refuse('resource_inventory');
  return { stack, templateSha256, functions, logs, reserved };
}

export function inspectLiveCreate(inputs, aws) {
  // aws is injected only for tests. CLI always performs these observations itself.
  if (aws(['sts', 'get-caller-identity']).Account !== ACCOUNT) refuse('account');
  const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', inputs.stack], 'stack');
  const limits = aws(['lambda', 'get-account-settings']).AccountLimit;
  if (!Number.isSafeInteger(limits?.ConcurrentExecutions) || !Number.isSafeInteger(limits?.UnreservedConcurrentExecutions) || limits.UnreservedConcurrentExecutions < 0 || limits.UnreservedConcurrentExecutions > limits.ConcurrentExecutions) refuse('capacity_observation');
  const blockers = [];
  if (stack !== null) blockers.push('existing_stack_requires_reviewed_update_or_recovery');
  if (limits.UnreservedConcurrentExecutions - inputs.reserved < UNRESERVED_FLOOR) blockers.push('insufficient_unreserved_capacity');
  for (const name of inputs.functions) {
    if (aws(['lambda', 'get-function-configuration', '--function-name', name], 'function') !== null) blockers.push(`function_exists:${name}`);
  }
  for (const name of inputs.logs) {
    const result = aws(['logs', 'describe-log-groups', '--log-group-name-prefix', name]);
    if (!Array.isArray(result.logGroups)) refuse('log_observation');
    if (result.logGroups.some(group => group.logGroupName === name)) blockers.push(`retained_log_requires_import_or_preserving_recovery:${name}`);
  }
  return { schema: 'qualification-create-preflight/1', observedAt: new Date().toISOString(), account: ACCOUNT, region: REGION,
    stack: inputs.stack, templateSha256: inputs.templateSha256, requestedReserved: inputs.reserved,
    unreservedObserved: limits.UnreservedConcurrentExecutions, unreservedRequiredForCreate: inputs.reserved + UNRESERVED_FLOOR,
    blockers, ok: blockers.length === 0, readOnly: true, deploymentPerformed: false, activationEvidence: false,
    limitation: 'Initial-create resource/capacity check only. Not review approval, full template validation or hosted acceptance. Recheck immediately before deployment; capacity can change.' };
}

export function awsReader(profile) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile ?? '')) refuse('profile');
  return (args, missingKind) => {
    const result = spawnSync('aws', [...args, '--profile', profile, '--region', REGION, '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, shell: false });
    if (result.error || result.status !== 0) {
      const error = result.stderr ?? '';
      if (!result.error && missingKind === 'stack' && /\(ValidationError\)/.test(error) && /Stack with id [^\r\n]+ does not exist/.test(error)) return null;
      if (!result.error && missingKind === 'function' && /\(ResourceNotFoundException\)/.test(error) && /Function not found/.test(error)) return null;
      // Do not print raw driver/CLI output, credentials or resource payloads.
      refuse(`aws_observation_failed:${args[0]}.${args[1]}`);
    }
    try { return JSON.parse(result.stdout); } catch { refuse('aws_response_shape'); }
  };
}

export function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--template', '--parameters', '--sha256', '--stack', '--profile'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(options, argv[i])) refuse('arguments');
    options[argv[i]] = argv[i + 1];
  }
  if (Object.keys(options).length !== 5) refuse('arguments');
  const inputs = inspectCreateInputs({ templateBytes: readFileSync(options['--template']), templateSha256: options['--sha256'], parameters: JSON.parse(readFileSync(options['--parameters'], 'utf8').replace(/^\uFEFF/, '')), stack: options['--stack'] });
  const report = inspectLiveCreate(inputs, awsReader(options['--profile']));
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message?.startsWith('qualification_preflight_refused:') ? error.message : 'qualification_preflight_refused:input_or_observation_error'); process.exitCode = 1; }
}
