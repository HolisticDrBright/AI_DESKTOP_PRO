import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import {
  activateCatalogOwnerCommercialOffers,
  activateLabelReadyCommercialOffers,
  approveGovernedCatalogRelease,
  catalogOwnerCommercialSelection,
  reviewGovernedCatalogVersion,
} from "./aws-governed-catalog-review";
import {
  GOVERNED_CATALOG_CONTRACT, catalogSha256, manifestContentForHash, offerContentForHash, productContentForHash,
  type GovernedCatalogSeedManifest,
} from "./aws-governed-catalog";

function database(subject: Record<string, unknown>) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const value: ClinicalCoreDatabase = {
    async transaction(work) {
      return work({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          parameters: readonly unknown[] = [],
        ): Promise<ClinicalCoreQueryResult<Row>> {
          calls.push({ sql, parameters });
          if (sql.includes("select p.environment") || sql.includes("select t.environment")
            || sql.includes("select v.environment") || sql.includes("select r.environment")
            || sql.includes("select l.environment")) {
            return { rows: [subject as Row] };
          }
          if (sql.includes("insert into clinical_reference.catalog_review_events")) {
            return { rows: [{ reviewed_at: "2026-08-19T22:00:00.000Z" } as unknown as Row] };
          }
          return { rows: [] };
        },
      });
    },
  };
  return { value, calls };
}

const common = {
  reviewerPersonId: "11111111-1111-4111-8111-111111111111",
  reason: "Reviewed source, restrictions, and provenance.",
  environment: "production-clinical" as const,
};

