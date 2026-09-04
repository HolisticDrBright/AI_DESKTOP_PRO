if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog-seed-adapter is server-only.");
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GOVERNED_CATALOG_CONTRACT,
  catalogSha256,
  knowledgeSourceContentForHash,
  manifestContentForHash,
  offerContentForHash,
  productLabelContentForHash,
  productContentForHash,
  safetyRuleContentForHash,
  templateContentForHash,
  validateGovernedCatalogManifest,
  type CatalogKnowledgeSourceSeed,
  type CatalogProductSeed,
  type CatalogProductLabelSeed,
  type CatalogSafetyRuleSeed,
  type CommercialOfferSeed,
  type GovernedCatalogSeedManifest,
  type ProtocolTemplateSeed,
} from "./aws-governed-catalog";

const SOURCE_FILES = [
  "products.json",
  "protocols.json",
  "protocol_steps.json",
  "safety_rules.json",
  "sources.json",
  "labels.json",
  "label_crosscheck.json",
] as const;
const SHA256 = /^[0-9a-f]{64}$/;

export class GovernedCatalogSourcePackageError extends Error {
  constructor(readonly category:
    | "source_package_invalid"
    | "source_package_hash_mismatch"
    | "source_package_reference_invalid") {
    super(category);
    this.name = "GovernedCatalogSourcePackageError";
  }
}

export function loadAndAdaptGovernedCatalogSourcePackage(options: {
  directory: string;
  targetEnvironment: GovernedCatalogSeedManifest["targetEnvironment"];
  expectedManifestFileSha256: string;
}): GovernedCatalogSeedManifest {
  if (!SHA256.test(options.expectedManifestFileSha256)) invalid();
  const directory = resolve(options.directory);
  const manifestBytes = readFileSync(resolve(directory, "manifest.json"));
  const manifestFileSha256 = byteSha256(manifestBytes);
  if (manifestFileSha256 !== options.expectedManifestFileSha256) {
    throw new GovernedCatalogSourcePackageError("source_package_hash_mismatch");
  }
  const sourceManifest = parseJson(manifestBytes) as SourceManifest;
  const files = Object.fromEntries(SOURCE_FILES.map((file) => {
    const bytes = readFileSync(resolve(directory, file));
    const expected = sourceManifest.files?.[file];
    if (!expected || !matchesPinnedTextHash(bytes, expected.sha256)) {
      throw new GovernedCatalogSourcePackageError("source_package_hash_mismatch");
    }
    const records = parseJson(bytes);
    if (recordCount(file, records) !== expected.records) invalid();
    return [file, records];
  })) as SourceFiles;
  return adaptGovernedCatalogSourcePackage({
    sourceManifest,
    manifestFileSha256,
    files,
    targetEnvironment: options.targetEnvironment,
  });
}

