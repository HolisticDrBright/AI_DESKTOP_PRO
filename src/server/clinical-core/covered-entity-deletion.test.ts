import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from "./database";
import {
  COVERED_ENTITY_COVERAGE_RECORD,
  CoveredEntityDeletionError,
  deleteCoveredEntityContent,
  deletionOrder,
  inspectCoveredEntityContent,
  parseCoveredEntityCoverage,
  planCoveredEntityDeletion,
  planCoveredEntityObjectInventory,
  rowPredicate,
  type CoveredEntityCoverage,
} from "./covered-entity-deletion";

const ORGANIZATION = "11111111-2222-4333-8444-555555555555";
const shipped = (): CoveredEntityCoverage =>
  parseCoveredEntityCoverage(JSON.parse(readFileSync("infra/aws-clinical-core/covered-entity-coverage.json", "utf8")));

const small = (): CoveredEntityCoverage => parseCoveredEntityCoverage({
  record: COVERED_ENTITY_COVERAGE_RECORD,
  tables: [
    { table: "clinical_core.notes", scope: "organization_column", column: "organization_id" },
    { table: "clinical_core.note_versions", scope: "parent", column: "note_id", parent: "clinical_core.notes", parentColumn: "id" },
    { table: "clinical_private.captures", scope: "parent", column: "note_id", parent: "clinical_core.note_versions", parentColumn: "id", objectKeyColumns: ["object_key"] },
    { table: "clinical_reference.catalog", scope: "retained", class: "global_reference", reason: "Shared reviewed catalog holding no individual's information." },
  ],
});

const category = (call: () => unknown): string => {
  try { call(); } catch (error) { return error instanceof CoveredEntityDeletionError ? error.category : `unexpected:${String(error)}`; }
  return "no_refusal";
};

type Answer = (sql: string) => { rows?: Record<string, unknown>[]; rowCount?: number };
function database(answer: Answer): { database: ClinicalCoreDatabase; statements: string[] } {
  const statements: string[] = [];
  const tx: ClinicalCoreTransaction = {
    query: async (sql: string) => {
      statements.push(sql);
      const result = answer(sql);
      return { rows: (result.rows ?? []) as never, rowCount: result.rowCount ?? (result.rows?.length ?? 0), columns: [] } as never;
    },
  };
  return { statements, database: { transaction: (work) => work(tx) } };
}

const quiet: Answer = (sql) => sql.startsWith("select count(*)::int as holds") ? { rows: [{ holds: 0 }] }
  : sql.includes("as remaining") ? { rows: [{ remaining: 0 }] }
  : sql.includes("as object_key") ? { rows: [] }
  : { rowCount: 3 };

describe("the shipped coverage manifest", () => {
  it("accounts for the schema and every chain ends at the organization", () => {
    const coverage = shipped();
    expect(coverage.tables.length).toBeGreaterThan(150);
    const scoped = coverage.tables.filter((entry) => entry.scope !== "retained");
    expect(scoped.length).toBeGreaterThan(100);
    for (const entry of scoped) expect(rowPredicate(entry.table, coverage)).toContain("organization_id = $1");
    // Nothing is retained without saying which class it is and why.
    for (const entry of coverage.tables.filter((candidate) => candidate.scope === "retained")) {
      expect(entry).toMatchObject({ class: expect.any(String), reason: expect.any(String) });
    }
  });

  it("deletes a table before anything it points at", () => {
    const coverage = shipped();
    const order = deletionOrder(coverage);
    const position = new Map(order.map((table, index) => [table, index]));
    expect(order.length).toBe(coverage.tables.filter((entry) => entry.scope !== "retained").length);
    for (const entry of coverage.tables) {
      if (entry.scope === "retained") continue;
      for (const dependency of [...(entry.dependsOn ?? []), ...(entry.scope === "parent" ? [entry.parent] : [])]) {
        expect(position.get(entry.table)!).toBeLessThan(position.get(dependency)!);
      }
    }
  });

  it("keeps the individual's own account, the shared catalogs and the organization shell", () => {
    const retained = new Map(shipped().tables.filter((entry) => entry.scope === "retained").map((entry) => [entry.table, entry]));
    expect(retained.get("clinical_core.persons")).toMatchObject({ class: "individual_account" });
    expect(retained.get("clinical_core.owned_consumer_record_versions")).toMatchObject({ class: "individual_account" });
    expect(retained.get("clinical_core.organizations")).toMatchObject({ class: "organization_shell" });
    expect(retained.get("clinical_reference.catalog_products")).toMatchObject({ class: "global_reference" });
    // The clinic's own encounter content is not retained.
    expect(retained.has("clinical_private.recording_transcripts")).toBe(false);
    expect(retained.has("clinical_core.clinical_notes")).toBe(false);
  });
});

