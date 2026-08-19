import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import { reviewGovernedCatalogVersion } from "./aws-governed-catalog-review";

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
