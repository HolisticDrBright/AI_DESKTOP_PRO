import { describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import { applyGovernedCatalogMigrations, loadGovernedCatalogMigrations } from "./catalog-migrations";

function database() {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const value: ClinicalCoreDatabase = {
    async transaction(work) {
      return work({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          parameters: readonly unknown[] = [],
        ): Promise<ClinicalCoreQueryResult<Row>> {
          calls.push({ sql, parameters });
          return { rows: [] };
        },
      });
    },
  };
  return { value, calls };
}

describe("governed reference catalog migration ledger", () => {
  test("is independent from the synthetic identity ledger", () => {
    const migrations = loadGovernedCatalogMigrations();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      version: "20260819173000",
      name: "governed_reference_catalog",
    });
    expect(migrations[0]!.sql).toContain("create table clinical_reference.catalog_products");
    expect(migrations[0]!.sql).not.toMatch(/^\s*(begin|commit|rollback)\s*;/gim);
  });

  test("uses a distinct lock and ledger schema", async () => {
    const db = database();
    await expect(applyGovernedCatalogMigrations(db.value)).resolves.toEqual({
      applied: ["20260819173000"], alreadyApplied: [],
    });
    expect(db.calls[0]!.parameters).toEqual(["ai-desktop-pro:governed-catalog-migrations"]);
    expect(db.calls.some((call) => call.sql.includes("clinical_reference.schema_migrations"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("synthetic_identity_consent"))).toBe(false);
  });
});
