import type { ClinicalCoreDatabase } from './database';
import type { InventoryOperatorFence } from './adopted-plan-inventory-custody-types';
import { AdoptedInventoryUpgradeError } from './adopted-plan-inventory-schema-upgrade';

const key = 'ai-desktop-pro:qualification-inventory-durable-operator';
/** Serializes this operator's native custody changes, including retirement of
 * an abandoned recovery guard. No clinical row is written by this fence. The
 * separate settlement inspections still acquire the actual migration locks. */
export async function withInventoryOperatorFence<T>(database: ClinicalCoreDatabase,
  work: (fence: InventoryOperatorFence) => Promise<T>): Promise<T> {
  return database.transaction(async tx => {
    await tx.query("set local lock_timeout='5s'");
    await tx.query("set local statement_timeout='30s'");
    const verify = async () => {
      if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== 'clinical_core_qualification'
        || (await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired', [key])).rows[0]?.acquired !== true) {
        throw new AdoptedInventoryUpgradeError('custody_refused', 'operator_fence');
      }
    };
    await verify(); return work({ verify });
  });
}
