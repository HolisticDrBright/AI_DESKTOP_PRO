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
  productContentForHash,
  safetyRuleContentForHash,
  templateContentForHash,
  validateGovernedCatalogManifest,
  type CatalogKnowledgeSourceSeed,
  type CatalogProductSeed,
  type CatalogSafetyRuleSeed,
  type CommercialOfferSeed,
  type GovernedCatalogSeedManifest,
  type ProtocolTemplateSeed,
} from "./aws-governed-catalog";

const SOURCE_FILES = ["products.json", "protocols.json", "safety_rules.json", "sources.json"] as const;
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
    if (!expected || expected.sha256 !== byteSha256(bytes)) {
      throw new GovernedCatalogSourcePackageError("source_package_hash_mismatch");
    }
    const records = parseJson(bytes);
    if (!Array.isArray(records) || records.length !== expected.records) invalid();
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
    || sourceManifest.schemaVersion !== "1.0.0") invalid();
  for (const file of SOURCE_FILES) {
    const expected = sourceManifest.files?.[file];
    if (!expected || !SHA256.test(expected.sha256) || !positiveInteger(expected.records)
      || !Array.isArray(input.files[file]) || input.files[file].length !== expected.records) invalid();
  }

  const products = input.files["products.json"].map(asProduct);
  const protocols = input.files["protocols.json"].map(asProtocol);
  const rules = input.files["safety_rules.json"].map(asSafetyRule);
  const sources = input.files["sources.json"].map(asKnowledgeSource);
  assertUnique(products.map((row) => row.id));
  assertUnique(protocols.map((row) => row.id));
  assertUnique(rules.map((row) => row.id));
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

  const adaptedProducts = products.map((source): CatalogProductSeed => {
    const stableId = productStableId(source.id);
    const restricted = source.access !== "open";
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

export type SourceFiles = Record<typeof SOURCE_FILES[number], unknown[]>;

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
function offerStableId(value: string) { return stableId("off", value); }
function protocolStableId(value: string) { return stableId("tpl", value.replace(/^pt_/i, "")); }
function safetyRuleStableId(value: string) { return stableId("saf", value.replace(/^safe_/i, "")); }
function knowledgeSourceStableId(value: string) { return stableId("src", value.replace(/^src_/i, "")); }

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

function safeHttpsUrl(value: unknown): value is string {
  try { return typeof value === "string" && new URL(value).protocol === "https:"; } catch { return false; }
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

function isRecord(value: unknown): value is Record<string, any> {
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
