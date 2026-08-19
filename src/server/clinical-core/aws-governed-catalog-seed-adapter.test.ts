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
  };
}

function writeSourcePackage() {
  const directory = mkdtempSync(join(tmpdir(), "governed-catalog-source-"));
  const files = sourcePackage();
  const manifestFiles: Record<string, { records: number; sha256: string }> = {};
  for (const [file, rows] of Object.entries(files)) {
    const bytes = JSON.stringify(rows, null, 2);
    writeFileSync(join(directory, file), bytes);
    manifestFiles[file] = { records: rows.length, sha256: sha256(bytes) };
  }
  const manifest = JSON.stringify({
    package: "ai-longevity-pro-v2-governed-catalog",
    schemaVersion: "1.0.0",
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
      expect(manifest.products).toHaveLength(133);
      expect(manifest.commercialOffers).toHaveLength(91);
      expect(manifest.protocolTemplates).toHaveLength(32);
      expect(manifest.safetyRules).toHaveLength(55);
      expect(manifest.knowledgeSources).toHaveLength(76);
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
      expect(manifest.commercialOffers).toHaveLength(1);
      expect(manifest.protocolTemplates[0]?.items).toHaveLength(1);
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
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
