if (typeof window !== "undefined") {
  throw new Error("clinical-core/production-migrations is server-only.");
}

import type { ClinicalCoreDatabase } from "./database";
import type { ClinicalCoreMigration } from "./migrations";
import { splitPostgresStatements } from "./migrations";

export class ProductionClinicalCoreMigrationError extends Error {
  constructor(
    readonly category: "history_mismatch" | "migration_failed" | "verification_failed",
    readonly version?: string,
    readonly statementIndex?: number,
  ) {
    super(category);
    this.name = "ProductionClinicalCoreMigrationError";
  }
}

export type ProductionClinicalCoreMigrationResult = {
  applied: string[];
  alreadyApplied: string[];
  tableCount: number;
  contractCount: number;
  clinicalRowCount: number;
};

/**
 * Apply the portable production schema atomically. No organization, identity,
 * patient, consent, clinical, or provider rows may exist at this readiness
 * stage; that invariant is checked before the transaction can commit.
 */
export async function applyProductionClinicalCoreMigrations(
  database: ClinicalCoreDatabase,
  migrations: ClinicalCoreMigration[],
): Promise<ProductionClinicalCoreMigrationResult> {
  return database.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [
      "ai-desktop-pro:production-clinical-core-migrations",
    ]);
    await tx.query("create schema if not exists clinical_core");
    await tx.query(`create table if not exists clinical_core.schema_migrations (
      version text primary key,
      name text not null,
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default clock_timestamp()
    )`);
    const existing = await tx.query<{ version: string; sha256: string }>(
      "select version, sha256 from clinical_core.schema_migrations order by version",
    );
    const byVersion = new Map(existing.rows.map((row) => [row.version, row.sha256]));
    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrations) {
      const recorded = byVersion.get(migration.version);
      if (recorded) {
        if (recorded !== migration.sha256) {
          throw new ProductionClinicalCoreMigrationError("history_mismatch", migration.version);
        }
        alreadyApplied.push(migration.version);
        continue;
      }
      const statements = splitPostgresStatements(migration.sql);
      for (const [index, statement] of statements.entries()) {
        try {
          await tx.query(statement);
        } catch {
          throw new ProductionClinicalCoreMigrationError("migration_failed", migration.version, index + 1);
        }
      }
      await tx.query(
        "insert into clinical_core.schema_migrations(version,name,sha256) values ($1,$2,$3)",
        [migration.version, migration.name, migration.sha256],
      );
      applied.push(migration.version);
    }

    const verification = await tx.query<{
      table_count: number;
      contract_count: number;
      clinical_row_count: number;
    }>(`select
      (select count(*) from information_schema.tables
        where table_schema in ('clinical_core','clinical_audit')
          and table_name <> 'schema_migrations')::int as table_count,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'clinical_core'
          and p.proname in ('create_patient_profile','review_biomarker','get_patient_protocol',
            'create_protocol_draft','save_protocol_draft','approve_protocol_version',
            'activate_protocol_version','set_protocol_lifecycle','revise_protocol_version',
            'queue_sync_export','withdraw_sync_resource','retry_sync_event','cancel_sync_event',
            'resolve_sync_conflict','review_sync_inbound','record_sync_inbound_correction',
            'register_sync_provider','review_sync_provider','claim_sync_outbound','recheck_sync_export',
            'record_sync_delivery','record_sync_inbound','record_sync_lab_result',
            'record_sync_worker_cycle','register_sync_callback_nonce',
            'list_protocol_templates','create_protocol_template','approve_protocol_template_version',
            'archive_protocol_template','search_protocol_catalog','check_protocol_interactions',
            'review_protocol_item_interactions'))::int as contract_count,
      (
        (select count(*) from clinical_core.organizations)
        + (select count(*) from clinical_core.persons)
        + (select count(*) from clinical_core.identities)
        + (select count(*) from clinical_core.organization_memberships)
        + (select count(*) from clinical_core.patient_records)
        + (select count(*) from clinical_core.patient_connections)
        + (select count(*) from clinical_core.consent_artifacts)
        + (select count(*) from clinical_core.consent_grants)
        + (select count(*) from clinical_core.sync_providers)
        + (select count(*) from clinical_core.lab_import_events)
        + (select count(*) from clinical_core.lab_observations)
        + (select count(*) from clinical_core.consumer_clinical_record_versions)
        + (select count(*) from clinical_core.privacy_requests)
        + (select count(*) from clinical_core.review_queue_items)
        + (select count(*) from clinical_core.appointments)
        + (select count(*) from clinical_core.appointment_status_events)
        + (select count(*) from clinical_core.encounters)
        + (select count(*) from clinical_core.clinical_notes)
        + (select count(*) from clinical_core.clinical_note_versions)
        + (select count(*) from clinical_core.note_signatures)
        + (select count(*) from clinical_core.note_addenda)
        + (select count(*) from clinical_core.note_provenance_refs)
        + (select count(*) from clinical_core.patient_protocols)
        + (select count(*) from clinical_core.patient_protocol_versions)
        + (select count(*) from clinical_core.patient_protocol_phases)
        + (select count(*) from clinical_core.patient_protocol_items)
        + (select count(*) from clinical_core.protocol_templates)
        + (select count(*) from clinical_core.protocol_template_versions)
        + (select count(*) from clinical_core.sync_outbound_events)
        + (select count(*) from clinical_core.sync_inbound_events)
        + (select count(*) from clinical_core.sync_inbound_corrections)
        + (select count(*) from clinical_core.sync_dead_letters)
        + (select count(*) from clinical_core.sync_conflicts)
        + (select count(*) from clinical_core.sync_resource_acks)
        + (select count(*) from clinical_core.sync_delivery_attempts)
        + (select count(*) from clinical_core.sync_delivery_events)
        + (select count(*) from clinical_core.sync_worker_cycles)
        + (select count(*) from clinical_core.sync_circuit_states)
        + (select count(*) from clinical_core.sync_callback_nonces)
        + (select count(*) from clinical_core.sync_inbound_lab_imports)
      )::int as clinical_row_count`);
    const row = verification.rows[0];
    if (!row || Number(row.table_count) !== 44 || Number(row.contract_count) !== 32
      || Number(row.clinical_row_count) !== 0) {
      throw new ProductionClinicalCoreMigrationError("verification_failed");
    }
    return {
      applied,
      alreadyApplied,
      tableCount: Number(row.table_count),
      contractCount: Number(row.contract_count),
      clinicalRowCount: Number(row.clinical_row_count),
    };
  });
}
