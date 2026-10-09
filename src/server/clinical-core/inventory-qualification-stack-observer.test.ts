import { describe, expect, it } from 'vitest';
import type { execFileSync } from 'node:child_process';
import type { InventoryTemplate } from './inventory-qualification-artifacts';
import { inventoryStackReader, resolveInventoryTemplate } from './inventory-qualification-stack-observer';

const template: InventoryTemplate = { Parameters: { List: { Type: 'CommaDelimitedList' } }, Conditions: { Yes: { 'Fn::Equals': ['yes', 'yes'] }, No: { 'Fn::Equals': ['yes', 'no'] } }, Resources: {}, Outputs: {} };
const context = { template, parameters: { List: 'one, two', Name: 'Fictional' }, refs: { Function: 'fictional-function' }, attributes: { 'Function.Arn': 'fictional-arn' } };
it('resolves the supported resource intrinsics and never leaves a policy expression unexpanded', () => {
  expect(resolveInventoryTemplate({ 'Fn::Sub': ['${Name}:${Function}:${Function.Arn}:${Local}:${!literal}', { Local: 'value' }] }, context))
    .toBe('Fictional:fictional-function:fictional-arn:value:${literal}');
  expect(resolveInventoryTemplate({ 'Fn::Join': ['/', ['integrations', { Ref: 'Function' }]] }, context)).toBe('integrations/fictional-function');
  expect(resolveInventoryTemplate({ 'Fn::Select': [1, { 'Fn::Split': [':', 'one:two'] }] }, context)).toBe('two');
  expect(resolveInventoryTemplate({ Ref: 'List' }, context)).toEqual(['one', 'two']);
  expect(resolveInventoryTemplate({ 'Fn::GetAtt': ['Function', 'Arn'] }, context)).toBe('fictional-arn');
});
it('NoValue omits a disabled policy or property, and real false remains false', () => {
  const value = { Policies: [{ 'Fn::If': ['No', { Statement: 'not admitted' }, { Ref: 'AWS::NoValue' }] }],
    Disabled: { 'Fn::If': ['No', 'not admitted', { Ref: 'AWS::NoValue' }] }, Flag: { 'Fn::If': ['Yes', false, true] } };
  expect(resolveInventoryTemplate(value, context)).toEqual({ Policies: [], Flag: false });
});
describe('bounded expression refusal', () => {
  for (const [name, value] of Object.entries({ unknown: { 'Fn::Unknown': 'anything' }, mixed: { Ref: 'Name', bypass: true },
    missingRef: { Ref: 'Absent' }, missingAttribute: { 'Fn::GetAtt': 'Function.Unknown' },
    negativeSelect: { 'Fn::Select': [-1, ['one']] }, fractionalSelect: { 'Fn::Select': [0.5, ['one']] },
    overrunSelect: { 'Fn::Select': [1, ['one']] }, emptySplit: { 'Fn::Split': ['', 'one'] },
    malformedJoin: { 'Fn::Join': ['/', [{ nope: true }]] }, unknownCondition: { 'Fn::If': ['Unknown', true, false] },
    unknownSub: { 'Fn::Sub': '${Absent}' }, nonScalarSub: { 'Fn::Sub': '${List}' } })) {
    it(name, () => expect(() => resolveInventoryTemplate(value, context)).toThrow());
  }
  it('depth and collection limits', () => {
    let value: unknown = true; for (let n = 0; n < 70; n++) value = { nested: value };
    expect(() => resolveInventoryTemplate(value, context)).toThrow();
    expect(() => resolveInventoryTemplate(Array.from({ length: 4097 }, () => 1), context)).toThrow();
  });
});
it('read adapter admits exactly read-only member-profile CFN operations and bounded output', async () => {
  const calls: Array<{ file: unknown; args: unknown; options: unknown }> = [];
  const execute = ((file: unknown, args: unknown, options: unknown) => { calls.push({ file, args, options }); return '{"Stacks":[]}'; }) as typeof execFileSync;
  const read = inventoryStackReader(execute);
  for (const operation of ['describe-stacks', 'get-template', 'list-stack-resources'] as const) await read(operation, 'fictional-qualification-stack');
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call.file).toBe('aws'); expect(call.args).toContain('ai-synthetic-member'); expect(call.args).toContain('us-east-2');
    expect(call.options).toMatchObject({ timeout: 30000, maxBuffer: 4194304, windowsHide: true });
  }
  expect(calls[1].args).toContain('Original');
  await expect(read('delete-stack' as 'describe-stacks', 'fictional-stack')).rejects.toThrow('stack_read_operation_refused');
  await expect(read('describe-stacks', '--profile=production')).rejects.toThrow('stack_read_operation_refused');
  expect(calls).toHaveLength(3);
});
it('only the exact AWS missing-stack response denotes absence, never denied or timed out', async () => {
  const message = 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id fictional-stack does not exist';
  for (const [stderr, category] of [[message, 'inventory_stack_missing'], ['aws: [ERROR]: ' + message, 'inventory_stack_missing'],
    [message.replace('fictional-stack', 'other-stack'), 'stack_aws_read_failed'], ['AccessDenied', 'stack_aws_read_failed'], ['timeout', 'stack_aws_read_failed']]) {
    const execute = (() => { throw Object.assign(Error('raw error must not leak'), { stderr }); }) as typeof execFileSync;
    await expect(inventoryStackReader(execute)('describe-stacks', 'fictional-stack')).rejects.toThrow(category);
  }
});
