if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog is server-only.");
}

import { createHash } from "node:crypto";
import { clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";

export const GOVERNED_CATALOG_CONTRACT = "governed-catalog-seed/1" as const;

export type CatalogProductType = "supplement" | "oral_peptide" | "practitioner_only" | "injectable_peptide";
export type CatalogAccessTier = "open" | "practitioner_gated" | "injectable";

export type CatalogProductSeed = {
  stableId: string;
  version: number;
  displayName: string;
  productType: CatalogProductType;
  accessTier: CatalogAccessTier;
  declaredRestricted: boolean;
  directOrderAllowed: boolean;
  clinicalPayload: Record<string, unknown>;
  sourceRefs: string[];
  contentSha256: string;
};

export type CatalogProductLabelSeed = {
  stableId: string;
  version: number;
  productStableId: string;
  labelFound: boolean;
  physicalLabelRequired: boolean;
  substantiveConflict: boolean;
  practitionerDecisionRequired: boolean;
  labelPayload: Record<string, unknown>;
  crosscheckPayload: Record<string, unknown>;
  sourceRefs: string[];
  contentSha256: string;
};

export type CommercialOfferSeed = {
  stableId: string;
  version: number;
  productStableId: string;
  destinationUrl: string;
  trackingMetadata: Record<string, unknown>;
  declaredRestricted: boolean;
  directOrderAllowed: boolean;
  contentSha256: string;
};

export type ProtocolTemplateItemSeed = {
  position: number;
  productStableId: string;
  instructions?: string;
  dosageText?: string;
  doseSourceRef?: string;
  monitoringRequirements: string[];
  stoppingRules: string[];
  contraindications: string[];
};

export type ProtocolStepSeed = {
  stableId: string;
  sequence: number;
  phase: string;
  instructions: string;
  prerequisites: string;
  monitoring: string;
  stopCriteria: string;
  conditionalLogic: string;
  adjustmentLogic?: string;
  duration?: string;
  timing?: string;
  interventionId?: string;
  productStableId?: string;
  sourceRefs: string[];
};

export type ProtocolTemplateSeed = {
  stableId: string;
  version: number;
  title: string;
  summary?: string;
  sourceRefs: string[];
  items: ProtocolTemplateItemSeed[];
  steps: ProtocolStepSeed[];
  contentSha256: string;
};

export type CatalogSafetyRuleSeed = {
  stableId: string;
  version: number;
  severity: string;
  blocksRecommendation: boolean;
  rulePayload: Record<string, unknown>;
  sourceRefs: string[];
  contentSha256: string;
};

export type CatalogKnowledgeSourceSeed = {
  stableId: string;
  version: number;
  citation: string;
  publisher?: string;
  evidenceLevel?: string;
  destinationUrl?: string;
  sourcePayload: Record<string, unknown>;
  sourceRefs: string[];
  contentSha256: string;
};

export type GovernedCatalogSeedManifest = {
  contractVersion: typeof GOVERNED_CATALOG_CONTRACT;
  sourcePackageId: string;
  sourcePackageVersion: number;
  targetEnvironment: "synthetic-staging" | "production-clinical";
  dataClassification: "reference_only";
  containsPhi: false;
  manifestSha256: string;
  products: CatalogProductSeed[];
  productLabels: CatalogProductLabelSeed[];
  commercialOffers: CommercialOfferSeed[];
  protocolTemplates: ProtocolTemplateSeed[];
  safetyRules: CatalogSafetyRuleSeed[];
  knowledgeSources: CatalogKnowledgeSourceSeed[];
};

export type CatalogImportResult = {
  batchId: string;
  manifestSha256: string;
  alreadyApplied: boolean;
  counts: {
    products: number;
    productLabels: number;
    commercialOffers: number;
    protocolTemplates: number;
    safetyRules: number;
    knowledgeSources: number;
  };
  reviewStatus: "needs_review";
};

export class GovernedCatalogError extends Error {
  constructor(readonly category:
    | "manifest_invalid"
    | "manifest_hash_mismatch"
    | "content_hash_mismatch"
    | "catalog_conflict"
    | "database_unavailable") {
    super(category);
    this.name = "GovernedCatalogError";
  }
}

const PRODUCT_ID = /^prd_[a-z0-9][a-z0-9_-]{2,95}$/;
const LABEL_ID = /^lbl_[a-z0-9][a-z0-9_-]{2,95}$/;
const OFFER_ID = /^off_[a-z0-9][a-z0-9_-]{2,95}$/;
const TEMPLATE_ID = /^tpl_[a-z0-9][a-z0-9_-]{2,95}$/;
const STEP_ID = /^stp_[a-z0-9][a-z0-9_-]{2,95}$/;
const SAFETY_RULE_ID = /^saf_[a-z0-9][a-z0-9_-]{2,95}$/;
const KNOWLEDGE_SOURCE_ID = /^src_[a-z0-9][a-z0-9_-]{2,95}$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_CLINICAL_KEYS = new Set([
  "affiliateurl", "affiliateurls", "destinationurl", "discountcode", "trackingcode",
  "email", "phone", "dateofbirth", "dob", "patientid", "personid", "fullname",
]);
const MAX_RECORDS = 5_000;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  throw new GovernedCatalogError("manifest_invalid");
}