export function adaptGovernedCatalogSourcePackage(input: {
  sourceManifest: unknown;
  manifestFileSha256: string;
  files: SourceFiles;
  targetEnvironment: GovernedCatalogSeedManifest["targetEnvironment"];
}): GovernedCatalogSeedManifest {
  if (!isRecord(input.sourceManifest) || !SHA256.test(input.manifestFileSha256)
    || !["synthetic-staging", "production-clinical"].includes(input.targetEnvironment)) invalid();
  const sourceManifest = input.sourceManifest as SourceManifest;
  if (sourceManifest.package !== "ai-longevity-pro-v2-governed-catalog"
    || !["1.0.0", "1.1.0"].includes(sourceManifest.schemaVersion ?? "")) invalid();
  for (const file of SOURCE_FILES) {
    const expected = sourceManifest.files?.[file];
    if (!expected || !SHA256.test(expected.sha256) || !positiveInteger(expected.records)
      || recordCount(file, input.files[file]) !== expected.records) invalid();
  }

  const products = input.files["products.json"].map(asProduct);
  const protocols = input.files["protocols.json"].map(asProtocol);
  const protocolSteps = input.files["protocol_steps.json"].map(asProtocolStep);
  const rules = input.files["safety_rules.json"].map(asSafetyRule);
  const sources = input.files["sources.json"].map(asKnowledgeSource);
  const labels = input.files["labels.json"].map(asLabel);
  const crosscheck = asLabelCrosscheck(input.files["label_crosscheck.json"]);
  assertUnique(products.map((row) => row.id));
  assertUnique(protocols.map((row) => row.id));
  assertUnique(protocolSteps.map((row) => row.id));
  assertUnique(rules.map((row) => row.id));
  assertUnique(labels.map((row) => row.id));
  assertUnique(crosscheck.records.map((row) => row.id));
  const sourceGroups = groupBy(sources, (row) => row.code);
  for (const group of sourceGroups.values()) {
    const canonical = group[0]!;
    if (group.some((candidate) => candidate.citation !== canonical.citation
      || candidate.publisher !== canonical.publisher
      || candidate.evidenceLevel !== canonical.evidenceLevel
      || candidate.url !== canonical.url)) referenceInvalid();
  }

  const productIds = new Set(products.map((row) => row.id));
  const protocolIds = new Set(protocols.map((row) => row.id));
  const ruleIds = new Set(rules.map((row) => row.id));
  const packageRef = `package-manifest-sha256:${input.manifestFileSha256}`;
  for (const product of products) {
    if (product.duplicateOf && !productIds.has(product.duplicateOf)) referenceInvalid();
    if (product.protocolTemplateIds.some((id) => !protocolIds.has(id))) referenceInvalid();
    if (product.contraindicationRuleIds.some((id) => !ruleIds.has(id))) referenceInvalid();
    if (product.productType === "injectable" || (product.productType === "research_compound" && product.access === "open")) invalid();
    if (product.eligibilityStatus === "restricted" && (product.access !== "blocked" || product.affiliate)) invalid();
    if (product.access === "open" && !product.affiliate) invalid();
    if (product.affiliate && !safeHttpsUrl(product.affiliate.url)) invalid();
  }
  const labelIds = new Set(labels.map((row) => row.id));
  const crosscheckIds = new Set(crosscheck.records.map((row) => row.id));
  if (labelIds.size !== crosscheckIds.size
    || labels.some((row) => !productIds.has(row.id))
    || crosscheck.records.some((row) => !labelIds.has(row.id))) referenceInvalid();
  for (const step of protocolSteps) {
    if (!protocolIds.has(step.templateId) || (step.productId && !productIds.has(step.productId))) referenceInvalid();
  }
  const labelsById = new Map(labels.map((row) => [row.id, row]));
  const crosscheckById = new Map(crosscheck.records.map((row) => [row.id, row]));

  const adaptedProducts = products.map((source): CatalogProductSeed => {
    const stableId = productStableId(source.id);
    const restricted = source.access !== "open";
    const label = labelsById.get(source.id);
    const labelCrosscheck = crosscheckById.get(source.id);
    const labelReview = labelReviewState(label, labelCrosscheck);
    const base = {
      stableId,
      version: 1,
      displayName: source.name,
      productType: productType(source.productType),
      accessTier: restricted ? "practitioner_gated" as const : "open" as const,
      declaredRestricted: restricted,
      directOrderAllowed: !restricted && Boolean(source.affiliate),
      clinicalPayload: compactObject({
        authoringId: source.id,
        brand: source.brand,
        bestFor: source.bestFor,
        catalogScope: source.catalogScope,
        eligibilityStatus: source.eligibilityStatus,
        form: source.form,
        ingredients: source.ingredients,
        restrictions: source.restrictions,
        contraindicationRuleIds: source.contraindicationRuleIds.map(safetyRuleStableId),
        protocolTemplateIds: source.protocolTemplateIds.map(protocolStableId),
        duplicateOf: source.duplicateOf ? productStableId(source.duplicateOf) : undefined,
        normalizations: source.normalizations,
        sourceReviewStatus: source.reviewStatus,
        labelReview,
      }),
      sourceRefs: [packageRef, provenanceRef(source.provenance)],
    };
    return { ...base, contentSha256: catalogSha256(productContentForHash(base)) };
  });

  const commercialOffers = products.flatMap((source): CommercialOfferSeed[] => {
    if (!source.affiliate) return [];
    const restricted = source.access !== "open";
    const base = {
      stableId: offerStableId(source.id),
      version: 1,
      productStableId: productStableId(source.id),
      destinationUrl: source.affiliate.url,
      trackingMetadata: compactObject({
        code: source.affiliate.code,
        supplier: source.affiliate.supplier,
        destinationScope: source.affiliate.destinationScope,
        authoringProductId: source.id,
        affiliateSourceRef: affiliateProvenanceRef(source.provenance),
      }),
      declaredRestricted: restricted,
      directOrderAllowed: !restricted,
    };
    return [{ ...base, contentSha256: catalogSha256(offerContentForHash(base)) }];
  });

  const productLabels = labels.map((label): CatalogProductLabelSeed => {
    const labelCrosscheck = crosscheckById.get(label.id)!;
    const base = {
      stableId: productLabelStableId(label.id),
      version: 1,
      productStableId: productStableId(label.id),
      labelFound: label.labelFound,
      physicalLabelRequired: Boolean(label.phase9f?.physicalLabelRequired) || labelCrosscheck.physicalLabelRequired,
      substantiveConflict: labelCrosscheck.verdict === "substantive_conflict",
      practitionerDecisionRequired: Boolean(label.practitionerDecisionRequired),
      labelPayload: safeLabelEvidence(label),
      crosscheckPayload: labelCrosscheck,
      sourceRefs: [packageRef, `label-research:${label.phase9f?.prhId ?? labelCrosscheck.prhId ?? label.id}`],
    };
    return { ...base, contentSha256: catalogSha256(productLabelContentForHash(base)) };
  });

  const protocolTemplates = protocols.map((source): ProtocolTemplateSeed => {
    const linkedProducts = products
      .filter((product) => product.protocolTemplateIds.includes(source.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const base = {
      stableId: protocolStableId(source.id),
      version: positiveInteger(Number(source.version)) ? Number(source.version) : 1,
      title: source.name,
      summary: JSON.stringify({
        goal: source.goal,
        defaultDuration: source.defaultDuration,
        paradigm: source.paradigm,
        sourceReviewStatus: source.reviewStatus,
      }),
      sourceRefs: [packageRef, provenanceRef(source.provenance)],
      items: linkedProducts.map((product, index) => ({
        position: index + 1,
        productStableId: productStableId(product.id),
        monitoringRequirements: [],
        stoppingRules: [],
        contraindications: product.contraindicationRuleIds.map(safetyRuleStableId),
      })),
      steps: protocolSteps
        .filter((step) => step.templateId === source.id)
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))
        .map((step) => ({
          stableId: protocolStepStableId(step.id),
          sequence: Number(step.sequence),
          phase: step.phase,
          instructions: step.instructions,
          prerequisites: step.prerequisites,
          monitoring: step.monitoring,
          stopCriteria: step.stopCriteria,
          conditionalLogic: step.conditionalLogic,
          ...(step.adjustmentLogic ? { adjustmentLogic: step.adjustmentLogic } : {}),
          ...(step.duration ? { duration: step.duration } : {}),
          ...(step.timing ? { timing: step.timing } : {}),
          ...(step.interventionId ? { interventionId: step.interventionId } : {}),
          ...(step.productId ? { productStableId: productStableId(step.productId) } : {}),
          sourceRefs: [packageRef, provenanceRef(step.provenance)],
        })),
    };
    return { ...base, contentSha256: catalogSha256(templateContentForHash(base)) };
  });

  const safetyRules = rules.map((source): CatalogSafetyRuleSeed => {
    const base = {
      stableId: safetyRuleStableId(source.id),
      version: 1,
      severity: source.severity,
      blocksRecommendation: source.blocksRecommendation.toLowerCase() === "yes",
      rulePayload: {
        authoringId: source.id,
        category: source.category,
        appliesTo: source.appliesTo,
        expression: source.expression,
        action: source.action,
      },
      sourceRefs: [packageRef, provenanceRef(source.provenance)],
    };
    return { ...base, contentSha256: catalogSha256(safetyRuleContentForHash(base)) };
  });

  const knowledgeSources = [...sourceGroups.values()].map((group): CatalogKnowledgeSourceSeed => {
    const source = group[0]!;
    if (source.url && !safeHttpsUrl(source.url)) invalid();
    const base = {
      stableId: knowledgeSourceStableId(source.code),
      version: 1,
      citation: source.citation,
      publisher: source.publisher,
      evidenceLevel: source.evidenceLevel,
      ...(source.url ? { destinationUrl: source.url } : {}),
      sourcePayload: {
        authoringCode: source.code,
        reconciledDuplicateRows: group.map((candidate) => candidate.provenance.row),
      },
      sourceRefs: [packageRef, ...group.map((candidate) => provenanceRef(candidate.provenance))],
    };
    return { ...base, contentSha256: catalogSha256(knowledgeSourceContentForHash(base)) };
  });

  const base = {
    contractVersion: GOVERNED_CATALOG_CONTRACT,
    sourcePackageId: `${sourceManifest.package}.${input.manifestFileSha256.slice(0, 16)}`,
    sourcePackageVersion: 1,
    targetEnvironment: input.targetEnvironment,
    dataClassification: "reference_only" as const,
    containsPhi: false as const,
    products: adaptedProducts,
    productLabels,
    commercialOffers,
    protocolTemplates,
    safetyRules,
    knowledgeSources,
  };
  return validateGovernedCatalogManifest({
    ...base,
    manifestSha256: catalogSha256(manifestContentForHash(base)),
  });
}