describe("reading a coverage manifest", () => {
  it("refuses one that cannot say where a clinic's information is", () => {
    const base = { record: COVERED_ENTITY_COVERAGE_RECORD, tables: [{ table: "a.b", scope: "organization_column", column: "organization_id" }] };
    expect(() => parseCoveredEntityCoverage(base)).not.toThrow();
    for (const bad of [
      null, { record: "other/1", tables: base.tables }, { record: base.record, tables: [] },
      { record: base.record, tables: [{ table: "a.b", scope: "organization_column", column: "organization_id" }, { table: "a.b", scope: "retained", class: "global_reference", reason: "a reason long enough to be a reason" }] },
      { record: base.record, tables: [{ table: "a.b", scope: "parent", column: "c", parent: "a.missing", parentColumn: "id" }] },
      { record: base.record, tables: [{ table: "a.b", scope: "retained", class: "unknown_class", reason: "a reason long enough to be a reason" }] },
      { record: base.record, tables: [{ table: "a.b", scope: "retained", class: "global_reference", reason: "short" }] },
      { record: base.record, tables: [{ table: "a.b", scope: "parent", column: "c", parent: "a.c", parentColumn: "id" }, { table: "a.c", scope: "parent", column: "d", parent: "a.b", parentColumn: "id" }] },
    ]) expect(category(() => parseCoveredEntityCoverage(bad))).toBe("coverage_malformed");
  });

  it("asks the parent's question when a table does not carry the organization", () => {
    const coverage = small();
    expect(rowPredicate("clinical_core.notes", coverage)).toBe("clinical_core.notes.organization_id = $1");
    expect(rowPredicate("clinical_private.captures", coverage)).toBe(
      "clinical_private.captures.note_id in (select clinical_core.note_versions.id from clinical_core.note_versions where "
      + "clinical_core.note_versions.note_id in (select clinical_core.notes.id from clinical_core.notes where clinical_core.notes.organization_id = $1))");
    expect(planCoveredEntityDeletion(coverage).map((step) => step.table))
      .toEqual(["clinical_private.captures", "clinical_core.note_versions", "clinical_core.notes"]);
    expect(planCoveredEntityObjectInventory(coverage)).toHaveLength(1);
  });
});

