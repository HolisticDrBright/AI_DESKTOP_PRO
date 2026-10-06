if (typeof window !== 'undefined') throw new Error('qualification-schema-upgrade-operator is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { loadClinicalCoreMigrations } from './migrations';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { EXPORT_RECOVERY_UPGRADE, QualificationUpgradeError, runQualificationSchemaUpgrade } from './qualification-schema-upgrade';
import { QUALIFICATION_UPGRADE_AWS, qualificationUpgradeFromAws } from './qualification-upgrade-aws-binding';

declare const __QUALIFICATION_UPGRADE_BUILD__: { sourceCommit: string; clean: boolean };
const { profile: PROFILE, region: REGION, account: ACCOUNT, foundation: FOUNDATION } = QUALIFICATION_UPGRADE_AWS;
function aws(args: string[]) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', PROFILE, '--region', REGION, '--output', 'json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}
async function main() {
  const [command, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length || !['inspect', 'upgrade'].includes(command)
    || (command === 'inspect' && confirmation !== undefined)
    || (command === 'upgrade' && (confirmation !== '--confirm-qualification-upgrade' || !__QUALIFICATION_UPGRADE_BUILD__.clean))) throw new QualificationUpgradeError('boundary_refused');
  const caller = aws(['sts', 'get-caller-identity']);
  // Read the actual fixed foundation in the actual signed-in account. No caller-provided
  // ARN, environment database override or alternate stack can redirect the upgrade.
  const configuration = qualificationUpgradeFromAws(caller, aws(['cloudformation', 'describe-stacks', '--stack-name', FOUNDATION]));
  // Pin SDK credentials to the same profile as both read-only AWS observations. No keys
  // are copied out of the profile and no secret value is fetched by this operator.
  const database = createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn, secretArn: configuration.secretArn,
    databaseName: configuration.qualificationDatabaseName, region: REGION }, { purpose: 'reviewed_production_schema_migration' },
    new RDSDataClient({ region: REGION, credentials: fromIni({ profile: PROFILE }), maxAttempts: 1 }));
  // Do not silently broaden the source-reviewed historical transition.
  const migrations = loadClinicalCoreMigrations('dist/aws-clinical-core/production-migrations').slice(0, EXPORT_RECOVERY_UPGRADE.countAfter);
  const result = await runQualificationSchemaUpgrade(database, migrations, configuration, command as 'inspect' | 'upgrade');
  console.log(JSON.stringify({ ...result, operatorSource: __QUALIFICATION_UPGRADE_BUILD__, foundation: FOUNDATION, awsAccountId: ACCOUNT }));
}
main().catch(error => {
  console.error(error instanceof QualificationUpgradeError ? `${error.category}${error.stage ? ':' + error.stage : ''}` : 'qualification_upgrade_operator_failed');
  process.exitCode = 1;
});
