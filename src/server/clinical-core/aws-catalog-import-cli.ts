import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyGovernedCatalogMigrations } from "./catalog-migrations";
import { importGovernedCatalog, validateGovernedCatalogManifest } from "./aws-governed-catalog";
import {
  activateCatalogOwnerCommercialOffers,
  activateLabelReadyCommercialOffers,
  approveGovernedCatalogRelease,
  catalogOwnerCommercialSelection,
  reviewGovernedCatalogVersion,
  type CatalogReviewInput,
} from "./aws-governed-catalog-review";
import { loadAndAdaptGovernedCatalogSourcePackage } from "./aws-governed-catalog-seed-adapter";
import { loadAndBuildExpandedCatalogRelease } from "./aws-expanded-catalog-release";
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
        productLabels: manifest.productLabels.length,
        commercialOffers: manifest.commercialOffers.length,
        protocolTemplates: manifest.protocolTemplates.length,
        protocolSteps: manifest.protocolTemplates.reduce((count, template) => count + template.steps.length, 0),
        safetyRules: manifest.safetyRules.length,
        knowledgeSources: manifest.knowledgeSources.length,
      },
      reviewStatus: "needs_review",
    }));
    return;
  }
  if (command === "adapt-expanded") {
    const outputFile = resolve(required("CLINICAL_CATALOG_OUTPUT"));
    const manifest = loadAndBuildExpandedCatalogRelease({
      originalDirectory: required("CLINICAL_CATALOG_ORIGINAL_SOURCE_DIR"),
      originalManifestFileSha256: required("CLINICAL_CATALOG_ORIGINAL_SOURCE_MANIFEST_SHA256"),
      candidateDirectory: required("CLINICAL_CATALOG_CANDIDATE_SOURCE_DIR"),
      candidateManifestFileSha256: required("CLINICAL_CATALOG_CANDIDATE_SOURCE_MANIFEST_SHA256"),
      approvalFile: required("CLINICAL_CATALOG_CANDIDATE_APPROVAL"),
      targetEnvironment: environment as "synthetic-staging" | "production-clinical",
    });
    writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({
      ok: true,
      outputFile,
      manifestSha256: manifest.manifestSha256,
      counts: {
        products: manifest.products.length,
        originalProducts: manifest.products.filter((product) => product.clinicalPayload.selectionPriorityGroup === "original_primary").length,
        expandedProducts: manifest.products.filter((product) => product.clinicalPayload.selectionPriorityGroup === "expanded_secondary").length,
        commercialOffers: manifest.commercialOffers.length,
      },
      reviewStatus: "needs_review",
    }));
    return;
  }
  if (command === "commercial-selection-hash") {
    const file = required("CLINICAL_CATALOG_MANIFEST");
    const manifest = validateGovernedCatalogManifest(JSON.parse(readFileSync(resolve(file), "utf8")));
    console.log(JSON.stringify({ ok: true, ...catalogOwnerCommercialSelection(manifest) }));
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
  if (command === "preflight-conflicts") {
    const file = required("CLINICAL_CATALOG_MANIFEST");
    const manifest = validateGovernedCatalogManifest(JSON.parse(readFileSync(resolve(file), "utf8")));
    const groups = [
      { domain: "products", table: "clinical_reference.catalog_product_versions", foreignKey: "product_stable_id", values: manifest.products },
      { domain: "labels", table: "clinical_reference.product_label_versions", foreignKey: "label_stable_id", values: manifest.productLabels },
      { domain: "offers", table: "commercial_reference.affiliate_offer_versions", foreignKey: "offer_stable_id", values: manifest.commercialOffers },
      { domain: "templates", table: "clinical_reference.protocol_template_versions", foreignKey: "template_stable_id", values: manifest.protocolTemplates },
      { domain: "safety", table: "clinical_reference.safety_rule_versions", foreignKey: "rule_stable_id", values: manifest.safetyRules },
      { domain: "sources", table: "clinical_reference.knowledge_source_versions", foreignKey: "source_stable_id", values: manifest.knowledgeSources },
    ] as const;
    const conflicts = await database.transaction(async (tx) => {
      const found: Array<{ domain: string; stableId: string }> = [];
      for (const group of groups) {
        if (group.values.length === 0) continue;
        const payload = JSON.stringify(group.values.map((value) => ({
          stable_id: value.stableId, version: value.version, content_sha256: value.contentSha256,
        })));
        const result = await tx.query<{ stable_id: string }>(
          `with requested as (
             select stable_id, version, content_sha256
             from jsonb_to_recordset($1::jsonb)
               as x(stable_id text, version integer, content_sha256 text)
           )
           select v.${group.foreignKey} as stable_id
           from requested q
           join ${group.table} v on v.${group.foreignKey} = q.stable_id and v.version = q.version
           where v.content_sha256 <> q.content_sha256`,
          [payload],
        );
        found.push(...result.rows.map((row) => ({ domain: group.domain, stableId: row.stable_id })));
      }
      return found;
    });
    console.log(JSON.stringify({ ok: conflicts.length === 0, conflicts }));
    return;
  }
  if (command === "approve-release") {
    const file = required("CLINICAL_CATALOG_MANIFEST");
    const manifest = validateGovernedCatalogManifest(JSON.parse(readFileSync(resolve(file), "utf8")));
    const result = await approveGovernedCatalogRelease(database, {
      manifest,
      reviewerPersonId: required("CLINICAL_CATALOG_REVIEWER_PERSON_ID"),
      reason: required("CLINICAL_CATALOG_REVIEW_REASON"),
      environment: environment as "synthetic-staging" | "production-clinical",
    });
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (command === "activate-label-ready-commercial") {
    const result = await activateLabelReadyCommercialOffers(database, {
      reviewerPersonId: required("CLINICAL_CATALOG_REVIEWER_PERSON_ID"),
      reason: required("CLINICAL_CATALOG_REVIEW_REASON"),
      environment: environment as "synthetic-staging" | "production-clinical",
      expectedSelectionSha256: required("CLINICAL_CATALOG_EXPECTED_SELECTION_SHA256"),
    });
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (command === "activate-owner-approved-commercial") {
    const result = await activateCatalogOwnerCommercialOffers(database, {
      reviewerPersonId: required("CLINICAL_CATALOG_REVIEWER_PERSON_ID"),
      reason: required("CLINICAL_CATALOG_REVIEW_REASON"),
      environment: environment as "synthetic-staging" | "production-clinical",
      expectedSelectionSha256: required("CLINICAL_CATALOG_EXPECTED_SELECTION_SHA256"),
      expectedCount: Number(required("CLINICAL_CATALOG_EXPECTED_SELECTION_COUNT")),
    });
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
  const subjectStableId = error && typeof error === "object" && "subjectStableId" in error
    && typeof error.subjectStableId === "string" && /^[a-z]{3}_[a-z0-9_-]{3,96}$/.test(error.subjectStableId)
    ? error.subjectStableId
    : undefined;
  console.error(JSON.stringify({ ok: false, error: category, ...(subjectStableId ? { subjectStableId } : {}) }));
  process.exitCode = 1;
});
