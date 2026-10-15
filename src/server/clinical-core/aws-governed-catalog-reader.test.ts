import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import { clinicalUuid, ClinicalCoreDatabaseRejection } from "./database";
import { createAwsGovernedCatalogReader } from "./aws-governed-catalog-reader";

const currentWorkforce = {
  subject: "33333333-3333-4333-8333-333333333333",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
};

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
          if (sql.includes("set_current_workforce_context")) return { rows: [] };
          if (sql.includes("to_regclass('clinical_reference.product_label_versions')")) {
            return { rows: [{ compatible: true }] as unknown as Row[] };
          }
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
      [{
        product_stable_id: "prd_reviewed_omega",
        label_stable_id: "lbl_reviewed_omega",
        version: 1,
        label_payload_json: JSON.stringify({ ingredients: [{ name: "EPA" }] }),
        crosscheck_payload_json: JSON.stringify({ verified: true }),
      }],
      [{
        offer_stable_id: "off_reviewed_omega",
        version: 1,
        product_stable_id: "prd_reviewed_omega",
        destination_url: "https://example.invalid/reviewed-omega",
        tracking_metadata_json: JSON.stringify({ campaign: "reviewed" }),
      }],
    ]);
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProducts({ limit: 50, currentWorkforce })).resolves.toEqual({
      products: [expect.objectContaining({ stableId: "prd_reviewed_omega", reviewStatus: "approved" })],
      commercial: { offers: [expect.objectContaining({ stableId: "off_reviewed_omega", reviewStatus: "approved" })] },
    });
    expect(db.calls[0]!.parameters).toEqual([currentWorkforce.subject, clinicalUuid(currentWorkforce.selectedOrganizationId), "clinical_data"]);
    expect(db.calls[1]!.sql).toContain("to_regclass");
    expect(db.calls[2]!.parameters).toEqual(["production-clinical"]);
    expect(db.calls[3]!.sql).not.toContain("commercial_reference");
    expect(db.calls[4]!.sql).toContain("product_label_versions");
    expect(db.calls[5]!.sql).not.toContain("clinical_payload");
    expect(db.calls.every((call) => !call.sql.toLowerCase().includes("supabase"))).toBe(true);
  });

  test("never releases an affiliate offer when its product lacks a reviewed label", async () => {
    const db = database([
      [{
        product_stable_id: "prd_reviewed_omega", version: 1, display_name: "Reference Omega",
        product_type: "supplement", access_tier: "open", declared_restricted: false,
        direct_order_allowed: true, clinical_payload_json: JSON.stringify({ ingredients: ["EPA"] }),
        source_refs_json: JSON.stringify(["catalog:reference"]),
      }],
      [],
      [{
        offer_stable_id: "off_reviewed_omega", version: 1,
        product_stable_id: "prd_reviewed_omega", destination_url: "https://shop.example.com/omega",
        tracking_metadata_json: JSON.stringify({ campaign: "reviewed" }),
      }],
    ]);
    const page = await createAwsGovernedCatalogReader(db.value, "synthetic-staging")
      .listProducts({ limit: 50, audience: "consumer" });
    expect(page.products).toHaveLength(1);
    expect(page.products[0]?.label).toBeUndefined();
    expect(page.products[0]?.directOrderAllowed).toBe(false);
    expect(page.commercial.offers).toEqual([]);
  });

  test("never describes a failed backend as an empty catalog", async () => {
    const value: ClinicalCoreDatabase = { async transaction() { throw new Error("provider detail"); } };
    await expect(createAwsGovernedCatalogReader(value, "production-clinical").listProducts({ limit: 50, currentWorkforce }))
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
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProducts({ limit: 50, currentWorkforce }))
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
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProtocolTemplates({ limit: 50, currentWorkforce }))
      .rejects.toMatchObject({ category: "catalog_response_invalid" });
  });

  test("production workforce reads refuse without current identity before querying the catalog", async () => {
    const db = database([]);
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProducts({ limit: 50 }))
      .rejects.toMatchObject({ category: "identity_refused" });
    await expect(createAwsGovernedCatalogReader(db.value, "production-clinical").listProtocolTemplates({ limit: 50 }))
      .rejects.toMatchObject({ category: "identity_refused" });
    expect(db.calls).toEqual([]);
  });

  test("a membership refusal prevents catalog access in the same transaction", async () => {
    const calls: string[] = [];
    const value: ClinicalCoreDatabase = { async transaction(work) {
      return work({ async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<ClinicalCoreQueryResult<Row>> {
        calls.push(sql);
        throw new ClinicalCoreDatabaseRejection("identity_refused");
      } });
    } };
    await expect(createAwsGovernedCatalogReader(value, "production-clinical").listProducts({ limit: 50, currentWorkforce }))
      .rejects.toMatchObject({ category: "identity_refused" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("set_current_workforce_context");
  });

  test("a production schema without the standalone catalog contract refuses even an empty page", async () => {
    const calls: string[] = [];
    const value: ClinicalCoreDatabase = { async transaction(work) {
      return work({ async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<ClinicalCoreQueryResult<Row>> {
        calls.push(sql);
        if (sql.includes("to_regclass")) return { rows: [{ compatible: false }] as unknown as Row[] };
        return { rows: [] };
      } });
    } };
    await expect(createAwsGovernedCatalogReader(value, "production-clinical").listProducts({ limit: 50, currentWorkforce }))
      .rejects.toMatchObject({ category: "catalog_unavailable" });
    await expect(createAwsGovernedCatalogReader(value, "production-clinical").listProducts({ limit: 50, audience: "consumer" }))
      .rejects.toMatchObject({ category: "catalog_unavailable" });
    await expect(createAwsGovernedCatalogReader(value, "production-clinical").listProtocolTemplates({ limit: 50, currentWorkforce }))
      .rejects.toMatchObject({ category: "catalog_unavailable" });
    expect(calls.filter(sql => sql.includes("to_regclass"))).toHaveLength(3);
    expect(calls.some(sql => sql.includes("from clinical_reference.catalog_product_versions"))).toBe(false);
    expect(calls.some(sql => sql.includes("from clinical_reference.protocol_template_versions"))).toBe(false);
  });
});
