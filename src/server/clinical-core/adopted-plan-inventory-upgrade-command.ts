if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-upgrade-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { qualificationUpgradeFromAws, QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { ADOPTED_INVENTORY_UPGRADE, AdoptedInventoryUpgradeError, assertAdoptedInventoryUpgrade,
  runAdoptedInventorySchemaUpgrade, type AdoptedInventoryUpgradeResult } from './adopted-plan-inventory-schema-upgrade';

export type AdoptedInventoryUpgradeBuild = { sourceCommit: string; clean: boolean };
export type AdoptedInventoryUpgradeDependencies = {
  observeCaller: () => unknown; observeFoundation: () => unknown; loadMigrations: () => ClinicalCoreMigration[];
  createDatabase: (c: QualificationUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runAdoptedInventorySchemaUpgrade;
};
const refuse = (): never => { throw new AdoptedInventoryUpgradeError('boundary_refused'); };
function observe(d: AdoptedInventoryUpgradeDependencies) {
  const caller = d.observeCaller();
  const c = qualificationUpgradeFromAws(caller, d.observeFoundation());
  return { caller: JSON.stringify(caller), configuration: { ...c, fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to } };
}
function verify(r: AdoptedInventoryUpgradeResult, command: 'inspect' | 'rehearse' | 'upgrade') {
  if (r.contract !== 'adopted-plan-inventory-schema-upgrade/1' || r.command !== command || r.execution !== 'qualification'
    || r.phiAllowed !== false || r.activation !== 'blocked' || r.dataPreserved !== true || r.historicalSchemaPreserved !== true
    || ![106, 107].includes(r.observedMigrationCount) || r.tableCount !== ADOPTED_INVENTORY_UPGRADE.tableCount
    || !Number.isSafeInteger(r.rowCount) || r.rowCount < 0 || !/^[a-f0-9]{64}$/.test(r.dataSha256)
    || !/^[a-f0-9]{64}$/.test(r.historicalSchemaSha256) || typeof r.alreadyApplied !== 'boolean' || typeof r.applied !== 'boolean'
    || r.fromReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.from || r.toReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.to
    || r.rolledBack !== (command === 'rehearse') || command !== 'upgrade' && r.applied !== false
    || command !== 'upgrade' && r.alreadyApplied !== (r.observedMigrationCount === 107)
    || command === 'upgrade' && (r.observedMigrationCount !== 107 || r.applied !== !r.alreadyApplied)) {
    throw new AdoptedInventoryUpgradeError('verification_failed');
  }
}
/** Fixed synthetic account/foundation, embedded SQL, no target/review/credential
 * overrides. An uncertain write is not retried; the same target is inspected. */
export async function executeAdoptedInventoryUpgradeCommand(args: readonly string[], supplied: AdoptedInventoryUpgradeBuild,
  d: AdoptedInventoryUpgradeDependencies) {
  const build = { ...supplied }, [command, confirmation, ...extra] = args;
  if (extra.length || !['inspect', 'rehearse', 'upgrade'].includes(command) || !/^[a-f0-9]{40}$/.test(build.sourceCommit)
    || typeof build.clean !== 'boolean' || command === 'inspect' && confirmation !== undefined
    || command !== 'inspect' && (confirmation !== '--confirm-fictional-adopted-inventory-upgrade' || !build.clean)) refuse();
  const target = observe(d), migrations = d.loadMigrations().map(m => ({ ...m }));
  assertAdoptedInventoryUpgrade(target.configuration, migrations);
  const database = d.createDatabase({ ...target.configuration }), run = d.run ?? runAdoptedInventorySchemaUpgrade;
  let rehearsal: AdoptedInventoryUpgradeResult | null = null;
  if (command === 'upgrade') {
    rehearsal = await run(database, migrations.map(m => ({ ...m })), { ...target.configuration }, 'rehearse');
    verify(rehearsal, 'rehearse');
    if (JSON.stringify(observe(d)) !== JSON.stringify(target)) refuse();
  }
  const result = await run(database, migrations.map(m => ({ ...m })), { ...target.configuration },
    command as 'inspect' | 'rehearse' | 'upgrade', rehearsal ? {
      observedMigrationCount: rehearsal.observedMigrationCount, rowCount: rehearsal.rowCount,
      dataSha256: rehearsal.dataSha256, historicalSchemaSha256: rehearsal.historicalSchemaSha256,
    } : undefined);
  verify(result, command as 'inspect' | 'rehearse' | 'upgrade');
  if (rehearsal && (result.rowCount !== rehearsal.rowCount || result.dataSha256 !== rehearsal.dataSha256
    || result.historicalSchemaSha256 !== rehearsal.historicalSchemaSha256
    || result.alreadyApplied !== rehearsal.alreadyApplied)) {
    throw new AdoptedInventoryUpgradeError('verification_failed');
  }
  return { ...result, operatorSource: build, operatorScope: 'prepared_qualification_only' as const,
    foundation: QUALIFICATION_UPGRADE_AWS.foundation, awsAccountId: QUALIFICATION_UPGRADE_AWS.account,
    rehearsal: rehearsal ? { rolledBack: true, rowCount: rehearsal.rowCount, dataSha256: rehearsal.dataSha256,
      historicalSchemaSha256: rehearsal.historicalSchemaSha256 } : null };
}
