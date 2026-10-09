if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-native-ports is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { BeginTransactionCommand, CommitTransactionCommand, ExecuteStatementCommand, RollbackTransactionCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { RdsDataCommandClient } from './rds-data-database';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { AdoptedInventoryUpgradeError } from './adopted-plan-inventory-schema-upgrade';
import type { AdoptedInventoryUpgradeDependencies } from './adopted-plan-inventory-upgrade-command';
import { withInventoryOperatorFence } from './adopted-plan-inventory-operator-fence';
import { INVENTORY_OPERATOR_SHARED_ROOT, createNativeInventoryCustody, openNativeInventoryRecovery } from './adopted-plan-inventory-native-custody';

const { profile, region, foundation, account } = QUALIFICATION_UPGRADE_AWS;
export const INVENTORY_RDS_ENDPOINT = 'https://rds-data.us-east-2.amazonaws.com';
// Longer than Data API's 45-second service timeout; SQL has its own 30-second bound.
export const INVENTORY_RDS_REQUEST_DEADLINE_MS = 60_000;
const refuse = (): never => { throw new AdoptedInventoryUpgradeError('boundary_refused'); };

/** Only two fixed read-only AWS CLI observations. No endpoint/argument override. */
export function observeInventoryAws(kind: 'caller' | 'foundation'): unknown {
  if (kind !== 'caller' && kind !== 'foundation') return refuse();
  const args = kind === 'caller' ? ['sts', 'get-caller-identity'] : ['cloudformation', 'describe-stacks', '--stack-name', foundation];
  const endpoint = kind === 'caller' ? 'https://sts.us-east-2.amazonaws.com' : 'https://cloudformation.us-east-2.amazonaws.com';
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--endpoint-url', endpoint,
    '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '1', AWS_CLI_AUTO_PROMPT: 'off' } }));
}

/** The public operator and qualification worker share this exact live transport. */
export function createBoundInventoryRdsClient(binding: { clusterArn: string; secretArn: string; qualificationDatabaseName: string }): RdsDataCommandClient {
  if (!binding.clusterArn.startsWith(`arn:aws:rds:${region}:${account}:cluster:`)
    || !binding.secretArn.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:`)
    || binding.qualificationDatabaseName !== 'clinical_core_qualification') return refuse();
  const pin = { ...binding };
  const client = new RDSDataClient({ region, endpoint: INVENTORY_RDS_ENDPOINT, maxAttempts: 1,
    credentials: fromIni({ profile, clientConfig: { region, endpoint: 'https://sts.us-east-2.amazonaws.com' } }) });
  return { async send(command) {
    if (!(command instanceof BeginTransactionCommand || command instanceof ExecuteStatementCommand
      || command instanceof CommitTransactionCommand || command instanceof RollbackTransactionCommand)) return refuse();
    if (command.input.resourceArn !== pin.clusterArn || command.input.secretArn !== pin.secretArn
      || (command instanceof BeginTransactionCommand || command instanceof ExecuteStatementCommand)
        && command.input.database !== pin.qualificationDatabaseName
      || command instanceof ExecuteStatementCommand && command.input.continueAfterTimeout === true) return refuse();
    const options = { abortSignal: AbortSignal.timeout(INVENTORY_RDS_REQUEST_DEADLINE_MS) };
    const response = command instanceof BeginTransactionCommand ? await client.send(command, options)
      : command instanceof ExecuteStatementCommand ? await client.send(command, options)
      : command instanceof CommitTransactionCommand ? await client.send(command, options) : await client.send(command, options);
    return response as unknown as Record<string, unknown>;
  } };
}

export function createNativeInventoryUpgradeDependencies(operatorFile: string,
  loadMigrations: () => ClinicalCoreMigration[]): AdoptedInventoryUpgradeDependencies {
  let database: ClinicalCoreDatabase | undefined;
  const custodyOptions = { root: INVENTORY_OPERATOR_SHARED_ROOT, operatorFile };
  return {
    observeCaller: () => observeInventoryAws('caller'), observeFoundation: () => observeInventoryAws('foundation'), loadMigrations,
    createDatabase: c => database = createRdsDataAdministrativeDatabase({ clusterArn: c.clusterArn, secretArn: c.secretArn,
      databaseName: c.qualificationDatabaseName, region }, { purpose: 'reviewed_production_schema_migration' }, createBoundInventoryRdsClient(c)),
    withFence: work => {
      if (!database) throw new AdoptedInventoryUpgradeError('custody_refused', 'database_unavailable');
      return withInventoryOperatorFence(database, work);
    },
    createCustody: (binding, baseline, fence) => createNativeInventoryCustody(custodyOptions, binding, baseline, fence),
    openRecoveryCustody: (binding, fence) => openNativeInventoryRecovery(custodyOptions, binding, fence),
  };
}
