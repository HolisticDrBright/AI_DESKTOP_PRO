if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-schema-upgrade-operator is server-only');
import type { ClinicalCoreMigration } from './migrations';
import { AdoptedInventoryUpgradeError } from './adopted-plan-inventory-schema-upgrade';
import { executeAdoptedInventoryUpgradeCommand, type AdoptedInventoryUpgradeBuild } from './adopted-plan-inventory-upgrade-command';
import { createNativeInventoryUpgradeDependencies } from './adopted-plan-inventory-native-ports';

declare const __ADOPTED_INVENTORY_UPGRADE_BUILD__: AdoptedInventoryUpgradeBuild;
declare const __ADOPTED_INVENTORY_MIGRATIONS__: ClinicalCoreMigration[];
executeAdoptedInventoryUpgradeCommand(process.argv.slice(2), __ADOPTED_INVENTORY_UPGRADE_BUILD__,
  createNativeInventoryUpgradeDependencies(__filename, () => __ADOPTED_INVENTORY_MIGRATIONS__))
.then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error instanceof AdoptedInventoryUpgradeError ? `${error.category}${error.stage ? ':' + error.stage : ''}`
    : 'adopted_inventory_upgrade_operator_failed_inspect_same_target');
  process.exitCode = 1;
});
