if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-expanded-catalog-release is server-only.");
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOVERNED_CATALOG_CONTRACT,
  catalogSha256,
  manifestContentForHash,
  productContentForHash,
  validateGovernedCatalogManifest,
  type CatalogProductSeed,
  type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";
import { GovernedCatalogSourcePackageError, loadAndAdaptGovernedCatalogSourcePackage } from "./aws-governed-catalog-seed-adapter";

const SHA256 = /^[0-9a-f]{64}$/;
const ORDINARY_TYPES = new Set(["supplement", "medical_food", "protein_meal_replacement"]);
const AUTO_EXCLUDED = new Set(["oral_peptide", "bioregulator_peptide", "bundle", "protocol_kit", "topical", "other"]);

export function loadAndBuildExpandedCatalogRelease(options: {
  originalDirectory: string;
  originalManifestFileSha256: string;
  candidateDirectory: string;
  candidateManifestFileSha256: string;
  approvalFile: string;
  targetEnvironment: GovernedCatalogSeedManifest["targetEnvironment"];
}): GovernedCatalogSeedManifest {
  const original = loadAndAdaptGovernedCatalogSourcePackage({
    directory: options.originalDirectory,
    targetEnvironment: options.targetEnvironment,
    expectedManifestFileSha256: options.originalManifestFileSha256,
  });
  const candidateDirectory = resolve(options.candidateDirectory);
  const candidateManifestBytes = readFileSync(resolve(candidateDirectory, "manifest.json"));
  const candidateManifestFileSha256 = byteSha256(candidateManifestBytes);
  if (candidateManifestFileSha256 !== options.candidateManifestFileSha256) hashMismatch();
  const candidateManifest = json(candidateManifestBytes) as CandidateManifest;
  const productBytes = readFileSync(resolve(candidateDirectory, "products.json"));
  if (candidateManifest.files?.["products.json"]?.sha256 !== byteSha256(productBytes)) hashMismatch();
  const candidates = json(productBytes);
  if (!Array.isArray(candidates) || candidates.length !== 710 || candidateManifest.counts?.products !== 710) invalid();

  const approval = json(readFileSync(resolve(options.approvalFile))) as Approval;
  assertApproval(approval, candidateManifestFileSha256, byteSha256(productBytes));

  const originalByAuthoringId = new Map(original.products.flatMap((product) => {
    const authoringId = product.clinicalPayload.authoringId;
    return typeof authoringId === "string" ? [[authoringId, product.stableId] as const] : [];
  }));
  const originalProducts = original.products.map((product): CatalogProductSeed => {
    const base = {
      ...product,
      version: 3,
      directOrderAllowed: false,
      clinicalPayload: {
        ...product.clinicalPayload,
        selectionPriorityGroup: "original_primary",
        selectionPriorityRank: 0,
        autoSelectionEligible: product.productType === "supplement" && product.accessTier === "open"
          && Array.isArray(product.clinicalPayload.contraindicationRuleIds)
          && product.clinicalPayload.contraindicationRuleIds.length === 0,
        catalogOwnerDecision: "approved_for_governed_catalog_availability",
      },
    };
    const { contentSha256: _previousHash, ...content } = base;
    return { ...content, contentSha256: catalogSha256(productContentForHash(content)) };
  });
  const candidateProducts = candidates.map((value, index) => candidateProduct(value, index, {
    packageRef: `candidate-manifest-sha256:${candidateManifestFileSha256}`,
    productsRef: `candidate-products-sha256:${byteSha256(productBytes)}`,
    originalByAuthoringId,
  }));

  const base = {
    contractVersion: GOVERNED_CATALOG_CONTRACT,
    sourcePackageId: `ai-longevity-pro-v2-expanded-catalog.${candidateManifestFileSha256.slice(0, 16)}`,
    sourcePackageVersion: 2,
    targetEnvironment: options.targetEnvironment,
    dataClassification: "reference_only" as const,
    containsPhi: false as const,
    products: [...originalProducts, ...candidateProducts],
    productLabels: original.productLabels,
    // Catalog availability and commercial activation are separate decisions.
    // This release intentionally activates no destination or affiliate offer.
    commercialOffers: [],
    protocolTemplates: original.protocolTemplates,
    safetyRules: original.safetyRules,
    knowledgeSources: original.knowledgeSources,
  };
  return validateGovernedCatalogManifest({
    ...base,
    manifestSha256: catalogSha256(manifestContentForHash(base)),
  });
}