export function catalogSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function productContentForHash(product: Omit<CatalogProductSeed, "contentSha256">): unknown {
  return product;
}

export function productLabelContentForHash(label: Omit<CatalogProductLabelSeed, "contentSha256">): unknown {
  return label;
}

export function offerContentForHash(offer: Omit<CommercialOfferSeed, "contentSha256">): unknown {
  return offer;
}

export function templateContentForHash(template: Omit<ProtocolTemplateSeed, "contentSha256">): unknown {
  return template;
}

export function safetyRuleContentForHash(rule: Omit<CatalogSafetyRuleSeed, "contentSha256">): unknown {
  return rule;
}

export function knowledgeSourceContentForHash(source: Omit<CatalogKnowledgeSourceSeed, "contentSha256">): unknown {
  return source;
}

export function manifestContentForHash(manifest: Omit<GovernedCatalogSeedManifest, "manifestSha256">): unknown {
  return manifest;
}

export function validateGovernedCatalogManifest(input: unknown): GovernedCatalogSeedManifest {
  if (!isRecord(input)) invalid();
  const manifest = input as unknown as GovernedCatalogSeedManifest;
  if (
    manifest.contractVersion !== GOVERNED_CATALOG_CONTRACT
    || !boundedString(manifest.sourcePackageId, PACKAGE_ID, 128)
    || !positiveInteger(manifest.sourcePackageVersion)
    || !["synthetic-staging", "production-clinical"].includes(manifest.targetEnvironment)
    || manifest.dataClassification !== "reference_only"
    || manifest.containsPhi !== false
    || !boundedArray(manifest.products)
    || !boundedArray(manifest.productLabels)
    || !boundedArray(manifest.commercialOffers)
    || !boundedArray(manifest.protocolTemplates)
    || !boundedArray(manifest.safetyRules)
    || !boundedArray(manifest.knowledgeSources)
    || !SHA256.test(manifest.manifestSha256)
  ) invalid();

  const productKeys = new Set<string>();
  const productIds = new Set<string>();
  for (const product of manifest.products) {
    if (!isRecord(product)) invalid();
    const key = `${product.stableId}:${product.version}`;
    if (
      !boundedString(product.stableId, PRODUCT_ID, 100)
      || !positiveInteger(product.version)
      || !boundedString(product.displayName, undefined, 200)
      || !["supplement", "oral_peptide", "practitioner_only", "injectable_peptide"].includes(product.productType)
      || !["open", "practitioner_gated", "injectable"].includes(product.accessTier)
      || typeof product.declaredRestricted !== "boolean"
      || typeof product.directOrderAllowed !== "boolean"
      || !isRecord(product.clinicalPayload)
      || !sourceRefsValid(product.sourceRefs)
      || !SHA256.test(product.contentSha256)
      || productKeys.has(key)
      || hasForbiddenKey(product.clinicalPayload)
    ) invalid();
    if (product.declaredRestricted && (product.directOrderAllowed || product.accessTier === "open")) invalid();
    if (product.accessTier === "injectable" && (product.productType !== "injectable_peptide" || product.directOrderAllowed)) invalid();
    if (product.productType === "injectable_peptide" && product.accessTier !== "injectable") invalid();
    if (catalogSha256(productContentForHash(withoutHash(product))) !== product.contentSha256) {
      throw new GovernedCatalogError("content_hash_mismatch");
    }
    productKeys.add(key);
    productIds.add(product.stableId);
  }

  const labelKeys = new Set<string>();
  const labeledProducts = new Set<string>();
  for (const label of manifest.productLabels) {
    if (!isRecord(label)) invalid();
    const key = `${label.stableId}:${label.version}`;
    if (!boundedString(label.stableId, LABEL_ID, 100)
      || !positiveInteger(label.version)
      || !productIds.has(label.productStableId)
      || labeledProducts.has(label.productStableId)
      || typeof label.labelFound !== "boolean"
      || typeof label.physicalLabelRequired !== "boolean"
      || typeof label.substantiveConflict !== "boolean"
      || typeof label.practitionerDecisionRequired !== "boolean"
      || !isRecord(label.labelPayload)
      || !isRecord(label.crosscheckPayload)
      || hasForbiddenKey(label.labelPayload)
      || hasForbiddenKey(label.crosscheckPayload)
      || !sourceRefsValid(label.sourceRefs)
      || !SHA256.test(label.contentSha256)
      || labelKeys.has(key)) invalid();
    if (catalogSha256(productLabelContentForHash(withoutHash(label))) !== label.contentSha256) {
      throw new GovernedCatalogError("content_hash_mismatch");
    }
    labelKeys.add(key);
    labeledProducts.add(label.productStableId);
  }

  const offerKeys = new Set<string>();
  for (const offer of manifest.commercialOffers) {
    if (!isRecord(offer)) invalid();
    const key = `${offer.stableId}:${offer.version}`;
    if (
      !boundedString(offer.stableId, OFFER_ID, 100)
      || !positiveInteger(offer.version)
      || !productIds.has(offer.productStableId)
      || !safeHttpsUrl(offer.destinationUrl)
      || !isRecord(offer.trackingMetadata)
      || hasForbiddenKey(offer.trackingMetadata, new Set(["email", "phone", "patientid", "personid", "fullname"]))
      || typeof offer.declaredRestricted !== "boolean"
      || typeof offer.directOrderAllowed !== "boolean"
      || !SHA256.test(offer.contentSha256)
      || offerKeys.has(key)
    ) invalid();
    const product = manifest.products.find((candidate) => candidate.stableId === offer.productStableId)!;
    if (offer.declaredRestricted !== product.declaredRestricted) invalid();
    if (offer.declaredRestricted && offer.directOrderAllowed) invalid();
    if (offer.directOrderAllowed && !product.directOrderAllowed) invalid();
    if (catalogSha256(offerContentForHash(withoutHash(offer))) !== offer.contentSha256) {
      throw new GovernedCatalogError("content_hash_mismatch");
    }
    offerKeys.add(key);
  }

  const templateKeys = new Set<string>();
  for (const template of manifest.protocolTemplates) {
    if (!isRecord(template)) invalid();
    const key = `${template.stableId}:${template.version}`;
    if (
      !boundedString(template.stableId, TEMPLATE_ID, 100)
      || !positiveInteger(template.version)
      || !boundedString(template.title, undefined, 200)
      || (template.summary !== undefined && !boundedString(template.summary, undefined, 4_000))
      || !sourceRefsValid(template.sourceRefs)
      || !boundedArray(template.items)
      || !SHA256.test(template.contentSha256)
      || templateKeys.has(key)
    ) invalid();
    const positions = new Set<number>();
    for (const item of template.items) {
      if (
        !isRecord(item)
        || !positiveInteger(item.position)
        || positions.has(item.position)
        || !productIds.has(item.productStableId)
        || !optionalText(item.instructions, 4_000)
        || !optionalText(item.dosageText, 1_000)
        || !optionalText(item.doseSourceRef, 1_000)
        || !stringArray(item.monitoringRequirements, 100, 1_000)
        || !stringArray(item.stoppingRules, 100, 1_000)
        || !stringArray(item.contraindications, 100, 1_000)
        || (item.dosageText?.trim() && !item.doseSourceRef?.trim())
      ) invalid();
      positions.add(item.position);
    }
    if (!boundedArray(template.steps)) invalid();
    const stepIds = new Set<string>();
    const sequences = new Set<number>();
    for (const step of template.steps) {
      if (!isRecord(step)
        || !boundedString(step.stableId, STEP_ID, 100)
        || stepIds.has(step.stableId)
        || !positiveInteger(step.sequence)
        || sequences.has(step.sequence)
        || !boundedString(step.phase, undefined, 100)
        || !boundedString(step.instructions, undefined, 8_000)
        || !boundedString(step.prerequisites, undefined, 4_000)
        || !boundedString(step.monitoring, undefined, 4_000)
        || !boundedString(step.stopCriteria, undefined, 4_000)
        || !boundedString(step.conditionalLogic, undefined, 4_000)
        || !optionalText(step.adjustmentLogic, 4_000)
        || !optionalText(step.duration, 1_000)
        || !optionalText(step.timing, 1_000)
        || !optionalText(step.interventionId, 200)
        || (step.productStableId !== undefined && !productIds.has(step.productStableId))
        || !sourceRefsValid(step.sourceRefs)) invalid();
      stepIds.add(step.stableId);
      sequences.add(step.sequence);
    }
    if (catalogSha256(templateContentForHash(withoutHash(template))) !== template.contentSha256) {
      throw new GovernedCatalogError("content_hash_mismatch");
    }
    templateKeys.add(key);
  }

  const safetyRuleKeys = new Set<string>();
  for (const rule of manifest.safetyRules) {
    if (!isRecord(rule)) invalid();
    const key = `${rule.stableId}:${rule.version}`;
    if (
      !boundedString(rule.stableId, SAFETY_RULE_ID, 100)
      || !positiveInteger(rule.version)
      || !boundedString(rule.severity, undefined, 100)
      || typeof rule.blocksRecommendation !== "boolean"
      || !isRecord(rule.rulePayload)
      || hasForbiddenKey(rule.rulePayload)
      || !sourceRefsValid(rule.sourceRefs)
      || !SHA256.test(rule.contentSha256)
      || safetyRuleKeys.has(key)
    ) invalid();
    if (catalogSha256(safetyRuleContentForHash(withoutHash(rule))) !== rule.contentSha256) {
      throw new GovernedCatalogError("content_hash_mismatch");
    }
    safetyRuleKeys.add(key);
  }

  const knowledgeSourceKeys = new Set<string>();
  for (const source of manifest.knowledgeSources) {
    if (!isRecord(source)) invalid();
    const key = `${source.stableId}:${source.version}`;
    if (
      !boundedString(source.stableId, KNOWLEDGE_SOURCE_ID, 100)
      || !positiveInteger(source.version)
      || !boundedString(source.citation, undefined, 4_000)
      || !optionalText(source.publisher, 500)
      || !optionalText(source.evidenceLevel, 100)
      || (source.destinationUrl !== undefined && !safeHttpsUrl(source.destinationUrl))
      || !isRecord(source.sourcePayload)
      || hasForbiddenKey(source.sourcePayload)
      || !sourceRefsValid(source.sourceRefs)
      || !SHA256.test(source.contentSha256)
      || knowledgeSourceKeys.has(key)
    ) invalid();
    if (catalogSha256(knowledgeSourceContentForHash(withoutHash(source))) !== source.contentSha256) {
      throw new GovernedCatalogError("content_hash_mismatch");
    }
    knowledgeSourceKeys.add(key);
  }

  const computedManifest = catalogSha256(manifestContentForHash(withoutHash(manifest)));
  if (computedManifest !== manifest.manifestSha256) throw new GovernedCatalogError("manifest_hash_mismatch");
  return manifest;
}

