if (typeof window !== "undefined") {
  throw new Error("production-migration-operator is server-only.");
}

import { createHash } from "node:crypto";
import path from "node:path";
import { loadClinicalCoreMigrations } from "./migrations";
import { applyProductionClinicalCoreMigrations, inspectProductionClinicalCoreMigrations, ProductionClinicalCoreMigrationError } from "./production-migrations";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";

const CLUSTER_ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:(\d{12}):cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function run() {
  const command = process.argv[2];
  // `inspect` is read-only and runs under the same account and PHI boundary as `apply`: it reports the applied, missing,
  // mismatched and unknown versions so the missing subset is known before anything is applied.
  if ((command !== "apply" && command !== "inspect")
    || required("PHI_ALLOWED") !== "false"
    || required("CONFIRM_PRODUCTION_SCHEMA_ONLY") !== "true") {
    throw new Error("activation_boundary_refused");
  }
  const clusterArn = required("CLINICAL_DATABASE_CLUSTER_ARN");
  const secretArn = required("CLINICAL_DATABASE_SECRET_ARN");
  const expectedAccountId = required("EXPECTED_AWS_ACCOUNT_ID");
  const match = clusterArn.match(CLUSTER_ARN);
  if (!match || match[2] !== expectedAccountId || !SECRET_ARN.test(secretArn)) {
    throw new Error("account_boundary_refused");
  }
  const databaseName = required("CLINICAL_DATABASE_NAME");
  const region = required("AWS_REGION");
  const directory = process.env.CLINICAL_PRODUCTION_MIGRATIONS?.trim()
    || path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations");
  const migrations = loadClinicalCoreMigrations(directory);
  const database = createRdsDataAdministrativeDatabase(
    { clusterArn, secretArn, databaseName, region },
    { purpose: "reviewed_production_schema_migration" },
  );
  if (command === "inspect") {
    const inspection = await inspectProductionClinicalCoreMigrations(database, migrations);
    console.log(JSON.stringify({ mode: "production_schema_inspection_read_only", ...inspection, safeToApply: inspection.mismatched.length === 0 && inspection.unknown.length === 0 }));
    if (inspection.mismatched.length || inspection.unknown.length) process.exitCode = 2;
    return;
  }
  const result = await applyProductionClinicalCoreMigrations(database, migrations);
  const releaseHash = createHash("sha256")
    .update(migrations.map((migration) => `${migration.version}:${migration.sha256}`).join("\n"))
    .digest("hex");
  console.log(JSON.stringify({
    mode: "production_schema_only_phi_disabled",
    ...result,
    releaseHash,
  }));
}

run().catch((error) => {
  if (error instanceof ProductionClinicalCoreMigrationError) {
    console.error(`${error.category}:${error.version ?? "none"}:${error.statementIndex ?? 0}`);
    process.exitCode = 1;
    return;
  }
  const category = error instanceof Error ? error.message : "production_schema_migration_failed";
  console.error(category);
  process.exitCode = 1;
});
