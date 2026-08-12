import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { applyClinicalCoreMigrations } from "./migrations";
import { loadSyntheticAcceptanceManifest, provisionSyntheticAcceptanceFixtures } from "./synthetic-fixtures";

async function main() {
  const command = process.argv[2];
  const configuration = {
    clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
    secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
    databaseName: required("CLINICAL_DATABASE_NAME"),
    region: required("AWS_REGION"),
  };
  const database = createRdsDataAdministrativeDatabase(configuration, { purpose: "reviewed_synthetic_migration" });
  if (command === "migrate") {
    const result = await applyClinicalCoreMigrations(database);
    console.log(JSON.stringify({ ok: true, applied: result.applied, alreadyApplied: result.alreadyApplied }));
    return;
  }
  if (command === "fixtures") {
    const manifest = loadSyntheticAcceptanceManifest(required("CLINICAL_SYNTHETIC_MANIFEST"));
    const result = await provisionSyntheticAcceptanceFixtures(database, manifest);
    console.log(JSON.stringify({ ok: true, provisioned: result.provisioned, records: result.records }));
    return;
  }
  throw new Error("deployment_command_invalid");
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("deployment_configuration_missing");
  return value;
}

main().catch((error) => {
  const category = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "deployment_failed";
  const statementIndex = error instanceof Error && "statementIndex" in error
    && Number.isSafeInteger((error as { statementIndex?: number }).statementIndex)
    ? (error as { statementIndex: number }).statementIndex : undefined;
  const operationIndex = error instanceof Error && "operationIndex" in error
    && Number.isSafeInteger((error as { operationIndex?: number }).operationIndex)
    ? (error as { operationIndex: number }).operationIndex : undefined;
  console.error(JSON.stringify({ ok: false, error: category, ...(statementIndex ? { statementIndex } : {}), ...(operationIndex ? { operationIndex } : {}) }));
  process.exitCode = 1;
});
