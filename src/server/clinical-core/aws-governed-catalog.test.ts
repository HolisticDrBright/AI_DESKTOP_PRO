import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import {
  catalogSha256,
  importGovernedCatalog,
  manifestContentForHash,
  knowledgeSourceContentForHash,
  offerContentForHash,
  productContentForHash,
  safetyRuleContentForHash,
  templateContentForHash,
  validateGovernedCatalogManifest,
  type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";

function manifest(): GovernedCatalogSeedManifest {
  const productBase = {
    stableId: "prd_synthetic_omega",
    version: 1,
    displayName: "Synthetic Omega Reference",
    productType: "supplement" as const,
    accessTier: "open" as const,
    declaredRestricted: false,
    directOrderAllowed: true,
    clinicalPayload: { ingredients: [{ name: "Synthetic EPA" }], contraindications: ["Synthetic allergy"] },
    sourceRefs: ["vault:authoring-pack:products:synthetic-omega"],
  };
  const product = { ...productBase, contentSha256: catalogSha256(productContentForHash(productBase)) };
  const offerBase = {
    stableId: "off_synthetic_omega_v1",
    version: 1,
    productStableId: product.stableId,
    destinationUrl: "https://example.invalid/synthetic-omega?ref=test",
    trackingMetadata: { campaign: "synthetic_test" },
    declaredRestricted: false,
    directOrderAllowed: true,
  };
  const offer = { ...offerBase, contentSha256: catalogSha256(offerContentForHash(offerBase)) };
  const templateBase = {
    stableId: "tpl_synthetic_foundation",
    version: 1,
    title: "Synthetic Foundation",
    summary: "Synthetic-only fixture",
    sourceRefs: ["vault:authoring-pack:templates:synthetic-foundation"],
    items: [{
      position: 1,
      productStableId: product.stableId,
      dosageText: "Synthetic label direction",
      doseSourceRef: "synthetic-label:v1",
      monitoringRequirements: ["synthetic review"],
      stoppingRules: ["synthetic stop"],
      contraindications: ["synthetic contraindication"],
    }],
    steps: [],
  };
  const template = { ...templateBase, contentSha256: catalogSha256(templateContentForHash(templateBase)) };
  const safetyRuleBase = {
    stableId: "saf_synthetic_stop",
    version: 1,
    severity: "practitioner_review_required",
    blocksRecommendation: true,
    rulePayload: { expression: "Synthetic stop condition", action: "Synthetic review" },
    sourceRefs: ["vault:authoring-pack:safety:synthetic-stop"],
  };
  const safetyRule = { ...safetyRuleBase, contentSha256: catalogSha256(safetyRuleContentForHash(safetyRuleBase)) };
  const knowledgeSourceBase = {
    stableId: "src_synthetic_fixture",
    version: 1,
    citation: "Synthetic source fixture",
    publisher: "Example",
    evidenceLevel: "unknown",
    destinationUrl: "https://example.invalid/source",
    sourcePayload: { authoringCode: "SRC_SYNTHETIC" },
    sourceRefs: ["vault:authoring-pack:sources:synthetic"],
  };
  const knowledgeSource = {
    ...knowledgeSourceBase,
    contentSha256: catalogSha256(knowledgeSourceContentForHash(knowledgeSourceBase)),
  };
  const base = {
    contractVersion: "governed-catalog-seed/1" as const,
    sourcePackageId: "ai-longevity-authoring-pack",
    sourcePackageVersion: 1,
    targetEnvironment: "production-clinical" as const,
    dataClassification: "reference_only" as const,
    containsPhi: false as const,
    products: [product],
    productLabels: [],
    commercialOffers: [offer],
    protocolTemplates: [template],
    safetyRules: [safetyRule],
    knowledgeSources: [knowledgeSource],
  };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}

function database(options: { existingBatch?: boolean; conflict?: boolean } = {}) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  let transactionCount = 0;
  const value: ClinicalCoreDatabase = {
    async transaction(work) {
      transactionCount += 1;
      return work({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          parameters: readonly unknown[] = [],
        ): Promise<ClinicalCoreQueryResult<Row>> {
          calls.push({ sql, parameters });
          if (sql.includes("from clinical_reference.catalog_import_batches where")) {
            return { rows: options.existingBatch ? [{
              id: "11111111-1111-4111-8111-111111111111",
              manifest_sha256: manifest().manifestSha256,
              product_count: 1,
              product_label_count: 0,
              commercial_offer_count: 1,
              protocol_template_count: 1,
              safety_rule_count: 1,
              knowledge_source_count: 1,
              status: "succeeded",
            } as unknown as Row] : [] };
          }
          if (sql.includes("insert into clinical_reference.catalog_import_batches")) {
            return { rows: [{ id: "22222222-2222-4222-8222-222222222222" } as unknown as Row] };
          }
          if (sql.includes("select content_sha256")) {
            return { rows: options.conflict ? [{ content_sha256: "0".repeat(64) } as unknown as Row] : [] };
          }
          if (sql.includes("select environment from clinical_reference.")) {
            return { rows: [{ environment: "production-clinical" } as unknown as Row] };
          }
          return { rows: [] };
        },
      });
    },
  };
  return { value, calls, transactions: () => transactionCount };
}