type SourceManifest = {
  package?: string;
  schemaVersion?: string;
  files?: Partial<Record<typeof SOURCE_FILES[number], { records: number; sha256: string }>>;
};

export type SourceFiles = {
  "products.json": unknown[];
  "protocols.json": unknown[];
  "protocol_steps.json": unknown[];
  "safety_rules.json": unknown[];
  "sources.json": unknown[];
  "labels.json": unknown[];
  "label_crosscheck.json": unknown;
};

type Provenance = {
  sourceFile?: string;
  sourceSha256: string;
  sheet: string;
  row: number;
  affiliateWorkbook?: string;
  affiliateWorkbookSha256?: string;
  affiliateRow?: number;
};

type SourceProduct = {
  id: string;
  name: string;
  brand?: string | null;
  bestFor?: string | null;
  catalogScope?: string | null;
  eligibilityStatus: string;
  form?: string | null;
  ingredients?: unknown;
  normalizations?: unknown;
  productType: string;
  access: string;
  affiliate: null | { url: string; code?: string | null; supplier?: string | null; destinationScope?: string | null };
  restrictions: unknown[];
  contraindicationRuleIds: string[];
  protocolTemplateIds: string[];
  duplicateOf?: string | null;
  reviewStatus: string;
  provenance: Provenance;
};

