import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const migration = [
  "20260819173000_governed_reference_catalog.sql",
  "20260820030000_governed_catalog_enrichment.sql",
].map((file) => readFileSync(new URL(`infra/aws-clinical-core/catalog-migrations/${file}`, root), "utf8")).join("\n");
const manifest = JSON.parse(readFileSync(new URL("infra/aws-clinical-core/catalog-migrations/manifest.json", root), "utf8"));
const importer = readFileSync(new URL("src/server/clinical-core/aws-governed-catalog.ts", root), "utf8");
const reader = readFileSync(new URL("src/server/clinical-core/aws-governed-catalog-reader.ts", root), "utf8");
const catalogRunner = readFileSync(new URL("src/server/clinical-core/catalog-migrations.ts", root), "utf8");

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateGovernedCatalogBoundary({ migration, manifest, importer, reader, catalogRunner }) {
  const errors = [];
  for (const schema of ["clinical_reference", "commercial_reference"]) {
    assert(errors, migration.includes(`create schema if not exists ${schema}`), `missing ${schema} schema`);
  }
  for (const table of [
    "catalog_import_batches", "catalog_products", "catalog_product_versions",
    "knowledge_sources", "knowledge_source_versions", "safety_rules", "safety_rule_versions",
    "protocol_templates", "protocol_template_versions", "protocol_template_items", "catalog_review_events",
    "product_labels", "product_label_versions", "protocol_template_steps",
  ]) {
    assert(errors, migration.includes(`create table clinical_reference.${table}`), `missing ${table} table`);
    assert(errors, migration.includes(`alter table clinical_reference.${table} enable row level security`), `${table} must enable RLS`);
  }
  for (const table of ["affiliate_offers", "affiliate_offer_versions"]) {
    assert(errors, migration.includes(`create table commercial_reference.${table}`), `missing ${table} table`);
    assert(errors, migration.includes(`alter table commercial_reference.${table} enable row level security`), `${table} must enable RLS`);
  }
  assert(errors, migration.includes("review_status text not null default 'needs_review'"), "imports must default to needs_review");
  assert(errors, migration.includes("catalog_product_versions_append_only"), "product versions must be append-only");
  assert(errors, migration.includes("knowledge_source_versions_append_only"), "knowledge sources must be append-only");
  assert(errors, migration.includes("safety_rule_versions_append_only"), "safety rules must be append-only");
  assert(errors, migration.includes("protocol_template_versions_append_only"), "template versions must be append-only");
  assert(errors, migration.includes("product_label_versions_append_only"), "product labels must be append-only");
  assert(errors, migration.includes("protocol_template_steps_append_only"), "protocol steps must be append-only");
  assert(errors, migration.includes("affiliate_offer_versions_append_only"), "commercial offer versions must be append-only");
  assert(errors, migration.includes("protocol_item_dose_provenance"), "protocol doses must name a source");
  assert(errors, migration.includes("catalog_product_payload_no_commercial_data"), "clinical payload must reject commercial fields");
  assert(errors, migration.includes("contains_phi boolean not null default false check (contains_phi = false)"), "reference records must refuse PHI");
  assert(errors, migration.includes("environment in ('synthetic-staging','production-clinical')"), "catalog rows must be isolated to an explicit environment");
  assert(errors, migration.includes("clinical.catalog.environment"), "RLS must bind reads to the configured catalog environment");
  assert(errors, !/auth\.uid\(|\bpublic\.|\banon\b|\bauthenticated\b/.test(migration), "AWS migration must not contain Supabase authorization constructs");
  assert(errors, !/^\s*(begin|commit|rollback)\s*;/gim.test(migration), "migration runner owns transaction control");
  const ledger = manifest.migrations?.find((entry) => entry.version === "20260819173000");
  assert(errors, ledger?.file === "20260819173000_governed_reference_catalog.sql", "catalog migration is missing from the ordered ledger");
  const enrichmentLedger = manifest.migrations?.find((entry) => entry.version === "20260820030000");
  assert(errors, enrichmentLedger?.file === "20260820030000_governed_catalog_enrichment.sql", "catalog enrichment migration is missing from the ordered ledger");
  assert(errors, catalogRunner.includes('schema: "clinical_reference"')
    && catalogRunner.includes("governed-catalog-migrations"), "catalog needs an independent migration ledger and lock");
  assert(errors, importer.includes("manifest_hash_mismatch") && importer.includes("content_hash_mismatch"), "importer must verify manifest and record hashes");
  assert(errors, importer.includes("pg_advisory_xact_lock") && importer.includes("catalog_import_batches"), "importer must serialize and record idempotent imports");
  assert(errors, importer.includes("'needs_review'"), "importer must not activate imported content");
  assert(errors, importer.includes("product_label_count") && importer.includes("protocol_template_steps"), "importer must retain label evidence and full protocol steps");
  assert(errors, !/console\.(log|warn|error)|logger\./.test(importer), "importer must not log source payloads");
  assert(errors, reader.includes("commercial: { offers:"), "reader must return commercial data under a separate top-level key");
  assert(errors, !reader.includes("supabase"), "reader must not use Supabase as fallback");
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateGovernedCatalogBoundary({ migration, manifest, importer, reader, catalogRunner });
  if (errors.length) {
    errors.forEach((error) => console.error(`AWS governed catalog check failed: ${error}`));
    process.exitCode = 1;
  } else {
    console.log("AWS governed catalog check passed: portable schemas, immutable versions, reviewed reads, separate commercial data, and hash reconciliation are enforced.");
  }
}
