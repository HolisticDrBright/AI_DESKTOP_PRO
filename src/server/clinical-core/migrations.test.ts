import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import {
  ClinicalCoreMigrationError,
  applyClinicalCoreMigrations,
  loadClinicalCoreMigrations,
} from "./migrations";

const temporaryDirectories: string[] = [];

function migrationDatabase(existing: Array<{ version: string; sha256: string }> = []) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  let transactions = 0;
  const database: ClinicalCoreDatabase = {
    async transaction(work) {
      transactions += 1;
      return work({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          parameters: readonly unknown[] = [],
        ): Promise<ClinicalCoreQueryResult<Row>> {
          calls.push({ sql, parameters });
          if (sql.includes("select version, sha256")) {
            return { rows: existing as unknown as Row[] };
          }
          return { rows: [] };
        },
      });
    },
  };
  return { database, calls, transactions: () => transactions };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AWS clinical-core migration runner", () => {
  test("loads ordered migrations and computes their content hash", () => {
    const migrations = loadClinicalCoreMigrations();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      version: "20260812010000",
      name: "synthetic_identity_consent",
    });
    expect(migrations[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]!.sql).toContain("create table clinical_core.persons");
  });

  test("serializes and applies a missing migration in one transaction", async () => {
    const db = migrationDatabase();
    const result = await applyClinicalCoreMigrations(db.database);
    expect(result).toEqual({ applied: ["20260812010000"], alreadyApplied: [] });
    expect(db.transactions()).toBe(1);
    expect(db.calls[0]!.sql).toContain("pg_advisory_xact_lock");
    expect(db.calls.some((call) => call.sql.includes("create table clinical_core.persons"))).toBe(true);
    expect(db.calls.at(-1)!.sql).toContain("insert into clinical_core.schema_migrations");
  });

  test("does not reapply a migration whose recorded hash matches", async () => {
    const migration = loadClinicalCoreMigrations()[0]!;
    const db = migrationDatabase([{ version: migration.version, sha256: migration.sha256 }]);
    await expect(applyClinicalCoreMigrations(db.database, [migration])).resolves.toEqual({
      applied: [],
      alreadyApplied: [migration.version],
    });
    expect(db.calls.some((call) => call.sql === migration.sql)).toBe(false);
  });

  test("refuses rewritten migration history", async () => {
    const migration = loadClinicalCoreMigrations()[0]!;
    const db = migrationDatabase([{ version: migration.version, sha256: "0".repeat(64) }]);
    await expect(applyClinicalCoreMigrations(db.database, [migration]))
      .rejects.toMatchObject({ category: "history_mismatch" });
  });

  test("refuses an unordered or mismatched manifest", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clinical-core-migrations-"));
    temporaryDirectories.push(directory);
    writeFileSync(path.join(directory, "20260812020000_second.sql"), "select 2;");
    writeFileSync(path.join(directory, "20260812010000_first.sql"), "select 1;");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
      contract_version: "clinical-core-migrations/1",
      migrations: [
        { version: "20260812020000", file: "20260812020000_second.sql" },
        { version: "20260812010000", file: "20260812010000_first.sql" },
      ],
    }));
    expect(() => loadClinicalCoreMigrations(directory)).toThrow(ClinicalCoreMigrationError);
  });

  test("the committed migration contains no transaction-control statements", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql"),
      "utf8",
    );
    expect(sql).not.toMatch(/^\s*(begin|commit|rollback)\s*;/gim);
  });
});