type SourceProtocol = {
  id: string;
  version: string;
  name: string;
  goal: string;
  defaultDuration: string;
  paradigm: string;
  reviewStatus: string;
  provenance: Provenance;
};

type SourceProtocolStep = {
  id: string;
  templateId: string;
  sequence: string;
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
  productId?: string;
  reviewStatus: string;
  provenance: Provenance;
};

type SourceLabel = {
  id: string;
  labelFound: boolean;
  labelSourceUrl?: string | null;
  researchDate: string;
  researchMethod: string;
  confidence: "high" | "medium" | "low";
  form?: string | null;
  servingSize?: string | null;
  servingsPerContainer?: string | number | null;
  ingredients: Array<Record<string, unknown>>;
  otherIngredients?: string | null;
  allergens?: string | null;
  warnings?: string | null;
  notes?: string | null;
  practitionerDecisionRequired?: boolean;
  phase9f?: Record<string, unknown> & {
    prhId: string;
    disposition: string;
    evidenceArchived: boolean;
    physicalLabelRequired: boolean;
    officialProductUrl?: string | null;
  };
};

type SourceLabelCrosscheckRecord = Record<string, unknown> & {
  id: string;
  prhId?: string;
  verdict: string;
  evidenceArchived: boolean;
  physicalLabelRequired: boolean;
  jurisdictionReview: boolean;
};

type SourceLabelCrosscheck = {
  meta: Record<string, unknown>;
  records: SourceLabelCrosscheckRecord[];
};

type SourceSafetyRule = {
  id: string;
  severity: string;
  blocksRecommendation: string;
  category: string;
  appliesTo: string;
  expression: string;
  action: string;
  provenance: Provenance;
};

type SourceKnowledgeSource = {
  code: string;
  citation: string;
  publisher: string;
  evidenceLevel: string;
  url?: string | null;
  provenance: Provenance;
};

