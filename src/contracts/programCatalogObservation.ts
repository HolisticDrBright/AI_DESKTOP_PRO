import { z } from 'zod';
import { PROGRAM_CATALOG_TARGETS, programProductCatalogBinding } from './programAssignments';

/**
 * `program-catalog-observation/2`: what the Program Studio reads of the governed catalog when a
 * practitioner binds a supplement step to a product. Synthetic qualification retains the original
 * catalog API; production must use the distinct, exact-label reference contract.
 *
 * An observation is a reference-only read bound to the clinic whose workforce session made it,
 * the service target the catalog API reported, and the draft version the Studio asked for. It
 * carries product identity and the facts a practitioner needs to decide eligibility: never a
 * commercial offer, never the clinical payload, never a dose. Catalog eligibility is not purchase
 * availability or clinical approval; both stay where they are decided.
 */
export const PROGRAM_CATALOG_OBSERVATION_CONTRACT = 'program-catalog-observation/2' as const;
export const GOVERNED_CATALOG_API_CONTRACT = 'governed-catalog-api/1' as const;
export const PRODUCTION_CATALOG_REFERENCE_API_CONTRACT = 'production-catalog-reference-api/1' as const;

const stableId = z.string().regex(/^prd_[a-z0-9][a-z0-9_-]{2,95}$/);
const version = z.number().int().min(1).max(1_000_000);

/** One product page as the governed catalog API returns it. Fields the Studio does not use are allowed and dropped. */
export const governedCatalogProductPage = z.object({
  contractVersion: z.literal(GOVERNED_CATALOG_API_CONTRACT),
  environment: z.enum(PROGRAM_CATALOG_TARGETS),
  dataClassification: z.literal('reference_only'),
  phiAllowed: z.literal(false),
  realPatientDataAllowed: z.literal(false),
  data: z.object({
    products: z.array(z.object({
      stableId,
      version,
      displayName: z.string().trim().min(1).max(240),
      productType: z.enum(['supplement', 'oral_peptide', 'practitioner_only', 'injectable_peptide']),
      accessTier: z.enum(['open', 'practitioner_gated', 'injectable']),
      declaredRestricted: z.boolean(),
      directOrderAllowed: z.boolean(),
      reviewStatus: z.literal('approved'),
      label: z.object({ stableId: z.string().min(1).max(120), version, reviewStatus: z.literal('approved') }).passthrough().optional(),
    }).passthrough()).max(100),
    nextCursor: z.string().regex(/^prd_[a-z0-9][a-z0-9_-]{2,95}$/).optional(),
  }).passthrough(),
}).passthrough();
export type GovernedCatalogProductPage = z.infer<typeof governedCatalogProductPage>;

/** Exact production reference page. It contains no commercial destination or inferred dose. */
export const productionCatalogReferencePage = z.object({
  contractVersion: z.literal(PRODUCTION_CATALOG_REFERENCE_API_CONTRACT),
  environment: z.literal('production-clinical'),
  dataClassification: z.literal('reference_only'),
  phiAllowed: z.literal(false),
  realPatientDataAllowed: z.literal(false),
  data: z.object({
    contractVersion: z.literal('production-catalog-reference/1'),
    audience: z.literal('workforce'),
    products: z.array(z.object({
      productId: stableId,
      productVersion: version,
      displayName: z.string().trim().min(1).max(200),
      brand: z.string().max(200).nullable(),
      productType: z.enum(['supplement', 'oral_peptide', 'practitioner_only', 'injectable_peptide', 'other']),
      accessTier: z.enum(['open', 'practitioner_gated', 'injectable', 'blocked']),
      declaredRestricted: z.boolean(),
      declaredDirectOrderAllowed: z.boolean(),
      labelVersionId: z.string().uuid(),
      labelSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      productContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
      sourceRefs: z.array(z.string().trim().min(1).max(4000)).min(1).max(100),
      importManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      sourceVerified: z.boolean(),
    }).strict()).max(100),
    nextCursor: stableId.nullable(),
  }).strict().superRefine((value, ctx) => {
    if (value.products.some((product) => (product.sourceVerified && product.labelSha256 === null)
      || new Set(product.sourceRefs).size !== product.sourceRefs.length)
      || value.products.some((product, index) => index > 0 && product.productId <= value.products[index - 1]!.productId)
      || (value.nextCursor !== null && value.nextCursor !== value.products.at(-1)?.productId)) {
      ctx.addIssue({ code: 'custom', message: 'production_catalog_reference_invalid' });
    }
  }),
}).strict();