export async function importGovernedCatalog(
  database: ClinicalCoreDatabase,
  input: unknown,
): Promise<CatalogImportResult> {
  const manifest = validateGovernedCatalogManifest(input);
  const counts = {
    products: manifest.products.length,
    productLabels: manifest.productLabels.length,
    commercialOffers: manifest.commercialOffers.length,
    protocolTemplates: manifest.protocolTemplates.length,
    safetyRules: manifest.safetyRules.length,
    knowledgeSources: manifest.knowledgeSources.length,
  };
  try {
    return await database.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`governed-catalog:${manifest.manifestSha256}`]);
      const existing = await tx.query<BatchRow>(
        `select id, manifest_sha256, product_count, product_label_count, commercial_offer_count, protocol_template_count,
                safety_rule_count, knowledge_source_count, status
         from clinical_reference.catalog_import_batches where manifest_sha256 = $1`,
        [manifest.manifestSha256],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.status !== "succeeded"
          || Number(row.product_count) !== counts.products
          || Number(row.product_label_count) !== counts.productLabels
          || Number(row.commercial_offer_count) !== counts.commercialOffers
          || Number(row.protocol_template_count) !== counts.protocolTemplates
          || Number(row.safety_rule_count) !== counts.safetyRules
          || Number(row.knowledge_source_count) !== counts.knowledgeSources
        ) throw new GovernedCatalogError("catalog_conflict");
        return result(row.id, manifest.manifestSha256, true, counts);
      }

      const batch = await tx.query<{ id: string }>(
        `insert into clinical_reference.catalog_import_batches
          (contract_version, source_package_id, source_package_version, environment,
           data_classification, contains_phi, manifest_sha256,
           product_count, product_label_count, commercial_offer_count, protocol_template_count,
           safety_rule_count, knowledge_source_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [manifest.contractVersion, manifest.sourcePackageId, manifest.sourcePackageVersion,
          manifest.targetEnvironment, manifest.dataClassification, manifest.containsPhi,
          manifest.manifestSha256, counts.products, counts.productLabels, counts.commercialOffers, counts.protocolTemplates,
          counts.safetyRules, counts.knowledgeSources],
      );
      const batchId = batch.rows[0]?.id;
      if (!batchId) throw new GovernedCatalogError("database_unavailable");

      for (const product of manifest.products) await importProduct(tx, batchId, manifest.targetEnvironment, product);
      for (const label of manifest.productLabels) await importProductLabel(tx, batchId, manifest.targetEnvironment, label);
      for (const offer of manifest.commercialOffers) await importOffer(tx, batchId, manifest.targetEnvironment, offer);
      for (const template of manifest.protocolTemplates) await importTemplate(tx, batchId, manifest.targetEnvironment, template);
      for (const rule of manifest.safetyRules) await importSafetyRule(tx, batchId, manifest.targetEnvironment, rule);
      for (const source of manifest.knowledgeSources) await importKnowledgeSource(tx, batchId, manifest.targetEnvironment, source);

      await tx.query(
        `update clinical_reference.catalog_import_batches
         set status = 'succeeded', completed_at = clock_timestamp()
         where id = $1 and status = 'importing'`,
        [clinicalUuid(batchId)],
      );
      return result(batchId, manifest.manifestSha256, false, counts);
    });
  } catch (error) {
    if (error instanceof GovernedCatalogError) throw error;
    throw new GovernedCatalogError("database_unavailable");
  }
}

type BatchRow = {
  id: string;
  manifest_sha256: string;
  product_count: number;
  product_label_count: number;
  commercial_offer_count: number;
  protocol_template_count: number;
  safety_rule_count: number;
  knowledge_source_count: number;
  status: string;
};

async function importProductLabel(
  tx: ClinicalCoreTransaction,
  batchId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
  label: CatalogProductLabelSeed,
) {
  await tx.query(
    `insert into clinical_reference.product_labels (stable_id, product_stable_id, environment)
     values ($1, $2, $3) on conflict (stable_id) do nothing`,
    [label.stableId, label.productStableId, environment],
  );
  await assertRegistryEnvironment(tx, "clinical_reference.product_labels", label.stableId, environment);
  await assertVersionCompatible(tx,
    `select content_sha256 from clinical_reference.product_label_versions
     where label_stable_id = $1 and version = $2`,
    [label.stableId, label.version], label.contentSha256);
  await tx.query(
    `insert into clinical_reference.product_label_versions
      (label_stable_id, version, label_found, physical_label_required, substantive_conflict,
       practitioner_decision_required, label_payload, crosscheck_payload, source_refs,
       content_sha256, review_status, import_batch_id)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 'needs_review', $11)
     on conflict (label_stable_id, version) do nothing`,
    [label.stableId, label.version, label.labelFound, label.physicalLabelRequired,
      label.substantiveConflict, label.practitionerDecisionRequired,
      JSON.stringify(label.labelPayload), JSON.stringify(label.crosscheckPayload),
      JSON.stringify(label.sourceRefs), label.contentSha256, clinicalUuid(batchId)],
  );
}

async function importProduct(
  tx: ClinicalCoreTransaction,
  batchId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
  product: CatalogProductSeed,
) {
  await tx.query(
    `insert into clinical_reference.catalog_products (stable_id, environment)
     values ($1, $2) on conflict (stable_id) do nothing`,
    [product.stableId, environment],
  );
  await assertRegistryEnvironment(tx, "clinical_reference.catalog_products", product.stableId, environment);
  await assertVersionCompatible(tx,
    `select content_sha256 from clinical_reference.catalog_product_versions
     where product_stable_id = $1 and version = $2`,
    [product.stableId, product.version], product.contentSha256);
  await tx.query(
    `insert into clinical_reference.catalog_product_versions
      (product_stable_id, version, display_name, product_type, access_tier,
       declared_restricted, direct_order_allowed, content_sha256, clinical_payload,
       source_refs, review_status, import_batch_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'needs_review', $11)
     on conflict (product_stable_id, version) do nothing`,
    [product.stableId, product.version, product.displayName, product.productType, product.accessTier,
      product.declaredRestricted, product.directOrderAllowed, product.contentSha256,
      JSON.stringify(product.clinicalPayload), JSON.stringify(product.sourceRefs), clinicalUuid(batchId)],
  );
}

async function importOffer(
  tx: ClinicalCoreTransaction,
  batchId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
  offer: CommercialOfferSeed,
) {
  await tx.query(
    `insert into commercial_reference.affiliate_offers (stable_id)
     values ($1) on conflict (stable_id) do nothing`,
    [offer.stableId],
  );
  await assertVersionCompatible(tx,
    `select content_sha256 from commercial_reference.affiliate_offer_versions
     where offer_stable_id = $1 and version = $2`,
    [offer.stableId, offer.version], offer.contentSha256);
  await tx.query(
    `insert into commercial_reference.affiliate_offer_versions
      (offer_stable_id, version, product_stable_id, destination_url, tracking_metadata,
       declared_restricted, direct_order_allowed, content_sha256, review_status, environment, import_batch_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'needs_review', $9, $10)
     on conflict (offer_stable_id, version) do nothing`,
    [offer.stableId, offer.version, offer.productStableId, offer.destinationUrl,
      JSON.stringify(offer.trackingMetadata), offer.declaredRestricted, offer.directOrderAllowed,
      offer.contentSha256, environment, clinicalUuid(batchId)],
  );
}

async function importTemplate(
  tx: ClinicalCoreTransaction,
  batchId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
  template: ProtocolTemplateSeed,
) {
  await tx.query(
    `insert into clinical_reference.protocol_templates (stable_id, environment)
     values ($1, $2) on conflict (stable_id) do nothing`,
    [template.stableId, environment],
  );
  await assertRegistryEnvironment(tx, "clinical_reference.protocol_templates", template.stableId, environment);
  const exists = await assertVersionCompatible(tx,
    `select content_sha256 from clinical_reference.protocol_template_versions
     where template_stable_id = $1 and version = $2`,
    [template.stableId, template.version], template.contentSha256);
  if (exists) return;
  await tx.query(
    `insert into clinical_reference.protocol_template_versions
      (template_stable_id, version, title, summary, content_sha256, source_refs,
       review_status, import_batch_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, 'needs_review', $7)`,
    [template.stableId, template.version, template.title, template.summary ?? null,
      template.contentSha256, JSON.stringify(template.sourceRefs), clinicalUuid(batchId)],
  );
  for (const item of template.items) {
    await tx.query(
      `insert into clinical_reference.protocol_template_items
        (template_stable_id, template_version, position, product_stable_id, instructions,
         dosage_text, dose_source_ref, monitoring_requirements, stopping_rules, contraindications)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [template.stableId, template.version, item.position, item.productStableId,
        item.instructions ?? null, item.dosageText ?? null, item.doseSourceRef ?? null,
        JSON.stringify(item.monitoringRequirements), JSON.stringify(item.stoppingRules),
        JSON.stringify(item.contraindications)],
    );
  }
  for (const step of template.steps) {
    await tx.query(
      `insert into clinical_reference.protocol_template_steps
        (step_stable_id, template_stable_id, template_version, sequence, phase,
         instructions, prerequisites, monitoring, stop_criteria, conditional_logic,
         adjustment_logic, duration, timing, intervention_id, product_stable_id, source_refs)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
      [step.stableId, template.stableId, template.version, step.sequence, step.phase,
        step.instructions, step.prerequisites, step.monitoring, step.stopCriteria,
        step.conditionalLogic, step.adjustmentLogic ?? null, step.duration ?? null,
        step.timing ?? null, step.interventionId ?? null, step.productStableId ?? null,
        JSON.stringify(step.sourceRefs)],
    );
  }
}

async function importSafetyRule(
  tx: ClinicalCoreTransaction,
  batchId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
  rule: CatalogSafetyRuleSeed,
) {
  await tx.query(
    `insert into clinical_reference.safety_rules (stable_id, environment)
     values ($1, $2) on conflict (stable_id) do nothing`,
    [rule.stableId, environment],
  );
  await assertRegistryEnvironment(tx, "clinical_reference.safety_rules", rule.stableId, environment);
  await assertVersionCompatible(tx,
    `select content_sha256 from clinical_reference.safety_rule_versions
     where rule_stable_id = $1 and version = $2`,
    [rule.stableId, rule.version], rule.contentSha256);
  await tx.query(
    `insert into clinical_reference.safety_rule_versions
      (rule_stable_id, version, severity, blocks_recommendation, rule_payload,
       source_refs, content_sha256, review_status, import_batch_id)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'needs_review', $8)
     on conflict (rule_stable_id, version) do nothing`,
    [rule.stableId, rule.version, rule.severity, rule.blocksRecommendation,
      JSON.stringify(rule.rulePayload), JSON.stringify(rule.sourceRefs), rule.contentSha256,
      clinicalUuid(batchId)],
  );
}

async function importKnowledgeSource(
  tx: ClinicalCoreTransaction,
  batchId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
  source: CatalogKnowledgeSourceSeed,
) {
  await tx.query(
    `insert into clinical_reference.knowledge_sources (stable_id, environment)
     values ($1, $2) on conflict (stable_id) do nothing`,
    [source.stableId, environment],
  );
  await assertRegistryEnvironment(tx, "clinical_reference.knowledge_sources", source.stableId, environment);
  await assertVersionCompatible(tx,
    `select content_sha256 from clinical_reference.knowledge_source_versions
     where source_stable_id = $1 and version = $2`,
    [source.stableId, source.version], source.contentSha256);
  await tx.query(
    `insert into clinical_reference.knowledge_source_versions
      (source_stable_id, version, citation, publisher, evidence_level, destination_url,
       source_payload, source_refs, content_sha256, review_status, import_batch_id)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 'needs_review', $10)
     on conflict (source_stable_id, version) do nothing`,
    [source.stableId, source.version, source.citation, source.publisher ?? null,
      source.evidenceLevel ?? null, source.destinationUrl ?? null,
      JSON.stringify(source.sourcePayload), JSON.stringify(source.sourceRefs), source.contentSha256,
      clinicalUuid(batchId)],
  );
}

async function assertVersionCompatible(
  tx: ClinicalCoreTransaction,
  sql: string,
  parameters: readonly unknown[],
  expectedHash: string,
): Promise<boolean> {
  const existing = await tx.query<{ content_sha256: string }>(sql, parameters);
  const row = existing.rows[0];
  if (!row) return false;
  if (row.content_sha256 !== expectedHash) throw new GovernedCatalogError("catalog_conflict");
  return true;
}

async function assertRegistryEnvironment(
  tx: ClinicalCoreTransaction,
  table:
    | "clinical_reference.catalog_products"
    | "clinical_reference.product_labels"
    | "clinical_reference.protocol_templates"
    | "clinical_reference.safety_rules"
    | "clinical_reference.knowledge_sources",
  stableId: string,
  environment: GovernedCatalogSeedManifest["targetEnvironment"],
) {
  const existing = await tx.query<{ environment: string }>(
    `select environment from ${table} where stable_id = $1`,
    [stableId],
  );
  if (existing.rows[0]?.environment !== environment) throw new GovernedCatalogError("catalog_conflict");
}

function result(
  batchId: string,
  manifestSha256: string,
  alreadyApplied: boolean,
  counts: CatalogImportResult["counts"],
): CatalogImportResult {
  return { batchId, manifestSha256, alreadyApplied, counts, reviewStatus: "needs_review" };
}

function withoutHash<T extends { contentSha256?: string; manifestSha256?: string }>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "contentSha256" && key !== "manifestSha256"),
  ) as Omit<T, "contentSha256" | "manifestSha256">;
}

function invalid(): never {
  throw new GovernedCatalogError("manifest_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000;
}

function boundedString(value: unknown, pattern?: RegExp, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && (!pattern || pattern.test(value));
}

function boundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_RECORDS;
}

function sourceRefsValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every((item) => boundedString(item, undefined, 1_000));
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => boundedString(item, undefined, maxLength));
}

function safeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function hasForbiddenKey(value: unknown, forbidden = FORBIDDEN_CLINICAL_KEYS): boolean {
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, forbidden));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => forbidden.has(key.toLowerCase().replace(/[_-]/g, ""))
    || hasForbiddenKey(child, forbidden));
}
