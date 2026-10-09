if (typeof window !== "undefined") {
  throw new Error("clinical-core/catalog-migrations is server-only.");
}

import path from "node:path";
import { createHash } from "node:crypto";
import type { ClinicalCoreDatabase } from "./database";
import { applyClinicalCoreMigrations, loadClinicalCoreMigrations, type ClinicalCoreMigration } from "./migrations";

export function loadGovernedCatalogMigrations(
  directory = path.join(process.cwd(), "infra", "aws-clinical-core", "catalog-migrations"),
): ClinicalCoreMigration[] {
  return loadClinicalCoreMigrations(directory);
}

/** Explicit historical input for retired operators and predecessor tests only.
 * Runtime setup and new imports use the complete current manifest above. */
export function loadHistoricalGovernedCatalogMigrations(
  directory = path.join(process.cwd(), "infra", "aws-clinical-core", "catalog-migrations"),
): ClinicalCoreMigration[] {
  const migrations = loadClinicalCoreMigrations(directory, "historical-catalog-parent-2.json");
  const rows = migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
  if (migrations.length !== 2 || createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    !== "83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62") {
    throw new Error("historical_catalog_parent_refused");
  }
  return migrations;
}

export function applyGovernedCatalogMigrations(
  database: ClinicalCoreDatabase,
  migrations = loadGovernedCatalogMigrations(),
) {
  return applyClinicalCoreMigrations(database, migrations, {
    schema: "clinical_reference",
    table: "schema_migrations",
    advisoryLock: "ai-desktop-pro:governed-catalog-migrations",
  });
}