function asProduct(value: unknown): SourceProduct {
  if (!isRecord(value) || !text(value.id) || !text(value.name) || !text(value.productType)
    || !text(value.access) || !text(value.eligibilityStatus) || !text(value.reviewStatus)
    || !Array.isArray(value.restrictions) || !stringArray(value.contraindicationRuleIds)
    || !stringArray(value.protocolTemplateIds) || !validProvenance(value.provenance)
    || (value.affiliate !== null && (!isRecord(value.affiliate) || !text(value.affiliate.url)))) invalid();
  return value as unknown as SourceProduct;
}

function asProtocol(value: unknown): SourceProtocol {
  if (!isRecord(value) || !text(value.id) || !text(value.version) || !text(value.name)
    || !text(value.goal) || !text(value.defaultDuration) || !text(value.paradigm)
    || !text(value.reviewStatus) || !validProvenance(value.provenance)) invalid();
  return value as unknown as SourceProtocol;
}

function asProtocolStep(value: unknown): SourceProtocolStep {
  if (!isRecord(value) || !text(value.id) || !text(value.templateId) || !text(value.sequence)
    || !positiveInteger(Number(value.sequence)) || !text(value.phase) || !text(value.instructions)
    || !text(value.prerequisites) || !text(value.monitoring) || !text(value.stopCriteria)
    || !text(value.conditionalLogic) || !text(value.reviewStatus) || !validProvenance(value.provenance)
    || !optionalSourceText(value.adjustmentLogic) || !optionalSourceText(value.duration)
    || !optionalSourceText(value.timing) || !optionalSourceText(value.interventionId)
    || !optionalSourceText(value.productId)) invalid();
  return value as unknown as SourceProtocolStep;
}

function asLabel(value: unknown): SourceLabel {
  if (!isRecord(value) || !text(value.id) || typeof value.labelFound !== "boolean"
    || !text(value.researchDate) || !text(value.researchMethod)
    || !["high", "medium", "low"].includes(String(value.confidence))
    || !Array.isArray(value.ingredients) || value.ingredients.some((item) => !isRecord(item) || !text(item.name))
    || (value.phase9f !== undefined && (!isRecord(value.phase9f)
      || !text(value.phase9f.prhId) || !text(value.phase9f.disposition)
      || typeof value.phase9f.evidenceArchived !== "boolean"
      || typeof value.phase9f.physicalLabelRequired !== "boolean"))
    || !optionalSourceText(value.labelSourceUrl)) invalid();
  return value as unknown as SourceLabel;
}

function asLabelCrosscheck(value: unknown): SourceLabelCrosscheck {
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.records)) invalid();
  const records = value.records.map((row) => {
    if (!isRecord(row) || !text(row.id) || (row.prhId !== undefined && !text(row.prhId)) || !text(row.verdict)
      || typeof row.evidenceArchived !== "boolean" || typeof row.physicalLabelRequired !== "boolean"
      || typeof row.jurisdictionReview !== "boolean") invalid();
    return row as SourceLabelCrosscheckRecord;
  });
  return { meta: value.meta, records };
}

function asSafetyRule(value: unknown): SourceSafetyRule {
  if (!isRecord(value) || !text(value.id) || !text(value.severity) || !text(value.blocksRecommendation)
    || !text(value.category) || !text(value.appliesTo) || !text(value.expression)
    || !text(value.action) || !validProvenance(value.provenance)) invalid();
  return value as unknown as SourceSafetyRule;
}

function asKnowledgeSource(value: unknown): SourceKnowledgeSource {
  if (!isRecord(value) || !text(value.code) || !text(value.citation) || !text(value.publisher)
    || !text(value.evidenceLevel) || (value.url !== null && value.url !== undefined && !text(value.url))
    || !validProvenance(value.provenance)) invalid();
  return value as unknown as SourceKnowledgeSource;
}

function productStableId(value: string) { return stableId("prd", value); }
function productLabelStableId(value: string) { return stableId("lbl", value.replace(/^aff_/i, "")); }
function offerStableId(value: string) { return stableId("off", value); }
function protocolStableId(value: string) { return stableId("tpl", value.replace(/^pt_/i, "")); }
function safetyRuleStableId(value: string) { return stableId("saf", value.replace(/^safe_/i, "")); }
function knowledgeSourceStableId(value: string) { return stableId("src", value.replace(/^src_/i, "")); }
function protocolStepStableId(value: string) { return stableId("stp", value.replace(/^ps_/i, "")); }

