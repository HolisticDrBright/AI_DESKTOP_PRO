import { describe, expect, it } from 'vitest';
import type { execFileSync } from 'node:child_process';
import { inventoryObservedPolicy, inventoryServiceReader } from './inventory-qualification-service-observer';

it('uses only bounded read operations on the fixed member account profile and Ohio region', async () => {
  const calls: Array<{ file: unknown; args: unknown; options: unknown }> = [];
  const execute = ((file: unknown, args: unknown, options: unknown) => { calls.push({ file, args, options }); return '{}'; }) as typeof execFileSync;
  const read = inventoryServiceReader(execute);
  await read('lambda', 'get-function-configuration', { FunctionName: 'fictional-function' });
  await read('sqs', 'get-queue-attributes', { QueueUrl: 'fictional-queue', AttributeNames: ['All'] });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.file).toBe('aws'); expect(call.args).toContain('ai-synthetic-member'); expect(call.args).toContain('us-east-2');
    expect(call.options).toMatchObject({ timeout: 30000, windowsHide: true, maxBuffer: 4194304,
      env: { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '1', AWS_CLI_AUTO_PROMPT: 'off' } });
  }
  expect(calls[0].args).toContain('--function-name'); expect(calls[1].args).toContain('--attribute-names');
  for (const [s, o, p] of [
    ['lambda', 'delete-function', { FunctionName: 'fictional' }],
    ['lambda', 'get-function-configuration', { FunctionName: '--profile=production' }],
    ['lambda', 'get-function-configuration', { FunctionName: 'fictional', Profile: 'production' }],
    ['lambda', 'get-function-configuration', { FunctionName: 'bad\nvalue' }],
    ['lambda', 'get-function-configuration', { FunctionName: 'x'.repeat(2049) }],
    ['s3api', 'get-bucket-encryption', { Bucket: 'fictional', ExpectedBucketOwner: '173535830222' }],
    ['sqs', 'get-queue-attributes', { QueueUrl: 'fictional', AttributeNames: [] }],
  ] as const) await expect(read(s, o, p as Record<string, string | string[]>)).rejects.toThrow('service_read_operation_refused');
  expect(calls).toHaveLength(2);
});
describe('exact optional absence, not authorization failure', () => {
  const cases = [
    ['lambda', 'get-policy', 'GetPolicy', 'ResourceNotFoundException', { FunctionName: 'fictional' }],
    ['lambda', 'get-function-url-config', 'GetFunctionUrlConfig', 'ResourceNotFoundException', { FunctionName: 'fictional' }],
    ['dynamodb', 'get-resource-policy', 'GetResourcePolicy', 'PolicyNotFoundException', { ResourceArn: 'fictional' }],
    ['s3api', 'get-bucket-lifecycle-configuration', 'GetBucketLifecycleConfiguration', 'NoSuchLifecycleConfiguration', { Bucket: 'fictional', ExpectedBucketOwner: '588966314750' }],
    ['s3api', 'get-bucket-replication', 'GetBucketReplication', 'ReplicationConfigurationNotFoundError', { Bucket: 'fictional', ExpectedBucketOwner: '588966314750' }],
    ['s3api', 'get-object-lock-configuration', 'GetObjectLockConfiguration', 'ObjectLockConfigurationNotFoundError', { Bucket: 'fictional', ExpectedBucketOwner: '588966314750' }],
    ['s3api', 'get-bucket-tagging', 'GetBucketTagging', 'NoSuchTagSet', { Bucket: 'fictional', ExpectedBucketOwner: '588966314750' }],
  ] as const;
  for (const [s, o, provider, code, p] of cases) it(o, async () => {
    const message = `An error occurred (${code}) when calling the ${provider} operation: fictional absent optional configuration`;
    for (const prefix of ['', 'aws: [ERROR]: ']) {
      const execute = (() => { throw Object.assign(Error('private error'), { stderr: prefix + message }); }) as typeof execFileSync;
      await expect(inventoryServiceReader(execute)(s, o, p)).resolves.toBeNull();
    }
    for (const stderr of ['AccessDenied', 'timeout', message.replace(provider, 'DifferentOperation'), message.replace(code, 'ResourceMissing')]) {
      const execute = (() => { throw Object.assign(Error('private error'), { stderr }); }) as typeof execFileSync;
      await expect(inventoryServiceReader(execute)(s, o, p)).rejects.toThrow('service_aws_read_failed');
    }
  });
  it('a missing required resource remains a failed read', async () => {
    const execute = (() => { throw Object.assign(Error('private'), { stderr: 'An error occurred (ResourceNotFoundException) when calling the GetFunctionConfiguration operation: missing' }); }) as typeof execFileSync;
    await expect(inventoryServiceReader(execute)('lambda', 'get-function-configuration', { FunctionName: 'fictional' })).rejects.toThrow('service_aws_read_failed');
  });
});
it('normalizes policy syntax without relaxing authority, including literal percent strings', () => {
  const a = { Version: '2012-10-17', Id: 'default', Statement: [{ Sid: 'random', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:fictional:100%/file', Principal: { Service: 'lambda.amazonaws.com' } }] };
  const b = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:fictional:100%/file'], Principal: { Service: 'lambda.amazonaws.com' } }] };
  expect(inventoryObservedPolicy(JSON.stringify(a))).toEqual(inventoryObservedPolicy(encodeURIComponent(JSON.stringify(b))));
  const changed = structuredClone(b); changed.Statement[0].Resource = ['*']; expect(inventoryObservedPolicy(changed)).not.toEqual(inventoryObservedPolicy(a));
  const conditioned = { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*', Condition: { StringEquals: { Sid: 'constrained' } } }] };
  const other = structuredClone(conditioned); other.Statement[0].Condition.StringEquals.Sid = 'different';
  expect(inventoryObservedPolicy(conditioned)).not.toEqual(inventoryObservedPolicy(other));
  for (const value of ['not a policy', { Statement: {} }, 'x'.repeat(2 * 1024 * 1024 + 1)]) expect(() => inventoryObservedPolicy(value)).toThrow('service_policy_refused');
});