/** A product as the picker shows it: identity, the observed release, and the declared facts that decide a hold. */
export const observedCatalogProduct = z.object({
  stableId,
  version,
  displayName: z.string().trim().min(1).max(240),
  productType: z.enum(['supplement', 'oral_peptide', 'practitioner_only', 'injectable_peptide', 'other']),
  accessTier: z.enum(['open', 'practitioner_gated', 'injectable', 'blocked']),
  declaredRestricted: z.boolean(),
  directOrderAllowed: z.boolean(),
  /** The approved label release the catalog reports for this product, or null when none is observed. */
  labelVersion: version.nullable(),
  /** Production uses the real label-version UUID; no legacy label number is invented. */
  labelVersionId: z.string().uuid().nullable().optional(),
  sourceVerified: z.boolean().optional(),
}).strict();
export type ObservedCatalogProduct = z.infer<typeof observedCatalogProduct>;

export const programCatalogObservationRequest = z.object({
  /** The draft version the practitioner is editing; echoed so a reply for another draft is recognisable. */
  versionId: z.string().uuid(),
  /** Narrows the observed catalog by display name or stable id. Empty reads the whole bounded catalog. */
  query: z.string().max(120).default(''),
}).strict();
export type ProgramCatalogObservationRequest = z.infer<typeof programCatalogObservationRequest>;

export const programCatalogObservation = z.object({
  contractVersion: z.literal(PROGRAM_CATALOG_OBSERVATION_CONTRACT),
  /** The clinic whose workforce session made the read. */
  clinic: z.string().min(1).max(128),
  /** The draft version the read was made for. */
  versionId: z.string().uuid(),
  /** The service target the catalog API reported for every page of this read. */
  target: z.enum(PROGRAM_CATALOG_TARGETS),
  observedAt: z.string().datetime(),
  query: z.string().max(120),
  /** Products matching the query, in catalog order. Empty with `complete: true` means no match, not an outage. */
  products: z.array(observedCatalogProduct).max(1000),
  /** How many products the catalog returned before narrowing. */
  catalogSize: z.number().int().min(0),
  /** False when the catalog had more pages than the reader is allowed to follow; the list is then a prefix. */
  complete: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.target === 'production-clinical' && value.products.some(product =>
    product.labelVersion !== null || !product.labelVersionId || product.sourceVerified === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'production_catalog_source_identity_required' });
  }
});
export type ProgramCatalogObservation = z.infer<typeof programCatalogObservation>;

/** The binding a selection records. Identical to the shared program contract's binding; re-exported so a picker depends on one name. */
export const programCatalogSelection = programProductCatalogBinding;

/**
 * Why a product observed in the catalog may still not be bound by a patient-facing supplement step.
 * Each reason is a declared catalog value, never an inference from the product's name. A held product
 * stays visible so the practitioner can see it was observed and why it is not offered.
 */
export type CatalogHoldReason = 'declared_restricted' | 'not_direct_order' | 'access_tier' | 'no_approved_label' | 'source_unverified' | 'unsupported_product_type';
export function catalogHold(product: ObservedCatalogProduct, target: ProgramCatalogObservation['target'] = 'synthetic-staging'): CatalogHoldReason | null {
  if (product.declaredRestricted) return 'declared_restricted';
  if (product.accessTier !== 'open') return 'access_tier';
  if (product.productType !== 'supplement') return 'unsupported_product_type';
  if (!product.directOrderAllowed) return 'not_direct_order';
  if (target === 'production-clinical' && !product.sourceVerified) return 'source_unverified';
  if (target === 'production-clinical' ? !product.labelVersionId : product.labelVersion === null) return 'no_approved_label';
  return null;
}
export const CATALOG_HOLD_WORDS: Record<CatalogHoldReason, string> = {
  declared_restricted: 'declared restricted by the catalog; add-ons of this kind are held',
  access_tier: 'not an open-access product; a patient cannot order it directly',
  not_direct_order: 'the catalog does not allow direct ordering',
  no_approved_label: 'no approved label is observed, so no dose can be copied from one',
  source_unverified: 'the exact label and ingredient sources are not verified for this release',
  unsupported_product_type: 'not a supplement product for this step',
};
