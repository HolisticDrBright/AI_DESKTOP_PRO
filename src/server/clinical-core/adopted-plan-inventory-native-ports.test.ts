import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), ini: vi.fn(), send: vi.fn(), config: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('@aws-sdk/credential-provider-ini', () => ({ fromIni: mocks.ini }));
vi.mock('@aws-sdk/client-rds-data', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-rds-data')>();
  return { ...actual, RDSDataClient: class { constructor(configuration: unknown) { mocks.config(configuration); } send = mocks.send; } };
});
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { createBoundInventoryRdsClient, observeInventoryAws, INVENTORY_RDS_ENDPOINT, INVENTORY_RDS_REQUEST_DEADLINE_MS } from './adopted-plan-inventory-native-ports';
const binding = { clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional', qualificationDatabaseName: 'clinical_core_qualification' };
const common = { resourceArn: binding.clusterArn, secretArn: binding.secretArn, database: binding.qualificationDatabaseName };
beforeEach(() => { vi.clearAllMocks(); mocks.exec.mockReturnValue('{}'); mocks.send.mockResolvedValue({}); });
it('pins both read observations to the member profile and exact AWS service endpoint', () => {
  observeInventoryAws('caller'); observeInventoryAws('foundation');
  expect(mocks.exec.mock.calls[0][1]).toEqual(['sts', 'get-caller-identity', '--profile', 'ai-synthetic-member', '--region', 'us-east-2', '--endpoint-url', 'https://sts.us-east-2.amazonaws.com', '--output', 'json', '--no-cli-pager']);
  expect(mocks.exec.mock.calls[1][1]).toContain('https://cloudformation.us-east-2.amazonaws.com');
  expect(mocks.exec.mock.calls[1][1]).toContain('ai-clinical-core-qualification-foundation');
  for (const call of mocks.exec.mock.calls) expect(call[2]).toMatchObject({ timeout: 30000, windowsHide: true, env: { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '1', AWS_CLI_AUTO_PROMPT: 'off' } });
  expect(() => observeInventoryAws('secret' as never)).toThrow('boundary_refused');
  expect(mocks.exec).toHaveBeenCalledTimes(2);
});
it('pins SDK and credential STS endpoints, refuses retries, and bounds every admitted request', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const client = createBoundInventoryRdsClient(binding);
  expect(mocks.config).toHaveBeenCalledWith(expect.objectContaining({ endpoint: INVENTORY_RDS_ENDPOINT, region: 'us-east-2', maxAttempts: 1 }));
  expect(mocks.ini).toHaveBeenCalledWith({ profile: 'ai-synthetic-member', clientConfig: { region: 'us-east-2', endpoint: 'https://sts.us-east-2.amazonaws.com' } });
  for (const command of [new BeginTransactionCommand(common), new ExecuteStatementCommand({ ...common, transactionId: 'fictional', sql: 'select 1' }),
    new CommitTransactionCommand({ ...common, transactionId: 'fictional' }), new RollbackTransactionCommand({ ...common, transactionId: 'fictional' })]) {
    await client.send(command);
  }
  expect(mocks.send).toHaveBeenCalledTimes(4);
  for (const call of mocks.send.mock.calls) expect(call[1].abortSignal).toBeInstanceOf(AbortSignal);
  expect(timeout.mock.calls).toEqual(Array.from({ length: 4 }, () => [INVENTORY_RDS_REQUEST_DEADLINE_MS]));
  timeout.mockRestore();
});
it.each([{ ...binding, qualificationDatabaseName: 'clinical_core' }, { ...binding, clusterArn: binding.clusterArn.replace('588966314750', '173535830222') },
  { ...binding, secretArn: binding.secretArn.replace('us-east-2', 'us-west-2') }])('refuses an alternate database, account or region before SDK construction', bad => {
  expect(() => createBoundInventoryRdsClient(bad)).toThrow('boundary_refused'); expect(mocks.config).not.toHaveBeenCalled();
});
it('refuses foreign commands, targets and continue-after-timeout before dispatch', async () => {
  const client = createBoundInventoryRdsClient(binding);
  for (const command of [{ input: common }, new BeginTransactionCommand({ ...common, database: 'clinical_core' }),
    new ExecuteStatementCommand({ ...common, sql: 'select 1', continueAfterTimeout: true }), new CommitTransactionCommand({ ...common, resourceArn: `${binding.clusterArn}-other`, transactionId: 'fictional' })]) {
    await expect(client.send(command)).rejects.toThrow('boundary_refused');
  }
  expect(mocks.send).not.toHaveBeenCalled();
});