describe("destroying one covered entity's information", () => {
  const termination = { terminationReference: "clinic-termination/2026-09-22", confirmed: true } as const;

  it("deletes every in-scope table and verifies nothing is left", async () => {
    const { database: db, statements } = database(quiet);
    const report = await deleteCoveredEntityContent({ database: db, organizationId: ORGANIZATION, coverage: small(), termination });
    expect(report.certifies).toEqual({ database: true, objectStores: true });
    expect(report.deleted.map((row) => row.table)).toEqual(["clinical_private.captures", "clinical_core.note_versions", "clinical_core.notes"]);
    expect(report.retained).toEqual([{ class: "global_reference", tables: 1 }]);
    expect(report.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statements.filter((sql) => sql.startsWith("delete"))).toHaveLength(3);
    expect(statements.filter((sql) => sql.includes("as remaining"))).toHaveLength(3);
  });

  it("refuses an unconfirmed termination, an unnamed agreement and a bad organization", async () => {
    const { database: db, statements } = database(quiet);
    const run = (over: Record<string, unknown>) => deleteCoveredEntityContent({
      database: db, organizationId: ORGANIZATION, coverage: small(), termination, ...over,
    } as never);
    await expect(run({ termination: { terminationReference: "clinic-termination/2026-09-22", confirmed: false } })).rejects.toThrow("termination_unconfirmed");
    await expect(run({ termination: { terminationReference: "", confirmed: true } })).rejects.toThrow("termination_unconfirmed");
    await expect(run({ organizationId: "not-a-uuid" })).rejects.toThrow("organization_invalid");
    expect(statements).toEqual([]);
  });

  it("refuses while a legal hold is open on anyone the clinic holds information about", async () => {
    const { database: db, statements } = database((sql) => sql.startsWith("select count(*)::int as holds") ? { rows: [{ holds: 1 }] } : quiet(sql));
    await expect(deleteCoveredEntityContent({ database: db, organizationId: ORGANIZATION, coverage: small(), termination }))
      .rejects.toThrow("legal_hold_present");
    expect(statements.filter((sql) => sql.startsWith("delete"))).toEqual([]);
  });

  it("purges stored objects from an inventory read before any row is deleted, and rolls back if that does not finish", async () => {
    const withObjects: Answer = (sql) => sql.includes("as object_key")
      ? { rows: [{ object_key: "recordings/a" }, { object_key: "recordings/b" }] } : quiet(sql);
    const order: string[] = [];
    const { database: db, statements } = database((sql) => { order.push(sql.split(" ")[0]); return withObjects(sql); });
    const seen: string[][] = [];
    const report = await deleteCoveredEntityContent({
      database: db, organizationId: ORGANIZATION, coverage: small(), termination,
      objects: { purge: async (keys) => { seen.push(keys); return { purged: keys.length, absent: 0, failed: 0 }; } },
    });
    expect(seen).toEqual([["recordings/a", "recordings/b"]]);
    expect(report.objects).toEqual({ inventoried: 2, purged: 2, absent: 0, failed: 0 });
    // The inventory ran before the first delete.
    expect(statements.findIndex((sql) => sql.includes("as object_key"))).toBeLessThan(statements.findIndex((sql) => sql.startsWith("delete")));

    const failing = database(withObjects);
    await expect(deleteCoveredEntityContent({
      database: failing.database, organizationId: ORGANIZATION, coverage: small(), termination,
      objects: { purge: async () => ({ purged: 1, absent: 0, failed: 1 }) },
    })).rejects.toThrow("objects_not_purged");
    expect(failing.statements.filter((sql) => sql.startsWith("delete"))).toEqual([]);
  });

  it("does not certify object stores when it has keys and no purger", async () => {
    const { database: db } = database((sql) => sql.includes("as object_key") ? { rows: [{ object_key: "recordings/a" }] } : quiet(sql));
    const report = await deleteCoveredEntityContent({ database: db, organizationId: ORGANIZATION, coverage: small(), termination });
    expect(report.certifies).toEqual({ database: true, objectStores: false });
    expect(report.objects).toEqual({ inventoried: 1, purged: 0, absent: 0, failed: 0 });
  });

  it("fails the run when content survives the delete", async () => {
    const { database: db } = database((sql) => sql.includes("as remaining") && sql.includes("clinical_core.notes ")
      ? { rows: [{ remaining: 2 }] } : quiet(sql));
    await expect(deleteCoveredEntityContent({ database: db, organizationId: ORGANIZATION, coverage: small(), termination }))
      .rejects.toThrow("content_remains");
  });

  it("refuses an object inventory it cannot stand behind", async () => {
    const { database: db } = database((sql) => sql.includes("as object_key")
      ? { rows: Array.from({ length: 12 }, (_value, index) => ({ object_key: `recordings/${index}` })) } : quiet(sql));
    await expect(deleteCoveredEntityContent({ database: db, organizationId: ORGANIZATION, coverage: small(), termination, objectKeyLimit: 10 }))
      .rejects.toThrow("object_inventory_too_large");
  });

  it("inspects without deleting", async () => {
    const { database: db, statements } = database((sql) => sql.includes("as remaining") && sql.includes("clinical_private.captures")
      ? { rows: [{ remaining: 4 }] } : quiet(sql));
    const report = await inspectCoveredEntityContent({ database: db, organizationId: ORGANIZATION, coverage: small() });
    expect(report.rows).toEqual([{ table: "clinical_private.captures", rows: 4 }]);
    expect(report.holds).toBe(false);
    expect(statements.some((sql) => sql.startsWith("delete"))).toBe(false);
  });
});