function candidateProduct(value: unknown, index: number, refs: {
  packageRef: string;
  productsRef: string;
  originalByAuthoringId: Map<string, string>;
}): CatalogProductSeed {
  if (!record(value) || !text(value.id) || !text(value.name) || !text(value.productType)
    || !text(value.suggestedAccess) || !text(value.reviewStatus)
    || !Array.isArray(value.appCategories) || !Array.isArray(value.keyIngredients)
    || !Array.isArray(value.labMarkers) || !Array.isArray(value.symptoms)
    || !Array.isArray(value.cautionFlags) || !Array.isArray(value.restrictions)
    || !value.appCategories.every(text) || !value.keyIngredients.every(text)
    || !value.labMarkers.every(text) || !value.symptoms.every(text)
    || !value.cautionFlags.every(text)) invalid();
  const productType = String(value.productType);
  if (!ORDINARY_TYPES.has(productType) && !AUTO_EXCLUDED.has(productType)) invalid();
  const ordinary = ORDINARY_TYPES.has(productType);
  const open = ordinary && value.suggestedAccess === "open";
  const stableId = normalizedId("prd", String(value.id));
  const duplicateAuthoringId = record(value.existingCatalog) && text(value.existingCatalog.duplicateOfId)
    ? value.existingCatalog.duplicateOfId
    : undefined;
  const duplicateOfOriginalStableId = duplicateAuthoringId
    ? refs.originalByAuthoringId.get(duplicateAuthoringId)
    : undefined;
  const tier = ["core", "situational", "niche"].includes(String(value.tier)) ? String(value.tier) : "niche";
  const base = {
    stableId,
    version: 1,
    displayName: String(value.name),
    productType: productType === "oral_peptide" ? "oral_peptide" as const
      : ordinary ? "supplement" as const : "practitioner_only" as const,
    accessTier: open ? "open" as const : "practitioner_gated" as const,
    declaredRestricted: !open,
    directOrderAllowed: false,
    clinicalPayload: compact({
      authoringId: value.id,
      brand: value.brand,
      bestFor: value.summary,
      catalogScope: value.catalogScope,
      eligibilityStatus: "catalog_owner_approved",
      form: value.form,
      ingredients: value.keyIngredients,
      restrictions: value.restrictions,
      contraindicationRuleIds: [],
      protocolTemplateIds: [],
      categories: value.appCategories,
      labMarkers: value.labMarkers,
      symptoms: value.symptoms,
      cautionFlags: value.cautionFlags,
      clinicalApplications: value.clinicalApplications,
      tier,
      suggestedAccess: value.suggestedAccess,
      selectionPriorityGroup: "expanded_secondary",
      selectionPriorityRank: tier === "core" ? 100 : tier === "situational" ? 200 : 300,
      autoSelectionEligible: open,
      duplicateOfOriginalStableId,
      catalogOwnerDecision: "approved_for_governed_catalog_availability",
    }),
    sourceRefs: [refs.packageRef, refs.productsRef, `candidate-row:${index + 1}`],
  };
  return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
}

function assertApproval(approval: Approval, manifestHash: string, productsHash: string) {
  if (approval.approvalVersion !== "1.0.0"
    || approval.decision !== "approved_for_governed_catalog_availability"
    || approval.candidateManifestFileSha256 !== manifestHash
    || approval.candidateProductsSha256 !== productsHash
    || approval.productCount !== 710
    || approval.allProductsApproved !== true
    || approval.selectionPolicy?.primary !== "original_governed_catalog"
    || approval.selectionPolicy?.secondary !== "expanded_710_product_catalog_for_uncovered_needs"
    || approval.boundaries?.approvalDoesNotAssertPatientSpecificAppropriateness !== true
    || approval.boundaries?.noAutomaticDose !== true
    || approval.boundaries?.noAutomaticHormoneOrMedicationChange !== true
    || approval.boundaries?.pregnancyOrNursingRequiresExplicitVerifiedSafety !== true
    || approval.boundaries?.medicationAllergyAndConditionScreeningRequired !== true
    || approval.boundaries?.commercialOffersRequireSeparateLabelAndDestinationApproval !== true) invalid();
}

type CandidateManifest = {
  counts?: { products?: number };
  files?: Record<string, { sha256?: string }>;
};
type Approval = {
  approvalVersion?: string;
  decision?: string;
  candidateManifestFileSha256?: string;
  candidateProductsSha256?: string;
  productCount?: number;
  allProductsApproved?: boolean;
  selectionPolicy?: { primary?: string; secondary?: string };
  boundaries?: Record<string, unknown>;
};

function normalizedId(prefix: string, source: string): string {
  const body = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const value = `${prefix}_${body}`;
  if (!/^[a-z]{3}_[a-z0-9][a-z0-9_-]{2,95}$/.test(value) || value.length > 100) invalid();
  return value;
}
function json(bytes: Buffer): unknown { try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); } }
function byteSha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function invalid(): never { throw new GovernedCatalogSourcePackageError("source_package_invalid"); }
function hashMismatch(): never { throw new GovernedCatalogSourcePackageError("source_package_hash_mismatch"); }
