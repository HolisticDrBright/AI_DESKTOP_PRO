import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ClinicalCoreDatabase, ClinicalCoreQueryResult } from "./database";
import {
  ClinicalCoreMigrationError,
  applyClinicalCoreMigrations,
  loadClinicalCoreMigrations,
  splitPostgresStatements,
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
    expect(migrations).toHaveLength(15);
    expect(migrations[0]).toMatchObject({
      version: "20260812010000",
      name: "synthetic_identity_consent",
    });
    expect(migrations[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]!.sql).toContain("create table clinical_core.persons");
    expect(migrations[1]).toMatchObject({
      version: "20260812220000",
      name: "identity_function_column_qualification",
    });
    expect(migrations[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[2]).toMatchObject({
      version: "20260821010000",
      name: "governed_synthetic_lab_import",
    });
    expect(migrations[2]!.sql).toContain("create table clinical_core.lab_import_events");
    expect(migrations[2]!.sql).toContain("'lab_results_import'");
    expect(migrations[3]).toMatchObject({
      version: "20260821020000",
      name: "consumer_connection_posture",
    });
    expect(migrations[4]).toMatchObject({
      version: "20260821030000",
      name: "consumer_clinical_records_privacy",
    });
    expect(migrations[4]!.sql).toContain("create table clinical_core.consumer_clinical_record_versions");
    expect(migrations[5]).toMatchObject({
      version: "20260821040000",
      name: "desktop_compatibility_boundary",
    });
    expect(migrations[5]!.sql).toContain("create table clinical_core.desktop_compatibility_operations");
    expect(migrations[5]!.sql).toContain("compatibility_operation_not_ported");
    expect(migrations[6]).toMatchObject({
      version: "20260821045000",
      name: "consumer_health_intake_records",
    });
    expect(migrations[6]!.sql).toContain("'clinical_intakes'");
    expect(migrations[6]!.sql).toContain("when 'wellness_profiles' then 'forms_checkins'");
    expect(migrations[7]).toMatchObject({
      version: "20260821046000",
      name: "consumer_wearable_records",
    });
    expect(migrations[7]!.sql).toContain("'wearable_daily_records'");
    expect(migrations[7]!.sql).toContain("when 'wearable_daily_records' then 'wearables'");
    expect(migrations[8]).toMatchObject({
      version: "20260821047000",
      name: "self_service_consumer_identity",
    });
    expect(migrations[8]!.sql).toContain("bootstrap_self_service_consumer");
    expect(migrations[9]).toMatchObject({
      version: "20260821048000",
      name: "reproductive_health_consent",
    });
    expect(migrations[9]!.sql).toContain("'reproductive_health'");
    expect(migrations[10]).toMatchObject({
      version: "20260821049000",
      name: "patient_chat_context",
    });
    expect(migrations[10]!.sql).toContain("get_patient_chat_context");
    expect(migrations[11]).toMatchObject({
      version: "20260821049500",
      name: "consumer_family_access",
    });
    expect(migrations[12]).toMatchObject({
      version: "20260821049700",
      name: "synthetic_workforce_organization_directory",
    });
    expect(migrations[12]!.sql).toContain("clinical_compatibility.list_my_organizations_v1");
    expect(migrations[12]!.sql).toContain("membership.person_id = clinical_private.actor_person_id()");
    expect(migrations[12]!.sql).toContain("organization.contains_phi = false");
    expect(migrations[13]).toMatchObject({
      version: "20260821049800",
      name: "synthetic_patient_directory_create",
    });
    expect(migrations[13]!.sql).toContain("clinical_compatibility.create_patient_profile_v1");
    expect(migrations[13]!.sql).toContain("_date_of_birth', null");
    expect(migrations[13]!.sql).toContain("synthetic_patient.created");
    expect(migrations[14]).toMatchObject({
      version: "20260821049900",
      name: "synthetic_patient_directory_request_repair",
    });
    expect(migrations[14]!.sql).toContain("from jsonb_object_keys(_request)");
  });

  test("serializes and applies a missing migration in one transaction", async () => {
    const db = migrationDatabase();
    const result = await applyClinicalCoreMigrations(db.database);
    expect(result).toEqual({
      applied: ["20260812010000", "20260812220000", "20260821010000", "20260821020000", "20260821030000", "20260821040000", "20260821045000", "20260821046000", "20260821047000", "20260821048000", "20260821049000", "20260821049500", "20260821049700", "20260821049800", "20260821049900"],
      alreadyApplied: [],
    });
    expect(db.transactions()).toBe(1);
    expect(db.calls[0]!.sql).toContain("pg_advisory_xact_lock");
    expect(db.calls.some((call) => call.sql.includes("create table clinical_core.persons"))).toBe(true);
    expect(db.calls.at(-1)!.sql).toContain("insert into clinical_core.schema_migrations");
    expect(db.calls.some((call) => call.sql === loadClinicalCoreMigrations()[0]!.sql)).toBe(false);
    expect(db.calls.filter((call) => call.sql.startsWith("create table clinical_core.")).length).toBeGreaterThan(5);
  }, 15_000);

  test("does not reapply a migration whose recorded hash matches", async () => {
    const migration = loadClinicalCoreMigrations()[0]!;
    const db = migrationDatabase([{ version: migration.version, sha256: migration.sha256 }]);
    await expect(applyClinicalCoreMigrations(db.database, [migration])).resolves.toEqual({
      applied: [],
      alreadyApplied: [migration.version],
    });
    expect(db.calls.some((call) => call.sql.includes("create table clinical_core.persons"))).toBe(false);
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

  test("uses the same migration identity for LF and CRLF checkouts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "clinical-core-line-endings-"));
    temporaryDirectories.push(directory);
    const migrationPath = path.join(directory, "20260812010000_first.sql");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
      contract_version: "clinical-core-migrations/1",
      migrations: [{ version: "20260812010000", file: "20260812010000_first.sql" }],
    }));
    writeFileSync(migrationPath, "select 1;\nselect 2;\n");
    const lf = loadClinicalCoreMigrations(directory)[0]!;
    writeFileSync(migrationPath, "select 1;\r\nselect 2;\r\n");
    const crlf = loadClinicalCoreMigrations(directory)[0]!;
    expect(crlf.sha256).toBe(lf.sha256);
    expect(crlf.sql).toBe(lf.sql);
  });

  test("the committed migration contains no transaction-control statements", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql"),
      "utf8",
    );
    expect(sql).not.toMatch(/^\s*(begin|commit|rollback)\s*;/gim);
  });

  test("splits PostgreSQL while preserving function bodies, quotes, and nested comments", () => {
    const statements = splitPostgresStatements(`
      -- semicolon ; in a comment
      create table demo(value text default 'a;''b');
      select E'escaped\\';semicolon';
      create function demo_fn() returns text language plpgsql as $body$
      begin
        /* nested ; /* still ; */ done */
        return 'inside;function';
      end
      $body$;
      select "semi;colon" from demo;
    `);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain("'a;''b'");
    expect(statements[1]).toContain("escaped");
    expect(statements[2]).toContain("return 'inside;function';");
    expect(statements[3]).toContain('"semi;colon"');
  });

  test("refuses unterminated quoted migration source", () => {
    expect(() => splitPostgresStatements("select $body$ unfinished"))
      .toThrowError(ClinicalCoreMigrationError);
  });
});
