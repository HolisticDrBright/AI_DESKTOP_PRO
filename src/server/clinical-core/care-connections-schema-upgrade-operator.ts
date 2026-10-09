if (typeof window !== 'undefined') throw new Error('care-connections-schema-upgrade-operator is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadClinicalCoreMigrations } from './migrations';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { CareConnectionsUpgradeError } from './care-connections-schema-upgrade';
import { executeCareConnectionsUpgradeCommand, type CareConnectionsUpgradeBuild } from './care-connections-upgrade-command';

declare const __CARE_CONNECTIONS_UPGRADE_BUILD__: CareConnectionsUpgradeBuild;
const { profile, region, foundation } = QUALIFICATION_UPGRADE_AWS;
const aws = (args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));

executeCareConnectionsUpgradeCommand(process.argv.slice(2), __CARE_CONNECTIONS_UPGRADE_BUILD__, {
  observeCaller: () => aws(['sts', 'get-caller-identity']),
  observeFoundation: () => aws(['cloudformation', 'describe-stacks', '--stack-name', foundation]),
  loadMigrations: () => loadClinicalCoreMigrations('dist/aws-clinical-core/production-migrations').slice(0, 105),
  createDatabase: c => createRdsDataAdministrativeDatabase({ clusterArn: c.clusterArn, secretArn: c.secretArn,
    databaseName: c.qualificationDatabaseName, region }, { purpose: 'reviewed_production_schema_migration' },
    new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 })),
}).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error instanceof CareConnectionsUpgradeError ? `${error.category}${error.stage ? ':' + error.stage : ''}` : 'care_connections_upgrade_operator_failed');
  process.exitCode = 1;
});
