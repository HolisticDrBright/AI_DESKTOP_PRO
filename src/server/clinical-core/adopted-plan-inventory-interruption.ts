import type { AdoptedInventoryUpgradeBuild, AdoptedInventoryUpgradeDependencies } from './adopted-plan-inventory-upgrade-command';
import { executeAdoptedInventoryUpgradeCommand, verifyAdoptedInventoryObservation } from './adopted-plan-inventory-upgrade-command';
import { AdoptedInventoryUpgradeError, runAdoptedInventorySchemaUpgrade, type AdoptedInventoryUpgradeResult } from './adopted-plan-inventory-schema-upgrade';

export const INVENTORY_INTERRUPTION_CONFIRMATION = '--confirm-fictional-inventory-interruption';
export const INVENTORY_POSTCOMMIT_CONFIRMATION = '--confirm-fictional-inventory-postcommit-upgrade';
export type InventoryInterruptionMode = 'before-write' | 'precommit' | 'postcommit';
export type InventoryInterruptionCheckpoint = { kind: 'checkpoint'; mode: InventoryInterruptionMode; execution: 'qualification';
  phiAllowed: false; activation: 'blocked'; transactionCommitAdmitted: boolean; providerCommitAcknowledged: boolean; observedMigrationCount: 106 | 107;
  rowCount: number; dataSha256: string; historicalSchemaSha256: string };
type Ports = { connected: () => boolean; checkpoint: (packet: InventoryInterruptionCheckpoint) => Promise<never>;
  run: typeof runAdoptedInventorySchemaUpgrade; execute: typeof executeAdoptedInventoryUpgradeCommand };

/** Instrumented qualification only: real core/ports, no altered DB observations.
 * Postcommit loses only the controller receipt AFTER an acknowledged provider
 * commit; it does not qualify provider commit-response loss or PHI activation. */
export async function runInventoryInterruptionWorker(args: readonly string[], build: AdoptedInventoryUpgradeBuild,
  dependencies: AdoptedInventoryUpgradeDependencies, ports: Ports) {
  const [mode, confirmation, ...extra] = args;
  if (extra.length || !['before-write', 'precommit', 'postcommit', 'reconcile'].includes(mode)
    || confirmation !== (mode === 'postcommit' ? INVENTORY_POSTCOMMIT_CONFIRMATION : INVENTORY_INTERRUPTION_CONFIRMATION)
    || !build.clean || !/^[a-f0-9]{40}$/.test(build.sourceCommit) || !ports.connected()) throw new AdoptedInventoryUpgradeError('boundary_refused');
  const checkpoint = (observed: AdoptedInventoryUpgradeResult, committed = false) => ports.checkpoint({ kind: 'checkpoint', mode: mode as InventoryInterruptionMode,
    execution: 'qualification', phiAllowed: false, activation: 'blocked', transactionCommitAdmitted: committed, providerCommitAcknowledged: committed,
    observedMigrationCount: observed.observedMigrationCount as 106 | 107, rowCount: observed.rowCount,
    dataSha256: observed.dataSha256, historicalSchemaSha256: observed.historicalSchemaSha256 });
  const run: typeof runAdoptedInventorySchemaUpgrade = async (database, migrations, configuration, command, admission) => {
    if (command !== 'upgrade') return ports.run(database, migrations, configuration, command, admission);
    if (mode === 'before-write') {
      // This controller reaches upgrade only after custody records write admission.
      const observed = await ports.run(database, migrations, configuration, 'inspect-settled');
      verifyAdoptedInventoryObservation(observed, 'inspect-settled');
      return checkpoint(observed);
    }
    if (mode === 'postcommit') {
      // The real native adapter completes COMMIT before returning this result.
      // Pause before the controller can record write_reply; recovery must inspect,
      // never repeat the write or infer rollback from the missing local receipt.
      const observed = await ports.run(database, migrations, configuration, command, admission);
      verifyAdoptedInventoryObservation(observed, 'upgrade');
      if (!observed.applied || observed.alreadyApplied) throw new AdoptedInventoryUpgradeError('verification_failed');
      return checkpoint(observed, true);
    }
    if (mode !== 'precommit') throw new AdoptedInventoryUpgradeError('boundary_refused');
    return ports.run({ transaction: work => database.transaction(async tx => {
      const result = await work(tx);
      // The real migration, exact ledger and preservation checks ran inside this
      // real transaction. The callback never returns, so COMMIT is impossible.
      if (!result || typeof result !== 'object') {
        throw new AdoptedInventoryUpgradeError('verification_failed');
      }
      const observed = result as unknown as AdoptedInventoryUpgradeResult;
      verifyAdoptedInventoryObservation(observed, 'upgrade');
      return checkpoint(observed);
    }) }, migrations, configuration, command, admission);
  };
  return ports.execute(mode === 'reconcile' ? ['reconcile', '--reconcile-fictional-adopted-inventory-upgrade']
    : ['upgrade', '--confirm-fictional-adopted-inventory-upgrade'], build, { ...dependencies, run });
}
