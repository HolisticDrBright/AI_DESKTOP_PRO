if (typeof window !== "undefined") {
  throw new Error("clinical-core/catalog-migrations is server-only.");
}

import path from "node:path";
import type { ClinicalCoreDatabase } from "./database";
import { applyClinicalCoreMigrations, loadClinicalCoreMigrations, type ClinicalCoreMigration } from "./migrations";

export function loadGovernedCatalogMigrations(
  directory = path.join(process.cwd(), "infra", "aws-clinical-core", "catalog-migrations"),
): ClinicalCoreMigration[] {
  return loadClinicalCoreMigrations(directory);
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
