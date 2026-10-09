if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-schema-upgrade-operator is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { ClinicalCoreMigration } from './migrations';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { AdoptedInventoryUpgradeError } from './adopted-plan-inventory-schema-upgrade';
import { executeAdoptedInventoryUpgradeCommand, type AdoptedInventoryUpgradeBuild } from './adopted-plan-inventory-upgrade-command';

declare const __ADOPTED_INVENTORY_UPGRADE_BUILD__: AdoptedInventoryUpgradeBuild;
declare const __ADOPTED_INVENTORY_MIGRATIONS__: ClinicalCoreMigration[];
const { profile, region, foundation } = QUALIFICATION_UPGRADE_AWS;
const aws = (args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
}));
executeAdoptedInventoryUpgradeCommand(process.argv.slice(2), __ADOPTED_INVENTORY_UPGRADE_BUILD__, {
  observeCaller: () => aws(['sts', 'get-caller-identity']),
  observeFoundation: () => aws(['cloudformation', 'describe-stacks', '--stack-name', foundation]),
  loadMigrations: () => __ADOPTED_INVENTORY_MIGRATIONS__,
  createDatabase: c => createRdsDataAdministrativeDatabase({ clusterArn: c.clusterArn, secretArn: c.secretArn,
    databaseName: c.qualificationDatabaseName, region }, { purpose: 'reviewed_production_schema_migration' },
    new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 })),
}).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error instanceof AdoptedInventoryUpgradeError ? `${error.category}${error.stage ? ':' + error.stage : ''}`
    : 'adopted_inventory_upgrade_operator_failed_inspect_same_target');
  process.exitCode = 1;
});
