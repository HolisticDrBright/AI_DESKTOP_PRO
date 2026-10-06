if (typeof window !== "undefined") {
  throw new Error("qualification-target-operator is server-only.");
}

import path from "node:path";
import { execFileSync } from "node:child_process";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { loadClinicalCoreMigrations } from "./migrations";
import { assertQualificationConfiguration, assertQualificationOperatorIdentity, createQualificationDatabase, inspectQualificationTarget, QualificationTargetError } from "./qualification-target";
import { provisionQualificationFixtures, QualificationFixtureError } from "./qualification-fixtures";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { loadQualificationFixtureManifest } from "./qualification-fixture-manifest";
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
  // `fixtures` must enforce the same account/ARN/database checks as inspect/create,
  // even when the operator is called directly rather than through PowerShell.
  assertQualificationConfiguration(configuration, region);
  // Pin STS and RDS to the same short-lived member profile. Ambient root login,
  // environment access keys and a direct invocation cannot redirect the writer.
  const profile = "ai-synthetic-member";
  const identity = JSON.parse(execFileSync("aws", ["sts", "get-caller-identity", "--profile", profile, "--region", region, "--output", "json"],
    { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }));
  assertQualificationOperatorIdentity(identity, configuration.expectedAccountId);
  const client = new RDSDataClient({ region, credentials: fromIni({ profile }) });
  if (command === "inspect") {
    console.log(JSON.stringify(await inspectQualificationTarget(client, configuration)));
    return;
  }
  if (command === "create") {
    console.log(JSON.stringify(await createQualificationDatabase(client, configuration)));
    return;
  }
  const manifest = loadQualificationFixtureManifest(required("CLINICAL_SYNTHETIC_MANIFEST"));
  if (manifest.awsAccountId !== configuration.expectedAccountId || manifest.awsRegion !== region || configuration.expectedAccountId !== '588966314750') throw new Error("account_boundary_refused");
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
