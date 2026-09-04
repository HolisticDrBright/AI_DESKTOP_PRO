import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  GovernedCatalogSourcePackageError,
  loadAndAdaptGovernedCatalogSourcePackage,
} from "./aws-governed-catalog-seed-adapter";

const workbookSha = "a".repeat(64);
const affiliateSha = "b".repeat(64);

function sourcePackage() {
  const provenance = {
    sourceFile: "Authoring.xlsx",
    sourceSha256: workbookSha,
    sheet: "Product Formulary",
    row: 2,
    affiliateWorkbook: "Affiliate.xlsx",
    affiliateWorkbookSha256: affiliateSha,
    affiliateRow: 2,
  };
  return {
    "products.json": [{
      id: "aff_synthetic_omega_001",
      name: "Synthetic Omega",
      brand: "Synthetic Brand",
      bestFor: "Synthetic fixture",
      catalogScope: "clinical_affiliate_catalog",
      eligibilityStatus: "needs_label",
      form: null,
      ingredients: null,
      normalizations: [],
      productType: "supplement",
      access: "open",
      affiliate: {
        url: "https://example.invalid/synthetic?ref=test",
        code: "TEST",
        supplier: "Synthetic Brand",
        destinationScope: "product",
      },
      restrictions: [],
      contraindicationRuleIds: ["safe_synthetic_stop"],
      protocolTemplateIds: ["pt_synthetic_v1"],
      duplicateOf: null,
      reviewStatus: "needs_review",
      provenance,
    }],
    "protocols.json": [{
      id: "pt_synthetic_v1",
      version: "1",
      name: "Synthetic Protocol",
      goal: "Synthetic fixture only",
      defaultDuration: "No duration approved",
      paradigm: "sequential",
      reviewStatus: "needs_review",
      provenance: { ...provenance, sheet: "Protocol Templates", row: 3 },
    }],
    "protocol_steps.json": [{
      id: "ps_synthetic_01",
      templateId: "pt_synthetic_v1",
      sequence: "1",
      phase: "assessment",
      instructions: "Review the synthetic fixture.",
      prerequisites: "Synthetic consent confirmed",
      monitoring: "Synthetic status",
      stopCriteria: "Stop on synthetic warning",
      conditionalLogic: "Proceed only in synthetic staging",
      productId: "aff_synthetic_omega_001",
      reviewStatus: "needs_review",
      provenance: { ...provenance, sheet: "Protocol Steps", row: 6 },
    }],
    "safety_rules.json": [{
      id: "safe_synthetic_stop",
      severity: "practitioner_review_required",
      blocksRecommendation: "yes",
      category: "synthetic",
      appliesTo: "synthetic",
      expression: "Synthetic stop condition",
      action: "Stop and review",
      provenance: { ...provenance, sheet: "Safety Rules", row: 4 },
    }],
    "sources.json": [{
      code: "SRC_SYNTHETIC",
      citation: "Synthetic source fixture",
      publisher: "Example",
      evidenceLevel: "unknown",
      url: "https://example.invalid/source",
      provenance: { ...provenance, sheet: "Sources", row: 5 },
    }],
    "labels.json": [{
      id: "aff_synthetic_omega_001",
      labelFound: true,
      labelSourceUrl: "https://example.invalid/label",
      researchDate: "2026-08-19",
      researchMethod: "synthetic fixture",
      confidence: "high",
      form: "capsule",
      servingSize: "1 synthetic capsule",
      servingsPerContainer: 1,
      ingredients: [{ name: "Synthetic EPA", amount: "1", unit: "mg" }],
      phase9f: {
        prhId: "PRH-SYNTHETIC",
        disposition: "verified",
        evidenceArchived: true,
        physicalLabelRequired: false,
        officialProductUrl: "https://example.invalid/product",
      },
    }],
    "label_crosscheck.json": {
      meta: { summary: { matched: 1 } },
      records: [{
        id: "aff_synthetic_omega_001",
        prhId: "PRH-SYNTHETIC",
        verdict: "corroborated",
        evidenceArchived: true,
        physicalLabelRequired: false,
        jurisdictionReview: false,
      }],
    },
  };
}

