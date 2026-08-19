import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyGovernedCatalogMigrations } from "./catalog-migrations";
import { importGovernedCatalog, validateGovernedCatalogManifest } from "./aws-governed-catalog";
import { reviewGovernedCatalogVersion, type CatalogReviewInput } from "./aws-governed-catalog-review";
import { loadAndAdaptGovernedCatalogSourcePackage } from "./aws-governed-catalog-seed-adapter";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";

async function main() {
  const command = process.argv[2];
  const environment = required("CLINICAL_CATALOG_ENVIRONMENT");
  if (!["synthetic-staging", "production-clinical"].includes(environment)) {
    throw new Error("catalog_environment_invalid");
  }
  if (command === "adapt") {
    const sourceDirectory = required("CLINICAL_CATALOG_SOURCE_DIR");
    const outputFile = resolve(required("CLINICAL_CATALOG_OUTPUT"));
    const manifest = loadAndAdaptGovernedCatalogSourcePackage({
      directory: sourceDirectory,
      targetEnvironment: environment as "synthetic-staging" | "production-clinical",
      expectedManifestFileSha256: required("CLINICAL_CATALOG_SOURCE_MANIFEST_SHA256"),
    });
    writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({
      ok: true,
      outputFile,
      manifestSha256: manifest.manifestSha256,
      counts: {
        products: manifest.products.length,
        commercialOffers: manifest.commercialOffers.length,
        protocolTemplates: manifest.protocolTemplates.length,
        safetyRules: manifest.safetyRules.length,
        knowledgeSources: manifest.knowledgeSources.length,
      },
      reviewStatus: "needs_review",
    }));
    return;
  }
  const database = createRdsDataAdministrativeDatabase({
    clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"),
    secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
    databaseName: required("CLINICAL_DATABASE_NAME"),
    region: required("AWS_REGION"),
  }, { purpose: "reviewed_reference_catalog_import" });

  if (command === "migrate") {
    const result = await applyGovernedCatalogMigrations(database);
    console.log(JSON.stringify({ ok: true, applied: result.applied, alreadyApplied: result.alreadyApplied }));
    return;
  }
  if (command === "import") {
    const file = required("CLINICAL_CATALOG_MANIFEST");
    const manifest = validateGovernedCatalogManifest(JSON.parse(readFileSync(resolve(file), "utf8")));
    if (manifest.targetEnvironment !== environment) throw new Error("catalog_environment_mismatch");
    const result = await importGovernedCatalog(database, manifest);
    console.log(JSON.stringify({
      ok: true,
      batchId: result.batchId,
      manifestSha256: result.manifestSha256,
      alreadyApplied: result.alreadyApplied,
      counts: result.counts,
      reviewStatus: result.reviewStatus,
    }));
    return;
  }
  if (command === "review") {
    const file = required("CLINICAL_CATALOG_REVIEW");
    const review = JSON.parse(readFileSync(resolve(file), "utf8")) as CatalogReviewInput;
    if (review.environment !== environment) throw new Error("catalog_environment_mismatch");
    const result = await reviewGovernedCatalogVersion(database, review);
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  throw new Error("catalog_command_invalid");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("catalog_configuration_missing");
  return value;
}

main().catch((error) => {
  const category = error instanceof Error && /^[a-z_]+$/.test(error.message)
    ? error.message
    : "catalog_operation_failed";
  console.error(JSON.stringify({ ok: false, error: category }));
  process.exitCode = 1;
});
