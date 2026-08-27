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
          table_count: 72,
          contract_count: 67,
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

  it("keeps reasoning and Lens review-only, source-linked, unseeded, and closed to direct writes", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826130000_production_reasoning_lens_review.sql",
    ), "utf8");
    for (const contract of [
      "get_reasoning_workspace", "review_hypothesis", "list_desktop_lens_paradigms",
      "list_desktop_lens_domains", "list_desktop_lens_knowledge_sources",
      "get_desktop_lens_evaluation", "list_desktop_question_answers", "set_question_status",
      "dismiss_question", "answer_question", "correct_question_answer", "record_question_note_use",
      "submit_question_feedback", "review_safety_block",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    expect(sql).toContain("Internal evidence weighting");
    expect(sql).toContain("not a medical probability");
    expect(sql).toContain("nothing is generated or fabricated");
    expect(sql).toContain("clinical_private.require_reasoning_actor");
    expect(sql).toContain("hypothesis_reviews_append_only");
    expect(sql).toContain("question_answers_append_only");
    expect(sql).toContain("from public,clinical_core_api");
    expect(sql).not.toMatch(/insert into clinical_reference\.clinical_(?:paradigms|domains|knowledge_sources)/i);
    expect(sql).not.toMatch(/function clinical_core\.(?:run|generate|create)_(?:lens|reasoning)/i);
  });

  it("keeps clinical pathways source-gated, human-approved, unseeded, and commercially separated", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826140000_production_clinical_pathway_registry.sql",
    ), "utf8");
    for (const table of ["clinical_pathways", "clinical_pathway_versions"]) {
      expect(sql).toContain(`alter table clinical_core.${table} enable row level security`);
    }
    for (const contract of [
      "list_clinical_pathways", "create_clinical_pathway_draft",
      "update_clinical_pathway_draft", "approve_clinical_pathway_version",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    expect(sql).toContain("clinical_pathway_source_review_required");
    expect(sql).toContain("approved_clinical_pathway_immutable");
    expect(sql).toContain("knowledge_admin_role_required");
    expect(sql).toMatch(/affiliateUrl\|destinationUrl\|discountCode\|trackingCode/);
    expect(sql).not.toMatch(/insert\s+into\s+clinical_core\.clinical_pathways/i);
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+public/i);
  });

  it("keeps clinical knowledge imports no-PHI, human-reviewed, unseeded, and non-approving", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826150000_production_clinical_knowledge_import_review.sql",
    ), "utf8");
    for (const table of ["clinical_knowledge_import_batches", "clinical_knowledge_import_items"]) {
      expect(sql).toContain(`alter table clinical_core.${table} enable row level security`);
    }
    for (const contract of [
      "stage_clinical_knowledge_import", "review_clinical_knowledge_import_item",
      "list_clinical_knowledge_import_batches", "list_clinical_knowledge_import_items",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    expect(sql).toContain("knowledge_import_no_phi_attestation_required");
    expect(sql).toContain("knowledge_import_commercial_data_refused");
    expect(sql).toContain("knowledge_import_source_correction_required");
    expect(sql).toContain("product_label_candidate");
    expect(sql).not.toMatch(/insert\s+into\s+clinical_core\.clinical_knowledge_import_(?:batches|items)\s*\([^)]*\)\s*values\s*\([^_$]/i);
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+public/i);
    const repair = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826151000_production_knowledge_import_url_validation_repair.sql",
    ), "utf8");
    expect(repair).toContain("drop constraint product_label_candidates_source_url_check");
    expect(repair).toContain("char_length(source_url)<=2000");
    expect(repair).not.toContain("{1,1990}");
  });

  it("keeps the Desktop knowledge-import compatibility surface reference-only and activation-neutral", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826170000_production_knowledge_import_compatibility.sql",
    ), "utf8");
    for (const table of ["knowledge_import_conflict_resolutions", "research_handoff_item_reviews"]) {
      expect(sql).toContain(`alter table clinical_core.${table} enable row level security`);
      expect(sql).toContain(`${table}_append_only`);
    }
    for (const contract of [
      "preview_knowledge_import", "get_knowledge_import_preview", "resolve_knowledge_import_conflict",
      "commit_knowledge_import", "cancel_knowledge_import", "list_label_commercial_links",
      "list_protocol_commercial_links", "get_research_handoff_review",
      "record_research_handoff_item_review",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    for (const invariant of [
      "knowledge_import_no_phi_attestation_required", "knowledge_import_commercial_only_refused",
      "knowledge_import_commercial_data_refused", "knowledge_import_conflicts_unresolved",
      "research_handoff_review_required", "approvalState','draft",
      "Commercial links are disclosed separately",
    ]) expect(sql).toContain(invariant);
    const topLevel = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "");
    expect(topLevel).not.toMatch(/insert\s+into\s+(?:clinical_core|clinical_reference|commercial_reference)\./i);
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+public/i);
    expect(sql).not.toContain("set contains_phi=true");
  });

  it("keeps workforce invitations Cognito-bound without storing email addresses or creating accounts", () => {
    const sql = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826160000_production_workforce_invitation_claims.sql",
    ), "utf8");
    expect(sql).toContain("clinical_core.workforce_identity_directory");
    expect(sql).toContain("email_sha256");
    expect(sql).toContain("workforce_identity_not_registered");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("clinical_private.require_organization_admin");
    expect(sql).not.toContain("create user");
    expect(sql).not.toContain("email_canonical");
    const repair = readFileSync(path.join(
      process.cwd(), "infra", "aws-clinical-core", "production-migrations",
      "20260826161000_production_workforce_email_digest_repair.sql",
    ), "utf8");
    expect(repair).toContain("public.digest(_normalized_email,'sha256')");
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
      tableCount: 72,
      contractCount: 67,
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
    const harness = databaseFor({ verification: { table_count: 61, contract_count: 56, clinical_row_count: 1 } });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toMatchObject({ category: "verification_failed" });
  });

  it("reports a bounded migration location without leaking database detail", async () => {
    const harness = databaseFor({ failOn: "create index" });
    await expect(applyProductionClinicalCoreMigrations(harness.database, [migration]))
      .rejects.toEqual(new ProductionClinicalCoreMigrationError("migration_failed", migration.version, 2));
  });
});