function writeSourcePackage(options: { schemaVersion?: "1.0.0" | "1.1.0"; crlfFiles?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "governed-catalog-source-"));
  const files = sourcePackage();
  const manifestFiles: Record<string, { records: number; sha256: string }> = {};
  for (const [file, value] of Object.entries(files)) {
    const bytes = JSON.stringify(value, null, 2);
    writeFileSync(join(directory, file), options.crlfFiles ? bytes.replace(/\n/g, "\r\n") : bytes);
    const records = Array.isArray(value) ? value.length : value.records.length;
    manifestFiles[file] = { records, sha256: sha256(bytes) };
  }
  const manifest = JSON.stringify({
    package: "ai-longevity-pro-v2-governed-catalog",
    schemaVersion: options.schemaVersion ?? "1.0.0",
    files: manifestFiles,
  }, null, 2);
  writeFileSync(join(directory, "manifest.json"), manifest);
  return { directory, manifestSha256: sha256(manifest) };
}

describe("Claude source package to AWS governed catalog adapter", () => {
  test.runIf(Boolean(process.env.GOVERNED_CATALOG_SOURCE_DIR))(
    "adapts the externally handed-off package when its pinned path is available",
    () => {
      const manifest = loadAndAdaptGovernedCatalogSourcePackage({
        directory: process.env.GOVERNED_CATALOG_SOURCE_DIR!,
        expectedManifestFileSha256: process.env.GOVERNED_CATALOG_SOURCE_MANIFEST_SHA256!,
        targetEnvironment: "synthetic-staging",
      });
      expect(manifest.products).toHaveLength(137);
      expect(manifest.productLabels).toHaveLength(98);
      expect(manifest.commercialOffers).toHaveLength(95);
      expect(manifest.protocolTemplates).toHaveLength(32);
      expect(manifest.protocolTemplates.flatMap((template) => template.steps)).toHaveLength(163);
      expect(manifest.safetyRules).toHaveLength(55);
      expect(manifest.knowledgeSources).toHaveLength(77);
    },
  );

  test("verifies every source file and preserves all five governed domains", () => {
    const source = writeSourcePackage();
    try {
      const manifest = loadAndAdaptGovernedCatalogSourcePackage({
        directory: source.directory,
        expectedManifestFileSha256: source.manifestSha256,
        targetEnvironment: "synthetic-staging",
      });
      expect(manifest).toMatchObject({
        targetEnvironment: "synthetic-staging",
        dataClassification: "reference_only",
        containsPhi: false,
      });
      expect(manifest.products).toHaveLength(1);
      expect(manifest.productLabels).toHaveLength(1);
      expect(manifest.commercialOffers).toHaveLength(1);
      expect(manifest.protocolTemplates[0]?.items).toHaveLength(1);
      expect(manifest.protocolTemplates[0]?.steps).toHaveLength(1);
      expect(manifest.safetyRules).toHaveLength(1);
      expect(manifest.knowledgeSources).toHaveLength(1);
      expect(manifest.products[0]?.clinicalPayload).not.toHaveProperty("affiliate");
      expect(manifest.commercialOffers[0]?.destinationUrl).toContain("ref=test");
      expect(manifest.safetyRules[0]).toMatchObject({
        stableId: "saf_synthetic_stop",
        blocksRecommendation: true,
      });
    } finally {
      rmSync(source.directory, { recursive: true, force: true });
    }
  });

  test("rejects an unpinned or modified source manifest", () => {
    const source = writeSourcePackage();
    try {
      expect(() => loadAndAdaptGovernedCatalogSourcePackage({
        directory: source.directory,
        expectedManifestFileSha256: "0".repeat(64),
        targetEnvironment: "production-clinical",
      })).toThrowError(expect.objectContaining<Partial<GovernedCatalogSourcePackageError>>({
        category: "source_package_hash_mismatch",
      }));
    } finally {
      rmSync(source.directory, { recursive: true, force: true });
    }
  });

  test("accepts the pinned v1.1 package when Git materializes JSON with CRLF", () => {
    const source = writeSourcePackage({ schemaVersion: "1.1.0", crlfFiles: true });
    try {
      const manifest = loadAndAdaptGovernedCatalogSourcePackage({
        directory: source.directory,
        expectedManifestFileSha256: source.manifestSha256,
        targetEnvironment: "synthetic-staging",
      });
      expect(manifest.products).toHaveLength(1);
      expect(manifest.products[0]?.stableId).toBe("prd_aff_synthetic_omega_001");
    } finally {
      rmSync(source.directory, { recursive: true, force: true });
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
