if (typeof window !== "undefined") {
  throw new Error("production-migration-verifier is server-only.");
}

import {
  BeginTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadClinicalCoreMigrations, splitPostgresStatements } from "./migrations";

const ARN = /^arn:(aws|aws-us-gov|aws-cn):rds:[a-z0-9-]+:\d{12}:cluster:[A-Za-z0-9-]{1,63}$/;
const SECRET_ARN = /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

async function verify() {
  if (requiredEnvironment("PHI_ALLOWED") !== "false"
    || requiredEnvironment("CONFIRM_ROLLBACK_ONLY") !== "true") {
    throw new Error("activation_boundary_refused");
  }
  const resourceArn = requiredEnvironment("CLINICAL_DATABASE_CLUSTER_ARN");
  const secretArn = requiredEnvironment("CLINICAL_DATABASE_SECRET_ARN");
  const database = requiredEnvironment("CLINICAL_DATABASE_NAME");
  if (!ARN.test(resourceArn) || !SECRET_ARN.test(secretArn) || !DB_NAME.test(database)) {
    throw new Error("configuration_refused");
  }
  const region = requiredEnvironment("AWS_REGION");
  const directory = process.env.CLINICAL_PRODUCTION_MIGRATIONS?.trim()
    || path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations");
  const migrations = loadClinicalCoreMigrations(directory);
  const client = new RDSDataClient({ region });
  const common = { resourceArn, secretArn, database };
  const begun = await client.send(new BeginTransactionCommand(common));
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error("transaction_refused");

  let statementCount = 0;
  let activeMigration = "none";
  try {
    for (const migration of migrations) {
      activeMigration = migration.version;
      for (const statement of splitPostgresStatements(migration.sql)) {
        statementCount += 1;
        await client.send(new ExecuteStatementCommand({
          ...common,
          transactionId,
          sql: statement,
          continueAfterTimeout: true,
        }));
      }
    }
    const catalog = await client.send(new ExecuteStatementCommand({
      ...common,
      transactionId,
      sql: `select
        (select count(*) from information_schema.tables where table_schema in ('clinical_core','clinical_audit')) as table_count,
        (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'clinical_core' and p.proname in ('create_patient_profile','review_biomarker')) as contract_count,
        (select count(*) from clinical_core.organizations) as organization_count,
        (select count(*) from clinical_core.persons) as person_count,
        (select count(*) from clinical_core.patient_records) as patient_count`,
      includeResultMetadata: true,
    }));
    const fields = catalog.records?.[0] ?? [];
    const counts = fields.map((field) => Number(field.longValue ?? field.stringValue ?? -1));
    if (counts.length !== 5 || counts[0]! < 10 || counts[1] !== 2
      || counts[2] !== 0 || counts[3] !== 0 || counts[4] !== 0) {
      throw new Error("catalog_verification_refused");
    }
    const releaseHash = createHash("sha256")
      .update(migrations.map((migration) => `${migration.version}:${migration.sha256}`).join("\n"))
      .digest("hex");
    console.log(JSON.stringify({
      mode: "rollback_only",
      migrations: migrations.length,
      statements: statementCount,
      tableCount: counts[0],
      contractCount: counts[1],
      organizationCount: counts[2],
      personCount: counts[3],
      patientCount: counts[4],
      releaseHash,
    }));
  } catch (error) {
    const category = error instanceof Error && /^(catalog_verification_refused|activation_boundary_refused)$/.test(error.message)
      ? error.message
      : "migration_statement_refused";
    throw new Error(`${category}:${activeMigration}:${statementCount}`);
  } finally {
    await client.send(new RollbackTransactionCommand({ ...common, transactionId }));
  }
}

verify().catch((error) => {
  console.error(error instanceof Error ? error.message : "production_migration_verification_failed");
  process.exitCode = 1;
});
