if (typeof window !== 'undefined') throw new Error('qualification-program-schema-upgrade-operator is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { QUALIFICATION_UPGRADE_AWS, qualificationUpgradeFromAws } from './qualification-upgrade-aws-binding';
import { QualificationProgramUpgradeError, runQualificationProgramSchemaUpgrade } from './qualification-program-schema-upgrade';

declare const __QUALIFICATION_PROGRAM_UPGRADE_BUILD__: { sourceCommit: string; clean: boolean };
const { profile, region, account, foundation } = QUALIFICATION_UPGRADE_AWS;
function aws(args: string[]) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}
function sourceStillClean() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
    'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'],
    { encoding: 'utf8', windowsHide: true }).trim();
  return __QUALIFICATION_PROGRAM_UPGRADE_BUILD__.clean && commit === __QUALIFICATION_PROGRAM_UPGRADE_BUILD__.sourceCommit && !changed;
}
async function main() {
  const [command, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length || !['inspect', 'rehearse', 'upgrade'].includes(command)
    || (command === 'inspect' && confirmation !== undefined)
    || (command === 'rehearse' && confirmation !== '--rehearse-fictional-only')
    || (command === 'upgrade' && confirmation !== '--apply-reviewed-fictional-upgrade')
    || !sourceStillClean()) throw new QualificationProgramUpgradeError('boundary_refused');
  const caller = aws(['sts', 'get-caller-identity']);
  const configuration = qualificationUpgradeFromAws(caller,
    aws(['cloudformation', 'describe-stacks', '--stack-name', foundation]));
  const database = createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn,
    secretArn: configuration.secretArn, databaseName: configuration.qualificationDatabaseName, region },
  { purpose: 'reviewed_synthetic_migration' },
  new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1 }));
  const before = await runQualificationProgramSchemaUpgrade(database, 'inspect');
  if (command === 'inspect') {
    console.log(JSON.stringify({ ...before, awsAccountId: account, foundation, sourceCommit: __QUALIFICATION_PROGRAM_UPGRADE_BUILD__.sourceCommit }));
    return;
  }
  if (before.boundaryPresent) throw new QualificationProgramUpgradeError('recovery_required');
  const rehearsal = await runQualificationProgramSchemaUpgrade(database, 'rehearse');
  if (!rehearsal.rolledBack || rehearsal.applied || rehearsal.dataSha256 !== before.dataSha256
    || rehearsal.rowCount !== before.rowCount || rehearsal.tableCount !== before.tableCount)
    throw new QualificationProgramUpgradeError('verification_failed', 'rehearsal');
  if (command === 'rehearse') {
    console.log(JSON.stringify({ ...rehearsal, awsAccountId: account, foundation, sourceCommit: __QUALIFICATION_PROGRAM_UPGRADE_BUILD__.sourceCommit }));
    return;
  }
  if (!sourceStillClean()) throw new QualificationProgramUpgradeError('boundary_refused');
  const result = await runQualificationProgramSchemaUpgrade(database, 'upgrade');
  console.log(JSON.stringify({ ...result, rehearsalPassed: true, awsAccountId: account, foundation,
    sourceCommit: __QUALIFICATION_PROGRAM_UPGRADE_BUILD__.sourceCommit }));
}
main().catch(error => {
  console.error(error instanceof QualificationProgramUpgradeError
    ? `${error.category}${error.stage ? ':' + error.stage : ''}` : 'qualification_program_upgrade_operator_failed');
  process.exitCode = 1;
});
