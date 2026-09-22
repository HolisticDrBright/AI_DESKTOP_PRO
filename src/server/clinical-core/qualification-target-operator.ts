if (typeof window !== "undefined") {
  throw new Error("qualification-target-operator is server-only.");
}

import path from "node:path";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { loadClinicalCoreMigrations } from "./migrations";
import { createQualificationDatabase, inspectQualificationTarget, QualificationTargetError } from "./qualification-target";
import { provisionQualificationFixtures, QualificationFixtureError } from "./qualification-fixtures";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { loadSyntheticAcceptanceManifest } from "./synthetic-fixtures";
import { errorCode } from "./log-safe-error";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("configuration_refused");
  return value;
}

/** `inspect` (read-only), `create` (the empty qualification database) and `fixtures` (production-shaped fictional rows
 * into a qualification database whose ledger equals the built artifact). The production migration operator applies the
 * schema between `create` and `fixtures`; this operator never applies a migration. */
async function run() {
  const command = process.argv[2];
  if ((command !== "inspect" && command !== "create" && command !== "fixtures") || required("PHI_ALLOWED") !== "false") {
    throw new Error("activation_boundary_refused");
  }
  if (command !== "inspect" && required("CONFIRM_QUALIFICATION_TARGET") !== "true") throw new Error("activation_boundary_refused");
  const configuration = {
    clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
    secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
    qualificationDatabaseName: required("QUALIFICATION_DATABASE_NAME"),
    stagingDatabaseName: required("STAGING_DATABASE_NAME"),
    expectedAccountId: required("EXPECTED_AWS_ACCOUNT_ID"),
  };
  const region = required("AWS_REGION");
  const client = new RDSDataClient({ region });
  if (command === "inspect") {
    console.log(JSON.stringify(await inspectQualificationTarget(client, configuration)));
    return;
  }
  if (command === "create") {
    console.log(JSON.stringify(await createQualificationDatabase(client, configuration)));
    return;
  }
  const manifest = loadSyntheticAcceptanceManifest(required("CLINICAL_SYNTHETIC_MANIFEST"));
  if (manifest.awsAccountId !== configuration.expectedAccountId) throw new Error("account_boundary_refused");
  const directory = process.env.CLINICAL_PRODUCTION_MIGRATIONS?.trim() || path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations");
  const migrations = loadClinicalCoreMigrations(directory);
  const database = createRdsDataAdministrativeDatabase(
    { clusterArn: configuration.clusterArn, secretArn: configuration.secretArn, databaseName: configuration.qualificationDatabaseName, region },
    { purpose: "reviewed_production_schema_migration" },
    client,
  );
  console.log(JSON.stringify({ mode: "qualification_fixtures_phi_disabled", database: configuration.qualificationDatabaseName, ...(await provisionQualificationFixtures(database, manifest, migrations, { qualificationDatabaseName: configuration.qualificationDatabaseName, stagingDatabaseName: configuration.stagingDatabaseName })) }));
}

run().catch((error) => {
  if (error instanceof QualificationTargetError || error instanceof QualificationFixtureError) {
    console.error(error.category);
    process.exitCode = error.category === "qualification_database_exists" ? 2 : 1;
    return;
  }
  console.error(errorCode(error, "qualification_target_failed"));
  process.exitCode = 1;
});