describe("AWS governed catalog seed boundary", () => {
  test("accepts a canonical synthetic seed package", () => {
    expect(validateGovernedCatalogManifest(manifest())).toMatchObject({
      contractVersion: "governed-catalog-seed/1",
      sourcePackageVersion: 1,
      targetEnvironment: "production-clinical",
      dataClassification: "reference_only",
      containsPhi: false,
    });
  });

  test("refuses rewritten manifest and record hashes", () => {
    const rewrittenManifest = manifest();
    rewrittenManifest.products[0]!.displayName = "Rewritten";
    expect(() => validateGovernedCatalogManifest(rewrittenManifest)).toThrow(/content_hash_mismatch/);

    const rewrittenEnvelope = manifest();
    rewrittenEnvelope.sourcePackageVersion = 2;
    expect(() => validateGovernedCatalogManifest(rewrittenEnvelope)).toThrow(/manifest_hash_mismatch/);
  });

  test("refuses commercial data inside the clinical payload", () => {
    const value = manifest();
    value.products[0]!.clinicalPayload = { nested: { affiliateUrl: "https://example.invalid" } };
    const productContent = structuredClone(value.products[0]!);
    Reflect.deleteProperty(productContent, "contentSha256");
    value.products[0]!.contentSha256 = catalogSha256(productContentForHash(productContent));
    expect(() => validateGovernedCatalogManifest(value)).toThrow(/manifest_invalid/);
  });

  test("refuses direct ordering for restricted or injectable products", () => {
    const value = manifest();
    Object.assign(value.products[0]!, {
      productType: "injectable_peptide",
      accessTier: "injectable",
      declaredRestricted: true,
      directOrderAllowed: true,
    });
    expect(() => validateGovernedCatalogManifest(value)).toThrow(/manifest_invalid/);
  });

  test("refuses a dose without a named source", () => {
    const value = manifest();
    delete value.protocolTemplates[0]!.items[0]!.doseSourceRef;
    expect(() => validateGovernedCatalogManifest(value)).toThrow(/manifest_invalid/);
  });

  test("imports every domain in one transaction as needs_review", async () => {
    const db = database();
    await expect(importGovernedCatalog(db.value, manifest())).resolves.toMatchObject({
      alreadyApplied: false,
      reviewStatus: "needs_review",
      counts: { products: 1, productLabels: 0, commercialOffers: 1, protocolTemplates: 1, safetyRules: 1, knowledgeSources: 1 },
    });
    expect(db.transactions()).toBe(1);
    expect(db.calls[0]!.sql).toContain("pg_advisory_xact_lock");
    expect(db.calls.some((call) => call.sql.includes("catalog_product_versions"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("affiliate_offer_versions"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("protocol_template_items"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("safety_rule_versions"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("knowledge_source_versions"))).toBe(true);
    expect(db.calls.every((call) => !call.sql.includes("supabase"))).toBe(true);
    expect(db.calls.filter((call) => call.sql.includes("'needs_review'")).length).toBeGreaterThanOrEqual(3);
  });

  test("returns an existing successful manifest without writing again", async () => {
    const db = database({ existingBatch: true });
    await expect(importGovernedCatalog(db.value, manifest())).resolves.toMatchObject({ alreadyApplied: true });
    expect(db.calls.some((call) => call.sql.trim().startsWith("insert"))).toBe(false);
  });

  test("refuses the same stable version with different content", async () => {
    const db = database({ conflict: true });
    await expect(importGovernedCatalog(db.value, manifest())).rejects.toMatchObject({ category: "catalog_conflict" });
    expect(db.transactions()).toBe(1);
  });
});
