if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-interruption-worker is server-only');
import type { ClinicalCoreMigration } from './migrations';
import { executeAdoptedInventoryUpgradeCommand, type AdoptedInventoryUpgradeBuild } from './adopted-plan-inventory-upgrade-command';
import { AdoptedInventoryUpgradeError, runAdoptedInventorySchemaUpgrade } from './adopted-plan-inventory-schema-upgrade';
import { createNativeInventoryUpgradeDependencies } from './adopted-plan-inventory-native-ports';
import { runInventoryInterruptionWorker } from './adopted-plan-inventory-interruption';
declare const __ADOPTED_INVENTORY_UPGRADE_BUILD__: AdoptedInventoryUpgradeBuild;
declare const __ADOPTED_INVENTORY_MIGRATIONS__: ClinicalCoreMigration[];

const dependencies = createNativeInventoryUpgradeDependencies(__filename, () => __ADOPTED_INVENTORY_MIGRATIONS__);
runInventoryInterruptionWorker(process.argv.slice(2), __ADOPTED_INVENTORY_UPGRADE_BUILD__, dependencies, {
  connected: () => process.connected === true && typeof process.send === 'function',
  checkpoint: packet => new Promise<never>((_resolve, reject) => {
    if (!process.send || !process.connected) return reject(new AdoptedInventoryUpgradeError('boundary_refused'));
    process.send(packet, error => { if (error) reject(new AdoptedInventoryUpgradeError('boundary_refused')); });
    // Deliberately never returns: the real adapter cannot issue CommitTransaction.
    // Parent kills only this exact child after observing the admitted checkpoint.
  }),
  run: runAdoptedInventorySchemaUpgrade,
  execute: executeAdoptedInventoryUpgradeCommand,
}).then(result => {
  if (process.send && process.connected) process.send({ kind: 'result', result }, () => process.disconnect());
  else process.exitCode = 1;
}).catch(error => {
  const category = error instanceof AdoptedInventoryUpgradeError ? error.category : 'interruption_worker_failed';
  const stage = error instanceof AdoptedInventoryUpgradeError ? error.stage : undefined;
  if (process.send && process.connected) process.send({ kind: 'refused', category, ...(stage ? { stage } : {}) }, () => process.disconnect());
  process.exitCode = 1;
});