function stableId(prefix: string, source: string): string {
  const normalized = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const value = `${prefix}_${normalized}`;
  if (!/^[a-z]{3}_[a-z0-9][a-z0-9_-]{2,95}$/.test(value) || value.length > 100) invalid();
  return value;
}

function productType(value: string): CatalogProductSeed["productType"] {
  if (value === "supplement") return "supplement";
  if (value === "oral_peptide") return "oral_peptide";
  if (["research_compound", "unresolved_reference"].includes(value)) return "practitioner_only";
  invalid();
}

function provenanceRef(value: Provenance): string {
  return `workbook-sha256:${value.sourceSha256}:sheet:${value.sheet}:row:${value.row}`;
}

function affiliateProvenanceRef(value: Provenance): string | undefined {
  if (!value.affiliateWorkbookSha256 || !value.affiliateRow) return undefined;
  return `workbook-sha256:${value.affiliateWorkbookSha256}:row:${value.affiliateRow}`;
}

function validProvenance(value: unknown): value is Provenance {
  return isRecord(value) && SHA256.test(String(value.sourceSha256))
    && text(value.sheet) && positiveInteger(value.row);
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
}

function byteSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function matchesPinnedTextHash(value: Buffer, expected: string): boolean {
  if (byteSha256(value) === expected) return true;
  const normalized = value.toString("utf8").replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex") === expected;
}

function safeHttpsUrl(value: unknown): value is string {
  try { return typeof value === "string" && new URL(value).protocol === "https:"; } catch { return false; }
}

function safeLabelEvidence(label: SourceLabel, crosscheck?: SourceLabelCrosscheckRecord): Record<string, unknown> {
  const phase9f = { ...(label.phase9f ?? {}) };
  const officialProductUrl = phase9f.officialProductUrl;
  delete phase9f.officialProductUrl;
  return compactObject({
    ...label,
    labelSourceUrl: safeHttpsUrl(label.labelSourceUrl) ? label.labelSourceUrl : undefined,
    labelSourceUrlReviewRequired: Boolean(label.labelSourceUrl) && !safeHttpsUrl(label.labelSourceUrl),
    phase9f: compactObject({
      ...phase9f,
      officialProductUrl: safeHttpsUrl(officialProductUrl) ? officialProductUrl : undefined,
      officialProductUrlReviewRequired: Boolean(officialProductUrl) && !safeHttpsUrl(officialProductUrl),
    }),
    crosscheck,
  });
}

function labelReviewState(label?: SourceLabel, crosscheck?: SourceLabelCrosscheckRecord) {
  const reasons = new Set<string>();
  if (!label) reasons.add("label_evidence_missing");
  if (label && !label.labelFound) reasons.add("label_not_found");
  if (label?.phase9f?.physicalLabelRequired || crosscheck?.physicalLabelRequired) reasons.add("physical_label_required");
  if (label?.practitionerDecisionRequired || crosscheck?.verdict === "substantive_conflict") reasons.add("substantive_conflict");
  if (label?.labelSourceUrl && !safeHttpsUrl(label.labelSourceUrl)) reasons.add("label_source_url_invalid");
  if (label?.phase9f?.officialProductUrl && !safeHttpsUrl(label.phase9f.officialProductUrl)) reasons.add("official_product_url_invalid");
  return { approvalBlocked: reasons.size > 0, reasons: [...reasons].sort() };
}

function recordCount(file: typeof SOURCE_FILES[number], value: unknown): number {
  if (file === "label_crosscheck.json") {
    return isRecord(value) && Array.isArray(value.records) ? value.records.length : -1;
  }
  return Array.isArray(value) ? value.length : -1;
}

function optionalSourceText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function assertUnique(values: string[]) {
  if (new Set(values).size !== values.length) invalid();
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function invalid(): never {
  throw new GovernedCatalogSourcePackageError("source_package_invalid");
}

function referenceInvalid(): never {
  throw new GovernedCatalogSourcePackageError("source_package_reference_invalid");
}
