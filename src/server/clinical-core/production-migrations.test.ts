import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
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
          table_count: 42,
          contract_count: 25,
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
  it("queues patient-reported intake for review and exposes only the bounded patient view", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260825140000_production_consumer_health_intake_review.sql",
    ), "utf8");
    expect(sql).toContain("Patient app health intake update");
    expect(sql).toContain("clinical_private.require_clinical_patient");
    expect(sql).toContain("scope = 'forms_checkins'");
    expect(sql).toContain("distinct on (r.record_key)");
    expect(sql).not.toMatch(/insert into clinical_core\.patient_records/i);
  });

  it("keeps the patient protocol migration tenant-scoped, immutable, and commercially separated", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260824130000_production_patient_protocols.sql",
    ), "utf8");
    for (const table of [
      "patient_protocols", "patient_protocol_versions", "patient_protocol_phases", "patient_protocol_items",
    ]) {
      expect(sql).toContain(`alter table clinical_core.${table} enable row level security`);
    }
    for (const contract of [
      "get_patient_protocol", "create_protocol_draft", "save_protocol_draft",
      "approve_protocol_version", "activate_protocol_version", "set_protocol_lifecycle",
      "revise_protocol_version",
    ]) {
      expect(sql).toContain(`function clinical_core.${contract}`);
    }
    expect(sql).toContain("clinical_private.require_clinical_patient");
    expect(sql).toContain("protocol_version_immutable");
    expect(sql).toContain("governed_product_review_required");
    expect(sql).toMatch(/affiliateUrl\|destinationUrl\|discountCode\|trackingCode/);
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+public/i);
  });

  it("keeps patient sync durable, consent-bound, review-gated, and delivery disabled", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260825100000_production_patient_sync_delivery_controls.sql",
    ), "utf8");
    for (const table of [
      "sync_outbound_events", "sync_inbound_events", "sync_inbound_corrections",
      "sync_dead_letters", "sync_conflicts", "sync_resource_acks",
    ]) expect(sql).toContain(`alter table clinical_core.${table}`);
    for (const contract of [
      "queue_sync_export", "withdraw_sync_resource", "retry_sync_event", "cancel_sync_event",
      "resolve_sync_conflict", "review_sync_inbound", "record_sync_inbound_correction",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    expect(sql).toContain("active_sync_provider_required");
    expect(sql).toContain("consent_required");
    expect(sql).toContain("consent_revoke_cancels_sync");
    expect(sql).toContain("chartMaterialized',false");
    expect(sql).toContain("deliveryEnabled',false");
    expect(sql).toContain("sync_inbound_corrections_append_only");
    expect(sql).toContain("governed_product_review_required");
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+public/i);
  });

  it("keeps the AWS sync worker least-privileged, review-first, and inactive by default", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260825120000_production_patient_sync_worker.sql",
    ), "utf8");
    for (const table of [
      "sync_delivery_attempts", "sync_delivery_events", "sync_worker_cycles",
      "sync_circuit_states", "sync_callback_nonces", "sync_inbound_lab_imports",
    ]) expect(sql).toContain(`alter table clinical_core.${table} enable row level security`);
    for (const contract of [
      "register_sync_provider", "review_sync_provider", "claim_sync_outbound",
      "recheck_sync_export", "record_sync_delivery", "record_sync_inbound",
      "record_sync_lab_result", "record_sync_worker_cycle", "register_sync_callback_nonce",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    expect(sql).toContain("clinical_sync_worker nologin noinherit");
    expect(sql).toContain("state='pending_review'");
    expect(sql).toContain("m.role in('owner','admin')");
    expect(sql).toContain("lab_import_consent_required");
    expect(sql).toContain("chartMaterialized',false");
    expect(sql).toContain("deliveryEnabled',false");
    expect(sql).toContain("for update of e skip locked");
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+public/i);
  });

  it("projects lab summaries from the governed observation timestamp", () => {
    const sql = readFileSync(path.join(process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260825123000_production_sync_lab_summary_observed_at.sql"), "utf8");
    expect(sql).toContain("max(o.observed_at)");
    expect(sql).toContain("'lastObservedAt'");
    expect(sql).not.toContain("max(o.collected_at)");
  });

  it("applies ordered statements and verifies the empty PHI-disabled readiness state", async () => {
    const harness = databaseFor();
    const result = await applyProductionClinicalCoreMigrations(harness.database, [migration]);
    expect(result).toEqual({
      applied: [migration.version],
      alreadyApplied: [],
      tableCount: 42,
      contractCount: 25,
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
    const harness = databaseFor({ verification: { table_count: 42, contract_count: 25, clinical_row_count: 1 } });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toMatchObject({ category: "verification_failed" });
  });

  it("reports a bounded migration location without leaking database detail", async () => {
    const harness = databaseFor({ failOn: "create index" });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toEqual(new ProductionClinicalCoreMigrationError("migration_failed", migration.version, 2));
  });
});