describe("governed catalog review activation", () => {
  test("activates only the exact catalog-owner-approved synthetic URL set", async () => {
    const row = {
      offer_stable_id: "off_candidate_omega", offer_version: 1,
      offer_content_sha256: "b".repeat(64), product_stable_id: "prd_candidate_omega",
      product_version: 2,
    };
    const selectionSha256 = catalogSha256([{
      offerStableId: row.offer_stable_id, offerVersion: row.offer_version,
      offerContentSha256: row.offer_content_sha256,
      productStableId: row.product_stable_id, productVersion: row.product_version,
    }]);
    const calls: string[] = [];
    const db: ClinicalCoreDatabase = {
      async transaction(work) {
        return work({ async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
          calls.push(sql);
          if (sql.includes("from commercial_reference.affiliate_offers o")) return { rows: [row as unknown as Row] };
          if (sql.includes("returning subject_stable_id") || sql.includes("returning o.stable_id")) {
            return { rows: [{ offer_stable_id: row.offer_stable_id } as unknown as Row] };
          }
          return { rows: [] };
        } });
      },
    };
    await expect(activateCatalogOwnerCommercialOffers(db, {
      reviewerPersonId: "11111111-1111-4111-8111-111111111111",
      reason: "Owner-approved exact source-provided synthetic product destinations.",
      environment: "synthetic-staging",
      expectedSelectionSha256: selectionSha256,
      expectedCount: 1,
    })).resolves.toMatchObject({ offersActivated: 1, selectionSha256 });
    expect(calls.some((sql) => sql.includes("tracking_metadata->>'approval'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("affiliate_offer_version"))).toBe(true);
  });

  test("derives the same commercial selection hash from an immutable manifest", () => {
    const productBase = {
      stableId: "prd_candidate_omega", version: 2, displayName: "Candidate Omega",
      productType: "supplement" as const, accessTier: "open" as const,
      declaredRestricted: false, directOrderAllowed: true,
      clinicalPayload: {}, sourceRefs: ["synthetic:test"],
    };
    const product = { ...productBase, contentSha256: catalogSha256(productContentForHash(productBase)) };
    const offerBase = {
      stableId: "off_candidate_omega", version: 1, productStableId: product.stableId,
      destinationUrl: "https://example.test/omega",
      trackingMetadata: { approval: "catalog_owner_commercial_activation", approvalVersion: "1.0.0" },
      declaredRestricted: false, directOrderAllowed: true,
    };
    const offer = { ...offerBase, contentSha256: catalogSha256(offerContentForHash(offerBase)) };
    const base = {
      contractVersion: GOVERNED_CATALOG_CONTRACT,
      sourcePackageId: "synthetic.commercial.release", sourcePackageVersion: 1,
      targetEnvironment: "synthetic-staging" as const, dataClassification: "reference_only" as const,
      containsPhi: false as const, products: [product], productLabels: [], commercialOffers: [offer],
      protocolTemplates: [], safetyRules: [], knowledgeSources: [],
    };
    const manifest = { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
    expect(catalogOwnerCommercialSelection(manifest)).toEqual({
      count: 1,
      selectionSha256: catalogSha256([{
        offerStableId: offer.stableId, offerVersion: offer.version,
        offerContentSha256: offer.contentSha256,
        productStableId: product.stableId, productVersion: product.version,
      }]),
    });
  });

  test("activates only the exact attested set of label-ready commercial offers", async () => {
    const row = {
      offer_stable_id: "off_label_ready_omega", offer_version: 1,
      offer_content_sha256: "a".repeat(64), product_stable_id: "prd_label_ready_omega",
      product_version: 4, display_name: "Synthetic Omega", product_type: "supplement",
      access_tier: "open", declared_restricted: false, direct_order_allowed: false,
      clinical_payload_json: JSON.stringify({ autoSelectionEligible: true }),
      source_refs_json: JSON.stringify(["synthetic:test"]),
      import_batch_id: "22222222-2222-4222-8222-222222222222",
    };
    const selectionSha256 = catalogSha256([{
      offerStableId: row.offer_stable_id, offerVersion: row.offer_version,
      offerContentSha256: row.offer_content_sha256,
      productStableId: row.product_stable_id, productVersion: row.product_version,
    }]);
    const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const db: ClinicalCoreDatabase = {
      async transaction(work) {
        return work({ async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
          calls.push({ sql, parameters });
          if (sql.includes("from commercial_reference.affiliate_offers o")) return { rows: [row as unknown as Row] };
          return { rows: [] };
        } });
      },
    };
    await expect(activateLabelReadyCommercialOffers(db, {
      reviewerPersonId: "11111111-1111-4111-8111-111111111111",
      reason: "Owner-approved synthetic purchase links after label and destination review.",
      environment: "synthetic-staging",
      expectedSelectionSha256: selectionSha256,
    })).resolves.toMatchObject({ productsActivated: 1, offersActivated: 1, selectionSha256 });
    expect(calls.some((call) => call.sql.includes("catalog_product_versions"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("affiliate_offer_version"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("update commercial_reference.affiliate_offers"))).toBe(true);
  });

  test("bulk approval activates clinical products without commercial offers", async () => {
    const productBase = {
      stableId: "prd_bulk_synthetic", version: 2, displayName: "Bulk synthetic",
      productType: "supplement" as const, accessTier: "open" as const,
      declaredRestricted: false, directOrderAllowed: false,
      clinicalPayload: { selectionPriorityGroup: "original_primary" },
      sourceRefs: ["synthetic:test"],
    };
    const product = { ...productBase, contentSha256: catalogSha256(productContentForHash(productBase)) };
    const manifestBase = {
      contractVersion: GOVERNED_CATALOG_CONTRACT,
      sourcePackageId: "synthetic.bulk.release", sourcePackageVersion: 1,
      targetEnvironment: "synthetic-staging" as const, dataClassification: "reference_only" as const,
      containsPhi: false as const, products: [product], productLabels: [], commercialOffers: [],
      protocolTemplates: [], safetyRules: [], knowledgeSources: [],
    };
    const manifest: GovernedCatalogSeedManifest = {
      ...manifestBase, manifestSha256: catalogSha256(manifestContentForHash(manifestBase)),
    };
    const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const db: ClinicalCoreDatabase = {
      async transaction(work) {
        return work({
          async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
            calls.push({ sql, parameters });
            if (sql.includes("select r.stable_id") || sql.includes("returning r.stable_id")) {
              return { rows: [{ stable_id: "prd_bulk_synthetic" } as unknown as Row] };
            }
            return { rows: [] };
          },
        });
      },
    };
    await expect(approveGovernedCatalogRelease(db, {
      manifest,
      reviewerPersonId: "11111111-1111-4111-8111-111111111111",
      reason: "Owner-approved catalog availability; commercial activation remains separate.",
      environment: "synthetic-staging",
    })).resolves.toMatchObject({ outcome: "approved", counts: { products: 1, commercialOffers: 0 } });
    expect(calls.some((call) => call.sql.includes("catalog_review_events"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("affiliate_offers"))).toBe(false);
    const lookup = calls.find((call) => call.sql.includes("select r.stable_id"));
    expect(JSON.parse(String(lookup?.parameters[0]))).toEqual([
      { stable_id: "prd_bulk_synthetic", version: 2 },
    ]);
  });

  test("records named approval before making a safe product version selectable", async () => {
    const db = database({
      environment: "production-clinical",
      declared_restricted: false,
      direct_order_allowed: true,
      access_tier: "open",
      label_ready: true,
    });
    await expect(reviewGovernedCatalogVersion(db.value, {
      ...common,
      subjectType: "product_version",
      stableId: "prd_reviewed_omega",
      version: 1,
      outcome: "approved",
    })).resolves.toMatchObject({ outcome: "approved", selectable: true });
    const insertIndex = db.calls.findIndex((call) => call.sql.includes("catalog_review_events"));
    const activateIndex = db.calls.findIndex((call) => call.sql.includes("active_version = $2"));
    expect(insertIndex).toBeGreaterThan(0);
    expect(activateIndex).toBeGreaterThan(insertIndex);
  });

  test("blocks a protocol template until every referenced product is approved", async () => {
    const db = database({ environment: "production-clinical", unresolved_products: 1, unsourced_doses: 0 });
    await expect(reviewGovernedCatalogVersion(db.value, {
      ...common,
      subjectType: "protocol_template_version",
      stableId: "tpl_foundation",
      version: 1,
      outcome: "approved",
    })).rejects.toMatchObject({ category: "review_precondition_failed" });
    expect(db.calls.some((call) => call.sql.includes("catalog_review_events"))).toBe(false);
  });

  test("blocks a direct commercial offer for a restricted product", async () => {
    const db = database({
      environment: "production-clinical",
      declared_restricted: true,
      direct_order_allowed: true,
      product_review_status: "approved",
    });
    await expect(reviewGovernedCatalogVersion(db.value, {
      ...common,
      subjectType: "affiliate_offer_version",
      stableId: "off_restricted",
      version: 1,
      outcome: "approved",
    })).rejects.toMatchObject({ category: "review_precondition_failed" });
  });

  test("blocks label approval while a physical-label or substantive-conflict flag remains", async () => {
    const db = database({
      environment: "production-clinical",
      label_found: true,
      physical_label_required: true,
      substantive_conflict: true,
      practitioner_decision_required: true,
    });
    await expect(reviewGovernedCatalogVersion(db.value, {
      ...common,
      subjectType: "product_label_version",
      stableId: "lbl_synthetic_conflict",
      version: 1,
      outcome: "approved",
    })).rejects.toMatchObject({ category: "review_precondition_failed" });
    expect(db.calls.some((call) => call.sql.includes("catalog_review_events"))).toBe(false);
  });

  test("keeps rejection as append-only review evidence without activating content", async () => {
    const db = database({
      environment: "production-clinical",
      declared_restricted: false,
      direct_order_allowed: false,
      product_review_status: "approved",
    });
    await expect(reviewGovernedCatalogVersion(db.value, {
      ...common,
      subjectType: "affiliate_offer_version",
      stableId: "off_rejected",
      version: 1,
      outcome: "rejected",
    })).resolves.toMatchObject({ outcome: "rejected", selectable: false });
    expect(db.calls.some((call) => call.sql.includes("active_version = $2"))).toBe(false);
  });

  test("requires named review before a safety rule or knowledge source can activate", async () => {
    for (const subject of [
      { subjectType: "safety_rule_version" as const, stableId: "saf_review_required" },
      { subjectType: "knowledge_source_version" as const, stableId: "src_guideline" },
    ]) {
      const db = database({ environment: "production-clinical" });
      await expect(reviewGovernedCatalogVersion(db.value, {
        ...common,
        ...subject,
        version: 1,
        outcome: "approved",
      })).resolves.toMatchObject({ selectable: true });
      expect(db.calls.some((call) => call.sql.includes("catalog_review_events"))).toBe(true);
      expect(db.calls.some((call) => call.sql.includes("active_version = $2"))).toBe(true);
    }
  });
});
