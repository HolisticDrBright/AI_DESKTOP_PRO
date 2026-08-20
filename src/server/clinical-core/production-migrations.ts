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
          and p.proname in ('create_patient_profile','review_biomarker'))::int as contract_count,
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
      )::int as clinical_row_count`);
    const row = verification.rows[0];
    if (!row || Number(row.table_count) !== 18 || Number(row.contract_count) !== 2
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
