import { describe, expect, it } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";
import type { ClinicalCoreMigration } from "./migrations";
import {
  applyProductionClinicalCoreMigrations,
  ProductionClinicalCoreMigrationError,
} from "./production-migrations";

const migration: ClinicalCoreMigration = {
  version: "20260821050000",
  name: "production_patient_directory",
  sql: "create table clinical_core.example(id uuid); create index example_id_idx on clinical_core.example(id);",
  sha256: "a".repeat(64),
};

function databaseFor(options: {
  existing?: Array<{ version: string; sha256: string }>;
  verification?: { table_count: number; contract_count: number; clinical_row_count: number };
  failOn?: string;
} = {}) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: ClinicalCoreTransaction = {
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      statements.push({ sql, values });
      if (options.failOn && sql.includes(options.failOn)) throw new Error("database detail must not escape");
      if (sql.startsWith("select version")) {
        return { rows: (options.existing ?? []) as unknown as Row[] };
      }
      if (sql.startsWith("select\n      (select count(*)")) {
        return { rows: [{
          table_count: 18,
          contract_count: 2,
          clinical_row_count: 0,
          ...options.verification,
        }] as unknown as Row[] };
      }
      return { rows: [] };
    },
  };
  const database: ClinicalCoreDatabase = { transaction: async (work) => work(tx) };
  return { database, statements };
}

describe("production clinical-core migrations", () => {
  it("applies ordered statements and verifies the empty PHI-disabled readiness state", async () => {
    const harness = databaseFor();
    const result = await applyProductionClinicalCoreMigrations(harness.database, [migration]);
    expect(result).toEqual({
      applied: [migration.version],
      alreadyApplied: [],
      tableCount: 18,
      contractCount: 2,
      clinicalRowCount: 0,
    });
    expect(harness.statements.map(({ sql }) => sql)).toContain("create table clinical_core.example(id uuid)");
    expect(harness.statements.map(({ sql }) => sql)).toContain("create index example_id_idx on clinical_core.example(id)");
  });

  it("refuses rewritten migration history", async () => {
    const harness = databaseFor({ existing: [{ version: migration.version, sha256: "b".repeat(64) }] });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toMatchObject({
        category: "history_mismatch",
        version: migration.version,
      });
  });

  it("refuses to commit when any clinical record exists", async () => {
    const harness = databaseFor({ verification: { table_count: 18, contract_count: 2, clinical_row_count: 1 } });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toMatchObject({ category: "verification_failed" });
  });

  it("reports a bounded migration location without leaking database detail", async () => {
    const harness = databaseFor({ failOn: "create index" });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toEqual(new ProductionClinicalCoreMigrationError("migration_failed", migration.version, 2));
  });
});
