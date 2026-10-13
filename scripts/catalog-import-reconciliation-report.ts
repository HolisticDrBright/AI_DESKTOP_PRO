/**
 * Read-only catalog import reconciliation (catalog-import-reconciliation/1) for Codex to run against an environment
 * it operates. It reads the environment's product, label, offer and import-batch rows for the named products in a
 * read-only transaction and compares them with the checked-in source releases. It writes, approves and inserts
 * nothing. Not part of any deployed operator.
 *
 *   CLINICAL_CATALOG_ENVIRONMENT=synthetic-staging
 *   CLINICAL_DATABASE_CLUSTER_ARN / CLINICAL_DATABASE_SECRET_ARN / CLINICAL_DATABASE_NAME / AWS_REGION
 *   CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR / CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256
 *   CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR / CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256 / CLINICAL_CATALOG_CANDIDATE_APPROVAL
 *   CATALOG_RECONCILIATION_PRODUCTS=prd_aff_supreme_nutrition_takesumi_supreme_039,...   (default: every source product with an offer)
 *   CATALOG_RECONCILIATION_OUTPUT=<file to create>
 */
import { writeFileSync } from "node:fs";
import { loadAndBuildExpandedCatalogRelease } from "../src/server/clinical-core/aws-expanded-catalog-release";
import { loadAndAdaptGovernedCatalogSourcePackage } from "../src/server/clinical-core/aws-governed-catalog-seed-adapter";
import { CATALOG_IMPORT_RECONCILIATION, readHostedCatalogState, reconcileCatalogImport } from "../src/server/clinical-core/catalog-import-reconciliation";
import { createRdsDataAdministrativeDatabase } from "../src/server/clinical-core/rds-data-database";

const env = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v; };
const environment = env("CLINICAL_CATALOG_ENVIRONMENT");
if (environment !== "synthetic-staging" && environment !== "production-clinical") throw new Error("catalog_environment_invalid");
const original = loadAndAdaptGovernedCatalogSourcePackage({ directory: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR"), targetEnvironment: environment,
  expectedManifestFileSha256: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256") });
const expanded = loadAndBuildExpandedCatalogRelease({ originalDirectory: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR"), originalManifestFileSha256: env("CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256"),
  candidateDirectory: env("CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR"), candidateManifestFileSha256: env("CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256"),
  approvalFile: env("CLINICAL_CATALOG_CANDIDATE_APPROVAL"), targetEnvironment: environment });
const ids = (process.env.CATALOG_RECONCILIATION_PRODUCTS?.split(",").map(s => s.trim()).filter(Boolean))
  ?? [...new Set([...original.commercialOffers, ...expanded.commercialOffers].map(o => o.productStableId))];
const database = createRdsDataAdministrativeDatabase({ clusterArn: env("CLINICAL_DATABASE_CLUSTER_ARN"), secretArn: env("CLINICAL_DATABASE_SECRET_ARN"),
  databaseName: env("CLINICAL_DATABASE_NAME"), region: env("AWS_REGION") }, { purpose: "reviewed_reference_catalog_import" });
const state = await readHostedCatalogState(database, environment, ids);
const rows = reconcileCatalogImport([original, expanded], state, ids);
const count = (key: "labelFinding" | "offerFinding") => rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {});
writeFileSync(env("CATALOG_RECONCILIATION_OUTPUT"), `${JSON.stringify({ contract: CATALOG_IMPORT_RECONCILIATION, environment, products: rows.length,
  labels: count("labelFinding"), offers: count("offerFinding"), rows }, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ contract: CATALOG_IMPORT_RECONCILIATION, environment, products: rows.length, labels: count("labelFinding"), offers: count("offerFinding") }));
