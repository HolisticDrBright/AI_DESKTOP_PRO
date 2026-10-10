import { adoptedPlanInventorySchema, productionIngredientReleaseSchema, type AdoptedPlanInventory } from '@/contracts/adoptedPlanInventory';
import { createHash } from 'node:crypto';
import { canonicalJson } from './aws-governed-catalog';
import type { ClinicalCoreTransaction } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { ActivePlanState } from './owned-active-plan';
import { OwnedStorageError } from './owned-consumer-records';

type Run = <T>(context: ProductionClinicalRequestContext, work: (tx: ClinicalCoreTransaction) => Promise<T>) => Promise<T>;
type Product = AdoptedPlanInventory['products'][number];
type Reason = AdoptedPlanInventory['unresolved'][number]['reason'];
const sha = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function object(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

/** Snapshot, not adoption, clinical clearance or an all-medications claim.
 * SQL locks the owner and binds record/catalog in ONE statement. There is no
 * caller-selected owner, plan, catalog or completeness override. */
export function createOwnedPlanInventory(run: Run, parsePlan: (raw: unknown) => ActivePlanState) {
  return {
    async activePlanInventory(context: ProductionClinicalRequestContext): Promise<AdoptedPlanInventory> {
      return run(context, async tx => {
        const source = object((await tx.query<{ result: unknown }>('select clinical_core.get_owned_plan_inventory_source() as result')).rows[0]?.result);
        if (!source || source.ownerId !== context.actorPersonId || typeof source.asOf !== 'string') throw new OwnedStorageError('storage_unavailable');
        const current = parsePlan(source.state).current;
        const adoptedPlan = current ? { recordId: current.recordId, revision: current.revision,
          contentSha256: current.contentSha256, consentRevision: current.consentRevision } : null;
        const products: Product[] = [], unresolved: AdoptedPlanInventory['unresolved'] = [];
        const hold = (itemId: string, reason: Reason) => unresolved.push({ itemId, reason });
        const finish = () => {
          const basis = { ownerId: context.actorPersonId, adoptedPlan, products, unresolved };
          return adoptedPlanInventorySchema.parse({ ...basis, contract: 'adopted-plan-inventory/1', asOf: source.asOf,
            inventoryRevision: sha(basis), coverage: 'adopted_plan_only', clinicalClearance: false,
            inventoryComplete: adoptedPlan !== null && unresolved.length === 0, incompleteReason: unresolved[0]?.reason ?? null });
        };
        if (!current) { hold('plan', 'plan_not_adopted'); return finish(); }
        if (source.consentRevision !== current.consentRevision) { hold('plan', 'consent_changed'); return finish(); }
        const record = object(source.record), payload = object(record?.payload);
        if (!record || !payload || record.recordId !== current.recordId || record.revision !== current.revision
          || record.deleted !== false || sha(payload) !== current.contentSha256) { hold('plan', 'plan_changed'); return finish(); }
        if (payload.status !== 'active' || !Array.isArray(payload.supplements_json) || payload.supplements_json.length > 200
          || !Array.isArray(payload.peptides_json)) { hold('plan', 'plan_shape_unknown'); return finish(); }
        // Not selling peptides in Core does not mean an owner takes none.
        if (payload.peptides_json.length) hold('peptides', 'peptide_inventory_unresolved');
        if (!Array.isArray(source.catalog) || source.catalog.length > 200) throw new OwnedStorageError('storage_unavailable');
        const rows = new Map<string, Record<string, unknown>>();
        for (const raw of source.catalog) {
          const row = object(raw);
          if (!row || typeof row.productId !== 'string' || rows.has(row.productId)) throw new OwnedStorageError('storage_unavailable');
          rows.set(row.productId, row);
        }
        const ids = new Set<string>();
        for (const [index, raw] of payload.supplements_json.entries()) {
          const entry = object(raw);
          if (entry?.status === 'suggested') continue;
          if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 160
            || entry.status !== 'active' || ids.has(entry.id)) { hold(`item:${index}`, 'plan_shape_unknown'); continue; }
          const itemId = entry.id;
          ids.add(itemId);
          const identity = object(entry.governedProduct);
          if (!identity || typeof identity.productId !== 'string' || typeof identity.labelVersionId !== 'string') { hold(itemId, 'product_identity_missing'); continue; }
          if (typeof entry.dose !== 'string' || !entry.dose.trim() || entry.dose.length > 240) { hold(itemId, 'dose_unknown'); continue; }
          const row = rows.get(identity.productId), release = productionIngredientReleaseSchema.safeParse(object(row?.verificationNote));
          if (!row || !release.success || !Array.isArray(row.sourceRefs) || identity.labelVersionId !== row.labelVersionId
            || release.data.productId !== row.productId || release.data.productVersion !== row.productVersion
            || release.data.productContentSha256 !== row.productContentSha256 || release.data.labelVersionId !== row.labelVersionId
            || release.data.labelSha256 !== row.labelSha256 || release.data.sourceRefs.some(ref => !(row.sourceRefs as unknown[]).includes(ref))) {
            hold(itemId, 'ingredients_unverified'); continue;
          }
          products.push({ itemId, productId: release.data.productId, dose: entry.dose.trim(), ingredientKeys: [...release.data.ingredientKeys].sort(),
            productVersion: release.data.productVersion, productContentSha256: release.data.productContentSha256,
            labelVersionId: release.data.labelVersionId, labelSha256: release.data.labelSha256, ingredientReleaseSha256: sha(release.data) });
        }
        return finish();
      });
    },
  };
}
