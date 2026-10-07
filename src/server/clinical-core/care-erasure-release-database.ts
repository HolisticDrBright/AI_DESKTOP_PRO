if (typeof window !== 'undefined') throw new Error('care-erasure-release-database is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { ClinicalCoreMigration } from './migrations';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { CARE_ERASURE_AWS, CareErasureUpgradeError, careErasureUpgradeFromAws,
  assertCareErasureUpgrade, runCareErasureSchemaUpgrade } from './care-erasure-schema-upgrade';
declare const __CARE_ERASURE_UPGRADE_BUILD__: { sourceCommit: string; clean: boolean };
declare const __CARE_ERASURE_MIGRATIONS__: ClinicalCoreMigration[];
declare const __CARE_ERASURE_REFERENCE_MIGRATIONS__: ClinicalCoreMigration[];
/** Source-only database port for the fresh recovery pipeline. No public CLI,
 * report loader, target selector, environment approval or activation action. */
export async function runCareErasureReleaseDatabase(command: 'inspect' | 'rehearse' | 'upgrade', sourceCommit: string) {
  if (!['inspect', 'rehearse', 'upgrade'].includes(command) || __CARE_ERASURE_UPGRADE_BUILD__.clean !== true
    || sourceCommit !== __CARE_ERASURE_UPGRADE_BUILD__.sourceCommit) throw new CareErasureUpgradeError('boundary_refused');
  const a = CARE_ERASURE_AWS;
  const aws = (args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', a.profile, '--region', a.region, '--output', 'json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  const configuration = careErasureUpgradeFromAws(aws(['sts', 'get-caller-identity']),
    aws(['cloudformation', 'describe-stacks', '--stack-name', a.foundation]));
  const migrations = __CARE_ERASURE_MIGRATIONS__.map(x => ({ ...x })), reference = __CARE_ERASURE_REFERENCE_MIGRATIONS__.map(x => ({ ...x }));
  assertCareErasureUpgrade(configuration, migrations, reference);
  const client = new RDSDataClient({ region: a.region, credentials: fromIni({ profile: a.profile }), maxAttempts: 1 });
  try {
    const database = createRdsDataAdministrativeDatabase(configuration, { purpose: 'reviewed_synthetic_migration' }, client);
    const result = await runCareErasureSchemaUpgrade(database, migrations, reference, configuration, command);
    return { ...result, operatorSource: __CARE_ERASURE_UPGRADE_BUILD__, awsAccountId: a.account, foundation: a.foundation };
  } finally { client.destroy(); }
}
