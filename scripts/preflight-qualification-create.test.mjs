import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectCreateInputs, inspectLiveCreate } from './preflight-qualification-create.mjs';

function fixture() {
  const templateBytes = Buffer.from(JSON.stringify({ Resources: {
    Function: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: { 'Fn::Sub': '${ApiId}-personal-storage' }, ReservedConcurrentExecutions: 4 } },
    Logs: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: { 'Fn::Sub': '/aws/lambda/${ApiId}-personal-storage' } } },
  } }));
  return { templateBytes, templateSha256: createHash('sha256').update(templateBytes).digest('hex'), stack: 'ai-clinical-core-qualification-personal-storage',
    parameters: Object.entries({ ApiId: 'fictional-api', PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'enabled', QualificationAccountId: '588966314750' }).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) };
}
function reader(overrides = {}, calls = []) {
  return args => { const key = args.slice(0, 2).join('.'); calls.push(key);
    if (Object.hasOwn(overrides, key)) { if (overrides[key] instanceof Error) throw overrides[key]; return overrides[key]; }
    return { 'sts.get-caller-identity': { Account: '588966314750' }, 'cloudformation.describe-stacks': null,
      'lambda.get-account-settings': { AccountLimit: { ConcurrentExecutions: 135, UnreservedConcurrentExecutions: 135 } },
      'lambda.get-function-configuration': null, 'logs.describe-log-groups': { logGroups: [] } }[key];
  };
}
test('qualifies initial creation only, with observed capacity and no activation claim', () => {
  const calls = []; const report = inspectLiveCreate(inspectCreateInputs(fixture()), reader({}, calls));
  assert.equal(report.ok, true); assert.equal(report.activationEvidence, false); assert.equal(report.requestedReserved, 4); assert.equal(report.unreservedRequiredForCreate, 104);
  assert.deepEqual(calls, ['sts.get-caller-identity', 'cloudformation.describe-stacks', 'lambda.get-account-settings', 'lambda.get-function-configuration', 'logs.describe-log-groups']);
});
test('refuses template tampering before any observation', () => { const input = fixture(); input.templateBytes = Buffer.from('{}'); assert.throws(() => inspectCreateInputs(input), /template_digest/); });
test('missing or unresolved concurrency and names fail closed', () => {
  for (const patch of [{ReservedConcurrentExecutions:0},{ReservedConcurrentExecutions:'4'},{ReservedConcurrentExecutions:{Ref:'Missing'}},{FunctionName:{'Fn::Sub':'${Missing}-function'}}]) {
    const input = fixture(); const template = JSON.parse(input.templateBytes); Object.assign(template.Resources.Function.Properties, patch);
    input.templateBytes = Buffer.from(JSON.stringify(template)); input.templateSha256 = createHash('sha256').update(input.templateBytes).digest('hex');
    assert.throws(() => inspectCreateInputs(input), /qualification_preflight_refused/);
  }
});
test('all functions contribute to the requested capacity', () => {
  const input = fixture(); const template = JSON.parse(input.templateBytes);
  template.Resources.Worker = {Type:'AWS::Lambda::Function',Properties:{FunctionName:'fictional-worker',ReservedConcurrentExecutions:3}};
  input.templateBytes = Buffer.from(JSON.stringify(template)); input.templateSha256 = createHash('sha256').update(input.templateBytes).digest('hex');
  assert.equal(inspectCreateInputs(input).reserved, 7);
});
for (const [key, value] of [['PhiAllowed','true'], ['Activation','approved'], ['QualificationExecution','disabled'], ['QualificationAccountId','173535830222']]) {
  test(`refuses unsafe ${key}`, () => { const input = fixture(); input.parameters.find(row => row.ParameterKey === key).ParameterValue = value; assert.throws(() => inspectCreateInputs(input), /qualification_boundary/); });
}
test('refuses duplicate parameters and unreviewed stack names', () => {
  const input = fixture(); input.parameters.push(input.parameters[0]); assert.throws(() => inspectCreateInputs(input), /parameter_shape/);
  assert.throws(() => inspectCreateInputs({ ...fixture(), stack: 'ai-clinical-core-production' }), /stack_name/);
});
test('refuses wrong live account before inspecting resources', () => { const calls = []; assert.throws(() => inspectLiveCreate(inspectCreateInputs(fixture()), reader({ 'sts.get-caller-identity': { Account: '173535830222' } }, calls)), /account/); assert.deepEqual(calls, ['sts.get-caller-identity']); });
test('low quota and retained rollback resources are independent blockers', () => {
  const report = inspectLiveCreate(inspectCreateInputs(fixture()), reader({
    'cloudformation.describe-stacks': { Stacks: [{ StackStatus: 'ROLLBACK_COMPLETE' }] },
    'lambda.get-account-settings': { AccountLimit: { ConcurrentExecutions: 10, UnreservedConcurrentExecutions: 10 } },
    'logs.describe-log-groups': { logGroups: [{ logGroupName: '/aws/lambda/fictional-api-personal-storage' }] },
  }));
  assert.equal(report.ok, false); assert.equal(report.blockers.length, 3);
});
test('capacity observes existing reservations, not only total quota', () => {
  const report = inspectLiveCreate(inspectCreateInputs(fixture()), reader({ 'lambda.get-account-settings': { AccountLimit: { ConcurrentExecutions: 1000, UnreservedConcurrentExecutions: 103 } } }));
  assert.deepEqual(report.blockers, ['insufficient_unreserved_capacity']);
});
test('existing function blocks initial create; prefix-neighbor log does not collide', () => {
  const report = inspectLiveCreate(inspectCreateInputs(fixture()), reader({ 'lambda.get-function-configuration': { State: 'Active' }, 'logs.describe-log-groups': { logGroups: [{ logGroupName: '/aws/lambda/fictional-api-personal-storage-old' }] } }));
  assert.deepEqual(report.blockers, ['function_exists:fictional-api-personal-storage']);
});
test('unknown capacity and denied observations are never a pass', () => {
  for (const bad of [null, {}, { ConcurrentExecutions: 10, UnreservedConcurrentExecutions: 1000 }, { ConcurrentExecutions: 1000, UnreservedConcurrentExecutions: '1000' }]) assert.throws(() => inspectLiveCreate(inspectCreateInputs(fixture()), reader({ 'lambda.get-account-settings': { AccountLimit: bad } })), /capacity_observation/);
  assert.throws(() => inspectLiveCreate(inspectCreateInputs(fixture()), reader({ 'logs.describe-log-groups': new Error('access_denied') })), /access_denied/);
});
