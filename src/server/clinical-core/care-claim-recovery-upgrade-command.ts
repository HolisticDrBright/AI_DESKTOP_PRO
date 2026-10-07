if (typeof window !== 'undefined') throw new Error('care-claim-recovery-upgrade-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { qualificationUpgradeFromAws, QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { CARE_CLAIM_RECOVERY_UPGRADE, CareClaimRecoveryUpgradeError, assertCareClaimRecoveryUpgrade,
  runCareClaimRecoverySchemaUpgrade, type CareClaimRecoveryUpgradeResult } from './care-claim-recovery-schema-upgrade';

export type CareClaimRecoveryUpgradeBuild = { sourceCommit: string; clean: boolean };
export type CareClaimRecoveryUpgradeDependencies = {
  observeCaller: () => unknown;
  observeFoundation: () => unknown;
  loadMigrations: () => ClinicalCoreMigration[];
  createDatabase: (configuration: QualificationUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runCareClaimRecoverySchemaUpgrade;
};
const refuse = (): never => { throw new CareClaimRecoveryUpgradeError('boundary_refused'); };
function observedTarget(d: CareClaimRecoveryUpgradeDependencies) {
  const observed = qualificationUpgradeFromAws(d.observeCaller(), d.observeFoundation());
  return { ...observed, fromReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.from, toReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to };
}
function verifyResult(result: CareClaimRecoveryUpgradeResult, command: 'inspect' | 'rehearse' | 'upgrade') {
  const count = result.observedMigrationCount;
  if (result.contract !== 'care-claim-recovery-schema-upgrade/1' || result.command !== command
    || result.execution !== 'qualification' || result.phiAllowed !== false || result.activation !== 'blocked'
    || result.canonical !== false || result.dataPreserved !== true || ![105, 106].includes(count)
    || result.tableCount !== (count === 105 ? 207 : 209)
    || result.fromReleaseSha256 !== CARE_CLAIM_RECOVERY_UPGRADE.from || result.toReleaseSha256 !== CARE_CLAIM_RECOVERY_UPGRADE.to
    || !/^[a-f0-9]{64}$/.test(result.dataSha256) || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0
    || typeof result.alreadyApplied !== 'boolean' || typeof result.applied !== 'boolean'
    || result.rolledBack !== (command === 'rehearse')
    || command !== 'upgrade' && result.applied !== false
    || command === 'upgrade' && (count !== 106 || result.applied !== !result.alreadyApplied)) {
    throw new CareClaimRecoveryUpgradeError('verification_failed');
  }
}

/** A prepared qualification transition, not canonical promotion or activation.
 * The CLI embeds SQL and observes its fixed member account/foundation itself.
 * No target, credential, release, review, or skip-rehearsal argument exists. */
export async function executeCareClaimRecoveryUpgradeCommand(args: readonly string[], suppliedBuild: CareClaimRecoveryUpgradeBuild,
  dependencies: CareClaimRecoveryUpgradeDependencies) {
  const build = { ...suppliedBuild };
  const [command, confirmation, ...extra] = args;
  if (extra.length || !['inspect', 'rehearse', 'upgrade'].includes(command)
    || !/^[a-f0-9]{40}$/.test(build.sourceCommit) || typeof build.clean !== 'boolean'
    || command === 'inspect' && confirmation !== undefined
    || command !== 'inspect' && (confirmation !== '--confirm-fictional-care-claim-recovery-upgrade' || !build.clean)) refuse();
  const configuration = observedTarget(dependencies);
  const migrations = dependencies.loadMigrations().map(m => ({ ...m }));
  assertCareClaimRecoveryUpgrade(configuration, migrations);
  const database = dependencies.createDatabase({ ...configuration });
  const run = dependencies.run ?? runCareClaimRecoverySchemaUpgrade;
  let rehearsal: CareClaimRecoveryUpgradeResult | null = null;
  if (command === 'upgrade') {
    rehearsal = await run(database, migrations.map(m => ({ ...m })), { ...configuration }, 'rehearse');
    verifyResult(rehearsal, 'rehearse');
    // Re-observe after rehearsal, before admitting another transaction. This
    // does not make the two transactions atomic or freeze fictional records.
    const current = observedTarget(dependencies);
    if (JSON.stringify(current) !== JSON.stringify(configuration)) refuse();
    assertCareClaimRecoveryUpgrade(configuration, migrations);
  }
  const result = await run(database, migrations.map(m => ({ ...m })), { ...configuration }, command as 'inspect' | 'rehearse' | 'upgrade');
  verifyResult(result, command as 'inspect' | 'rehearse' | 'upgrade');
  return { ...result, rehearsal: rehearsal ? { rolledBack: true, dataSha256: rehearsal.dataSha256, rowCount: rehearsal.rowCount } : null,
    operatorSource: build, operatorScope: 'prepared_qualification_only' as const,
    foundation: QUALIFICATION_UPGRADE_AWS.foundation, awsAccountId: QUALIFICATION_UPGRADE_AWS.account };
}
