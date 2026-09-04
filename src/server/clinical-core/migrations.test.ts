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
    expect(migrations).toHaveLength(29);
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
    expect(migrations[15]).toMatchObject({
      version: "20260903010000",
      name: "synthetic_wearable_consent_artifact",
    });
    expect(migrations[15]!.sql).toContain("'synthetic-wearables/1'");
    expect(migrations[15]!.sql).toContain("organization.contains_phi = false");
    expect(migrations[16]).toMatchObject({
      version: "20260903020000",
      name: "synthetic_patient_app_intake_read",
    });
    expect(migrations[16]!.sql).toContain("clinical_core.get_patient_app_intake");
    expect(migrations[16]!.sql).toContain("'labImports'");
    expect(migrations[16]!.sql).toContain("p.contains_phi = false");
    expect(migrations[17]).toMatchObject({
      version: "20260903030000",
      name: "register_synthetic_patient_app_intake",
    });
    expect(migrations[17]!.sql).toContain("clinical_compatibility.get_patient_app_intake_v1");
    expect(migrations[17]!.sql).toContain("'rpc', 'get_patient_app_intake'");
    expect(migrations[17]!.sql).toContain("enabled = false");
    expect(migrations[18]).toMatchObject({
      version: "20260903060000",
      name: "synthetic_workforce_identity_aliases",
    });
    expect(migrations[18]!.sql).toContain("create table clinical_core.synthetic_workforce_identity_aliases");
    expect(migrations[18]!.sql).toContain("_identity_pool = 'workforce'");
    expect(migrations[18]!.sql).toContain("alias.reviewed_at is not null");
    expect(migrations[18]!.sql).toContain("revoke all on clinical_core.synthetic_workforce_identity_aliases from public, clinical_core_api");
    expect(migrations[19]).toMatchObject({
      version: "20260903070000",
      name: "governed_patient_chat",
    });
    expect(migrations[19]!.sql).toContain("create table clinical_core.patient_chat_conversations");
    expect(migrations[19]!.sql).toContain("clinical_core.patient_chat_request");
    expect(migrations[19]!.sql).toContain("contains_phi=false");
    expect(migrations[20]).toMatchObject({
      version: "20260903163000",
      name: "synthetic_desktop_calendar",
    });
    expect(migrations[20]!.sql).toContain("clinical_core.get_desktop_calendar");
    expect(migrations[20]!.sql).toContain("clinical_private.assert_synthetic_context");
    expect(migrations[20]!.sql).not.toContain("clinical_private.assert_production_context");
    expect(migrations[21]).toMatchObject({
      version: "20260903170000",
      name: "register_synthetic_desktop_calendar",
    });
    expect(migrations[21]!.sql).toContain("clinical_compatibility.get_desktop_calendar_v1");
    expect(migrations[21]!.sql).toContain("enabled=false");
    expect(migrations[22]).toMatchObject({
      version: "20260903180000",
      name: "synthetic_patient_app_lab_ranges",
    });
    expect(migrations[22]!.sql).toContain("'referenceMin', e.reference_min");
    expect(migrations[22]!.sql).toContain("'functionalMin', null");
    expect(migrations[22]!.sql).toContain("get_patient_app_intake_base_v1");
    expect(migrations[23]).toMatchObject({
      version: "20260903200000",
      name: "synthetic_desktop_programs_inbox",
    });
    expect(migrations[23]!.sql).toContain("clinical_compatibility.synthetic_programs_v1");
    expect(migrations[23]!.sql).toContain("clinical_compatibility.synthetic_inbox_v1");
    expect(migrations[23]!.sql).toContain("provider_not_configured");
    expect(migrations[24]).toMatchObject({
      version: "20260903201000",
      name: "register_synthetic_desktop_programs_inbox",
    });
    expect(migrations[24]!.sql).toContain("'list_programs','synthetic_programs_v1'");
    expect(migrations[24]!.sql).toContain("'list_inbox','synthetic_inbox_v1'");
    expect(migrations[24]!.sql).toContain("enabled=false");
    expect(migrations[25]).toMatchObject({
      version: "20260903202000",
      name: "synthetic_desktop_programs_inbox_handler_hashes",
    });
    expect(migrations[25]!.sql).toContain("pg_get_functiondef");
    expect(migrations[26]).toMatchObject({
      version: "20260903210000",
      name: "synthetic_review_billing_workspaces",
    });
    expect(migrations[26]!.sql).toContain("clinical_core.list_review_queue");
    expect(migrations[26]!.sql).toContain("clinical_core.invoke_billing_operation");
    expect(migrations[27]).toMatchObject({
      version: "20260903211000",
      name: "register_synthetic_review_billing",
    });
    expect(migrations[27]!.sql).toContain("clinical_compatibility.synthetic_review_billing_v1");
    expect(migrations[27]!.sql).toContain("false, null, null");
    expect(migrations[28]).toMatchObject({
      version: "20260904090000",
      name: "independent_consumer_chat_context",
    });
    expect(migrations[28]!.sql).toContain("get_patient_chat_context_before_independent_consumer");
    expect(migrations[28]!.sql).toContain("'labs','[]'::jsonb");
  });

  test("serializes and applies a missing migration in one transaction", async () => {
    const db = migrationDatabase();
    const result = await applyClinicalCoreMigrations(db.database);
    expect(result).toEqual({
      applied: ["20260812010000", "20260812220000", "20260821010000", "20260821020000", "20260821030000", "20260821040000", "20260821045000", "20260821046000", "20260821047000", "20260821048000", "20260821049000", "20260821049500", "20260821049700", "20260821049800", "20260821049900", "20260903010000", "20260903020000", "20260903030000", "20260903060000", "20260903070000", "20260903163000", "20260903170000", "20260903180000", "20260903200000", "20260903201000", "20260903202000", "20260903210000", "20260903211000", "20260904090000"],
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
