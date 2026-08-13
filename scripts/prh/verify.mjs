// Phase 9E-B — bounded local verifier for the Product Research Handoff package.
//
// Reads only from the local package directory named in PRH_HANDOFF_PATH.
// Recomputes every SHA-256, validates the JSONL schemas, checks separation
// guarantees, and prints an aggregate report. Emits NO raw ingredient text,
// URLs, warnings, or private paths.
//
// Usage:
//   PRH_HANDOFF_PATH="/path/to/Product Research Handoff" \
//     node scripts/prh/verify.mjs
//
// The package path is NEVER committed. This script is deterministic —
// same input → same output — so the report itself can be recorded verbatim
// in a PR without leaking source content.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HP = process.env.PRH_HANDOFF_PATH;
if (!HP) {
  console.error("PRH_HANDOFF_PATH is required.");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(HP, "handoff-manifest.json"), "utf-8"));

function sha256(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function readJsonl(fp) {
  return fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function bucket(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

// --- SHA checks ---
const hashRows = [];
for (const src of manifest.source_files) {
  hashRows.push({ file: path.basename(src.path), ok: sha256(src.path) === src.sha256 });
}
for (const out of manifest.output_files) {
  hashRows.push({ file: out.file, ok: sha256(path.join(HP, out.file)) === out.sha256 });
}
const allHashesOk = hashRows.every((r) => r.ok);

const clinical = readJsonl(path.join(HP, "product-label-enrichment.jsonl"));
const commercial = readJsonl(path.join(HP, "commercial-links.jsonl"));
const evidence = readJsonl(path.join(HP, "evidence-sources.jsonl"));

// --- Schema checks ---
const schemaProblems = [];
const seenIds = new Set();
const clinicalRequired = [
  "product_research_id", "source_file", "source_sheet", "source_row",
  "identity_confidence", "research_status",
];
const clinicalBanned = ["affiliate_url", "commercial_url", "discount_code", "price"];
const privatePathRe = /C:[\\/]Users[\\/]Brand/i;

for (const r of clinical) {
  for (const k of clinicalRequired) if (!(k in r)) schemaProblems.push(`clinical missing ${k}`);
  const id = r.product_research_id;
  if (!(typeof id === "string" && /^PRH-\d{4}$/.test(id))) schemaProblems.push(`bad prh id`);
  if (seenIds.has(id)) schemaProblems.push(`duplicate prh id: ${id}`);
  seenIds.add(id);
  for (const k of clinicalBanned) if (k in r) schemaProblems.push(`clinical carries banned ${k}`);
  if ("clinically_approved" in r && r.clinically_approved !== false)
    schemaProblems.push(`clinically_approved must be false: ${id}`);
  if ("imported" in r && r.imported !== false)
    schemaProblems.push(`imported must be false: ${id}`);
  if (privatePathRe.test(JSON.stringify(r))) schemaProblems.push(`private path in clinical: ${id}`);
}

const commercialClinicalFields = [
  "ingredient_amounts", "warnings", "supplement_facts", "regulatory_classification",
  "suggested_use", "clinical_notes", "reviewer_notes",
];
const commercialProblems = [];
for (const r of commercial) {
  if (typeof r.product_research_id !== "string") commercialProblems.push(`commercial missing prh id`);
  for (const k of commercialClinicalFields) if (k in r) commercialProblems.push(`commercial carries clinical field ${k}`);
  if (privatePathRe.test(JSON.stringify(r))) commercialProblems.push(`private path in commercial`);
}

// --- Counts + categorization (no free text emitted) ---
const identityCounts = {};
for (const r of clinical) bucket(identityCounts, r.identity_confidence);

const restrictionCounts = {};
for (const r of clinical) for (const f of r.restriction_flags || []) bucket(restrictionCounts, f);

const missingCounts = {};
for (const r of clinical) for (const f of r.missing_fields || []) bucket(missingCounts, f);

function isShortStructuredKey(k) {
  if (typeof k !== "string" || k.length > 48 || /[\r\n]/.test(k)) return false;
  return /^[A-Za-z0-9._\[\]-]+(?:\s+[A-Za-z0-9._\[\]-]+)*$/.test(k);
}
const conflictCounts = { records_with_conflicts: 0, by_field: {}, long_form_notes: 0 };
for (const r of clinical) {
  const cf = r.conflicting_fields;
  if (!cf) continue;
  const entries = Array.isArray(cf) ? cf : Object.keys(cf);
  if (!entries.length) continue;
  conflictCounts.records_with_conflicts += 1;
  for (const entry of entries) {
    const kind = typeof entry === "string" ? entry : (entry.field ?? "unknown");
    if (isShortStructuredKey(kind)) bucket(conflictCounts.by_field, kind);
    else conflictCounts.long_form_notes += 1;
  }
}

const authorityCounts = { by_tier: {}, url_only: 0, archived: 0 };
for (const e of evidence) {
  bucket(authorityCounts.by_tier, e.authority_tier ?? "unknown");
  if (typeof e.url === "string" && e.url.length > 0) authorityCounts.url_only += 1;
  if (e.sha256) authorityCounts.archived += 1;
}

// Mapping outcomes.
function classifyMapping(r) {
  const idents = r.identifiers || {};
  const hasStrongId = ["upc", "gtin", "sku"].some((k) => typeof idents[k] === "string" && idents[k].length > 0);
  if (r.identity_confidence === "exact") return hasStrongId ? "exact_identity_with_id" : "exact_identity_no_id";
  if (r.identity_confidence === "probable") return "probable";
  if (r.identity_confidence === "ambiguous") return "ambiguous";
  if (r.identity_confidence === "unmatched") return "unmatched";
  return "unknown";
}
const mappingOutcomes = {};
for (const r of clinical) bucket(mappingOutcomes, classifyMapping(r));

const report = {
  package_name: manifest.package,
  created_utc: manifest.created_utc,
  hashes: { all_match: allHashesOk, per_file: hashRows },
  counts: {
    clinical: clinical.length,
    commercial: commercial.length,
    evidence: evidence.length,
    expected: { clinical: 164, commercial: 172, evidence: 433 },
  },
  schema_problems: {
    clinical: schemaProblems.length,
    commercial: commercialProblems.length,
    samples: {
      clinical: schemaProblems.slice(0, 5),
      commercial: commercialProblems.slice(0, 5),
    },
  },
  unique_prh_ids: seenIds.size,
  identity_counts: identityCounts,
  restriction_categories: restrictionCounts,
  missing_fact_categories: missingCounts,
  conflict_categories: conflictCounts,
  evidence_authority_tiers: authorityCounts,
  mapping_outcomes: mappingOutcomes,
  supplement_facts_reconciliation: {
    per_record_flag_count: clinical.filter((r) => r.supplement_facts_complete === true).length,
    manifest_records_with_complete_supplement_facts: manifest.counts.records_with_complete_supplement_facts,
    manifest_supplement_facts_complete: manifest.counts.supplement_facts_complete,
    note: "The workspace uses the per-record supplement_facts_complete flag as the completeness threshold; both manifest aggregates are preserved verbatim.",
  },
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(allHashesOk && !schemaProblems.length && !commercialProblems.length ? 0 : 1);
