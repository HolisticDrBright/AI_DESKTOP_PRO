import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import { createAwsGovernedCatalogReader } from "./aws-governed-catalog-reader";

function database(responses: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  let index = 0;
  const value: ClinicalCoreDatabase = {
    async transaction(work) {
      return work({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          parameters: readonly unknown[] = [],
        ): Promise<ClinicalCoreQueryResult<Row>> {
          calls.push({ sql, parameters });
          if (sql.includes("set_config('clinical.catalog.environment'")) return { rows: [] };
          return { rows: (responses[index++] ?? []) as Row[] };
        },
      });
    },
  };
  return { value, calls };
}

describe("AWS governed catalog reader", () => {
  test("returns approved clinical products and commercial offers in separate keys", async () => {
    const db = database([
      [{
        product_stable_id: "prd_reviewed_omega",
        version: 1,
        display_name: "Reviewed Omega",
        product_type: "supplement",
        access_tier: "open",
        declared_restricted: false,
        direct_order_allowed: true,
        clinical_payload_json: JSON.stringify({ ingredients: ["EPA"] }),
        source_refs_json: JSON.stringify(["label:reviewed-omega:v1"]),
      }],
      [],
      [{
        offer_stable_id: "off_reviewed_omega",
        version: 1,
        product_stable_id: "prd_reviewed_omega",
        destination_url: "https://example.invalid/reviewed-omega",
        tracking_metadata_json: JSON.stringify({ campaign: "reviewed" }),
      }],
    ]);
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProducts({ limit: 50 })).resolves.toEqual({
      products: [expect.objectContaining({ stableId: "prd_reviewed_omega", reviewStatus: "approved" })],
      commercial: { offers: [expect.objectContaining({ stableId: "off_reviewed_omega", reviewStatus: "approved" })] },
    });
    expect(db.calls[0]!.parameters).toEqual(["production-clinical"]);
    expect(db.calls[1]!.sql).not.toContain("commercial_reference");
    expect(db.calls[2]!.sql).toContain("product_label_versions");
    expect(db.calls[3]!.sql).not.toContain("clinical_payload");
    expect(db.calls.every((call) => !call.sql.toLowerCase().includes("supabase"))).toBe(true);
  });

  test("never describes a failed backend as an empty catalog", async () => {
    const value: ClinicalCoreDatabase = { async transaction() { throw new Error("provider detail"); } };
    await expect(createAwsGovernedCatalogReader(value, "production-clinical").listProducts({ limit: 50 }))
      .rejects.toMatchObject({ category: "catalog_unavailable" });
  });

  test("refuses malformed database payloads instead of returning invented defaults", async () => {
    const db = database([[{
      product_stable_id: "prd_reviewed_omega",
      version: 1,
      display_name: "Reviewed Omega",
      product_type: "supplement",
      access_tier: "open",
      declared_restricted: false,
      direct_order_allowed: true,
      clinical_payload_json: "not-json",
      source_refs_json: "[]",
    }]]);
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProducts({ limit: 50 }))
      .rejects.toMatchObject({ category: "catalog_response_invalid" });
  });

  test("requires dose provenance in every returned protocol item", async () => {
    const db = database([[{
      template_stable_id: "tpl_reviewed_foundation",
      version: 1,
      title: "Reviewed Foundation",
      summary: null,
      source_refs_json: JSON.stringify(["protocol:reviewed:v1"]),
      items_json: JSON.stringify([{
        position: 1,
        productStableId: "prd_reviewed_omega",
        dosageText: "two units",
        doseSourceRef: null,
        monitoringRequirements: [],
        stoppingRules: [],
        contraindications: [],
      }]),
    }]]);
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProtocolTemplates({ limit: 50 }))
      .rejects.toMatchObject({ category: "catalog_response_invalid" });
  });
});
