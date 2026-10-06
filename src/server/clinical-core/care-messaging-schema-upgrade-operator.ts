if (typeof window !== 'undefined') throw new Error('care-messaging-schema-upgrade-operator is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadClinicalCoreMigrations } from './migrations';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { QUALIFICATION_UPGRADE_AWS, qualificationUpgradeFromAws } from './qualification-upgrade-aws-binding';
import { CARE_MESSAGING_UPGRADE, CareMessagingUpgradeError, runCareMessagingSchemaUpgrade } from './care-messaging-schema-upgrade';

declare const __CARE_MESSAGING_UPGRADE_BUILD__: { sourceCommit: string; clean: boolean };
const { profile, region, account, foundation } = QUALIFICATION_UPGRADE_AWS;
const aws = (args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
async function main() {
  const [command, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length || !['inspect', 'rehearse', 'upgrade'].includes(command)
    || command === 'inspect' && confirmation !== undefined
    || command !== 'inspect' && (confirmation !== '--confirm-fictional-care-upgrade' || !__CARE_MESSAGING_UPGRADE_BUILD__.clean)) {
    throw new CareMessagingUpgradeError('boundary_refused');
  }
  // Same source-reviewed foundation/profile, observed STS assumed role, PHI-off
  // posture and CLI/SDK credential binding as the historical upgrade operator.
  const bound = qualificationUpgradeFromAws(aws(['sts', 'get-caller-identity']),
    aws(['cloudformation', 'describe-stacks', '--stack-name', foundation]));
  const configuration = { ...bound, fromReleaseSha256: CARE_MESSAGING_UPGRADE.from, toReleaseSha256: CARE_MESSAGING_UPGRADE.to };
  const migrations = loadClinicalCoreMigrations('dist/aws-clinical-core/production-migrations');
  const database = createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn, secretArn: configuration.secretArn,
    databaseName: configuration.qualificationDatabaseName, region }, { purpose: 'reviewed_production_schema_migration' },
  new RDSDataClient({ region, credentials: fromIni({ profile }) }));
  // A physical rollback rehearsal is mandatory in this shipped write entry point.
  // No review placeholder, changed migration or alternate database can bypass it.
  const rehearsal = command === 'upgrade' ? await runCareMessagingSchemaUpgrade(database, migrations, configuration, 'rehearse') : undefined;
  if (rehearsal && !rehearsal.rolledBack) throw new CareMessagingUpgradeError('verification_failed');
  const result = await runCareMessagingSchemaUpgrade(database, migrations, configuration, command as 'inspect' | 'rehearse' | 'upgrade');
  console.log(JSON.stringify({ ...result, rehearsal: rehearsal ? { rolledBack: rehearsal.rolledBack, dataSha256: rehearsal.dataSha256 } : null,
    operatorSource: __CARE_MESSAGING_UPGRADE_BUILD__, foundation, awsAccountId: account }));
}
main().catch(error => {
  console.error(error instanceof CareMessagingUpgradeError ? `${error.category}${error.stage ? ':' + error.stage : ''}` : 'care_message_upgrade_operator_failed');
  process.exitCode = 1;
});
