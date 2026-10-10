import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive();
const productId = z.string().regex(/^prd_[a-z0-9][a-z0-9_-]{2,95}$/);
const labelId = z.string().regex(/^lbl_[a-z0-9][a-z0-9_-]{2,95}$/);
const ingredientKey = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,159}$/);
const sources = z.array(z.string().trim().min(1).max(2000)).min(1).max(100);

/** Only an explicit, source-verified FULL label mapping is an inventory.
 * Marketing highlights, free text and partial ingredient lists are not one.
 * This block lives inside the immutable, separately reviewed label crosscheck;
 * merely parsing it neither signs it nor releases a product. */
export const catalogIngredientReleaseSchema = z.object({
  contract: z.literal('catalog-ingredient-release/1'),
  productId, productVersion: version, productContentSha256: digest,
  labelId, labelVersion: version, labelPayloadSha256: digest,
  completeness: z.literal('complete'), sourceVerification: z.literal('V'),
  ingredientKeys: z.array(ingredientKey).min(1).max(40), sourceRefs: sources,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.ingredientKeys).size !== value.ingredientKeys.length
    || new Set(value.sourceRefs).size !== value.sourceRefs.length) {
    ctx.addIssue({ code: 'custom', message: 'ingredient_release_identity_duplicate' });
  }
});
export type CatalogIngredientRelease = z.infer<typeof catalogIngredientReleaseSchema>;

/** Production uses a product-version UUID, not staging's lbl_:version key. */
export const productionIngredientReleaseSchema = z.object({
  contract: z.literal('production-catalog-ingredient-release/1'), productId, productVersion: version,
  productContentSha256: digest, labelVersionId: z.string().uuid(), labelSha256: digest,
  completeness: z.literal('complete'), sourceVerification: z.literal('V'),
  ingredientKeys: z.array(ingredientKey).min(1).max(40), sourceRefs: sources,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.ingredientKeys).size !== value.ingredientKeys.length
    || new Set(value.sourceRefs).size !== value.sourceRefs.length) {
    ctx.addIssue({ code: 'custom', message: 'ingredient_release_identity_duplicate' });
  }
});
export type ProductionIngredientRelease = z.infer<typeof productionIngredientReleaseSchema>;

const plan = z.object({
  recordId: z.string().uuid(), revision: version, contentSha256: digest, consentRevision: version,
}).strict();
export const inventoryReasons = ['plan_not_adopted', 'plan_changed', 'consent_changed',
  'plan_shape_unknown', 'product_identity_missing', 'dose_unknown', 'ingredients_unverified',
  'peptide_inventory_unresolved'] as const;
export const adoptedPlanInventorySchema = z.object({
  contract: z.literal('adopted-plan-inventory/1'), ownerId: z.string().uuid(),
  asOf: z.string().datetime({ offset: true }), adoptedPlan: plan.nullable(), inventoryRevision: digest,
  coverage: z.literal('adopted_plan_only'), clinicalClearance: z.literal(false),
  inventoryComplete: z.boolean(), incompleteReason: z.enum(inventoryReasons).nullable(),
  products: z.array(z.object({
    itemId: z.string().min(1).max(160), productId, dose: z.string().trim().min(1).max(240),
    ingredientKeys: z.array(ingredientKey).min(1).max(40),
    productVersion: version, productContentSha256: digest,
    labelVersionId: z.string().uuid(), labelSha256: digest, ingredientReleaseSha256: digest,
  }).strict()).max(200),
  unresolved: z.array(z.object({ itemId: z.string().min(1).max(160), reason: z.enum(inventoryReasons) }).strict()).max(201),
}).strict().superRefine((value, ctx) => {
  if (value.inventoryComplete !== (value.adoptedPlan !== null && value.incompleteReason === null && value.unresolved.length === 0)
    || new Set(value.products.map(p => p.itemId)).size !== value.products.length
    || value.products.some(p => new Set(p.ingredientKeys).size !== p.ingredientKeys.length)
    || (value.incompleteReason === null) !== (value.unresolved.length === 0)
    || (value.unresolved.length > 0 && value.incompleteReason !== value.unresolved[0].reason)
    || new Set(value.unresolved.map(p => p.itemId)).size !== value.unresolved.length
    || value.products.some(p => value.unresolved.some(u => u.itemId === p.itemId))
    || (value.adoptedPlan === null && value.products.length > 0)) {
    ctx.addIssue({ code: 'custom', message: 'adopted_inventory_integrity_refused' });
  }
});
export type AdoptedPlanInventory = z.infer<typeof adoptedPlanInventorySchema>;
