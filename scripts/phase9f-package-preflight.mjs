#!/usr/bin/env node
/**
 * Phase 9F — authorized research package preflight.
 *
 *   node scripts/phase9f-package-preflight.mjs "<path to package>"
 *   npm run preflight:phase9f            (uses PHASE9F_PACKAGE_DIR)
 *
 * Verifies the package BEFORE anything is imported, and refuses on any
 * failure. It reads the package read-only and writes nothing anywhere.
 *
 * WHY THIS RE-IMPLEMENTS THE PACKAGE'S OWN QA. `work/build_manifest_qa.py`
 * reports 31 passed, 0 critical — but that is the producer checking its own
 * output with the producer's code. This script is the CONSUMER checking the
 * same claims independently, from the files as they actually arrived. If the
 * two ever disagree, that disagreement is the finding.
 *
 * It implements the ten referential-integrity rules from
 * `implementation-handoff-for-claude-code.md` §2, plus the ingestion
 * invariants from §3 that are checkable statically:
 *
 *   - every declared SHA-256 matches the file on disk;
 *   - every JSONL line parses and the counts match the manifest;
 *   - `product_research_id` is the ONLY join key, and every foreign
 *     reference resolves;
 *   - ids are unique within their own file;
 *   - every archived artifact exists and matches its recorded hash;
 *   - `archived == false` implies null path/hash AND `url_only_evidence`;
 *   - no output file carries a local absolute path;
 *   - clinical and commercial records share no field but the join key;
 *   - `clinically_approved` / `practitioner_verified` / `imported` are
 *     false on every record;
 *   - no record carries a verified/approved/safe/recommended status;
 *   - every record has exactly one disposition from the closed set;
 *   - restriction flags are present in at least the manifest's count.
 *
 * NOTHING IS REPAIRED. A mismatch is reported and the script exits 1. A
 * preflight that silently fixes its input is a preflight that guarantees
 * nothing about what was actually delivered.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const pkgDir = process.argv[2] ?? process.env.PHASE9F_PACKAGE_DIR ?? "";
if (!pkgDir) {
  console.error("usage: node scripts/phase9f-package-preflight.mjs \"<package dir>\"");
  console.error("   or: set PHASE9F_PACKAGE_DIR");
  process.exit(2);
}
if (!existsSync(pkgDir)) {
  console.error(`[phase9f] package directory not found: ${pkgDir}`);
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const readJsonl = (p) =>
  readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

/* ------------------------------------------------------------- manifest */

const manifestPath = join(pkgDir, "handoff-manifest-v2.json");
if (!existsSync(manifestPath)) {
  console.error("[phase9f] handoff-manifest-v2.json is missing. Refusing.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

check("manifest declares phase 9F", manifest.phase === "9F", `phase=${manifest.phase}`);
check(
  "manifest states nothing is approved or imported",
  manifest.governance?.clinically_approved === false &&
    manifest.governance?.practitioner_verified === false &&
    manifest.governance?.imported_anywhere === false,
);

/* ------------------------------------------------ rule 9: hashes + counts */

let hashOk = 0;
for (const f of manifest.output_files ?? []) {
  const p = join(pkgDir, f.file);
  if (!existsSync(p)) {
    check(`sha256 ${f.file}`, false, "file missing");
    continue;
  }
  const actual = sha256(p);
  const ok = actual === String(f.sha256).toLowerCase();
  if (ok) hashOk += 1;
  else check(`sha256 ${f.file}`, false, "MISMATCH — the file is not what the manifest declares");
}
check(
  `every declared output hash matches (${hashOk}/${(manifest.output_files ?? []).length})`,
  hashOk === (manifest.output_files ?? []).length,
);

/* --------------------------------------------------------------- parsing */

const files = {
  clinical: "product-label-enrichment-v2.jsonl",
  commercial: "commercial-links-v2.jsonl",
  evidence: "evidence-sources-v2.jsonl",
  artifacts: "evidence-artifact-index.jsonl",
  conflicts: "conflict-resolution-packets.jsonl",
};

const parsed = {};
for (const [key, name] of Object.entries(files)) {
  const p = join(pkgDir, name);
  if (!existsSync(p)) {
    check(`${name} present`, false, "missing");
    parsed[key] = [];
    continue;
  }
  const lines = readJsonl(p);
  const rows = [];
  let bad = 0;
  for (const l of lines) {
    try {
      rows.push(JSON.parse(l));
    } catch {
      bad += 1;
    }
  }
  check(`${name} every line parses`, bad === 0, bad ? `${bad} unparseable line(s)` : "");
  parsed[key] = rows;
}

const expectedCounts = {
  clinical: manifest.counts?.total_records,
  commercial: manifest.counts?.commercial_records,
  evidence: manifest.counts?.evidence_source_records,
  artifacts: manifest.counts?.evidence_artifacts,
  conflicts: manifest.counts?.conflict_packets,
};
for (const [key, expected] of Object.entries(expectedCounts)) {
  check(
    `${files[key]} count matches manifest`,
    parsed[key].length === expected,
    `actual=${parsed[key].length} manifest=${expected}`,
  );
}

/* -------------------------------------- rules 1-6: the single join key */

const clinicalIds = new Set(parsed.clinical.map((r) => r.product_research_id));
check(
  "rule 1 — product_research_id unique across clinical records",
  clinicalIds.size === parsed.clinical.length,
  `${parsed.clinical.length - clinicalIds.size} duplicate(s)`,
);

const dangling = (rows, label) => {
  const bad = rows.filter(
    (r) => r.product_research_id && !clinicalIds.has(r.product_research_id),
  );
  check(`${label} references resolve to a clinical record`, bad.length === 0, `${bad.length} dangling`);
};
dangling(parsed.evidence, "rule 2 — evidence");
dangling(parsed.artifacts, "rule 3 — artifact");
dangling(parsed.conflicts, "rule 4 — conflict packet");

const commercialBad = parsed.commercial.filter(
  (r) =>
    !(r.product_research_id && clinicalIds.has(r.product_research_id)) &&
    String(r.link_status ?? "") !== "unmatched" &&
    String(r.link_status_reason ?? "").toLowerCase().indexOf("unmatched") === -1,
);
check(
  "rule 5 — every commercial record resolves or is marked unmatched",
  commercialBad.length === 0,
  `${commercialBad.length} unresolved`,
);

const uniq = (rows, field, label) => {
  const s = new Set(rows.map((r) => r[field]));
  check(`rule 6 — ${label} unique`, s.size === rows.length, `${rows.length - s.size} duplicate(s)`);
};
uniq(parsed.evidence, "source_id", "source_id");
uniq(parsed.artifacts, "artifact_id", "artifact_id");

/* ------------------------------- rule 7: artifacts exist and hash-match */

let artOk = 0;
let artMissing = 0;
let artHashBad = 0;
for (const a of parsed.artifacts) {
  const rel = String(a.relative_path ?? "");
  const p = join(pkgDir, rel);
  if (!rel || !existsSync(p)) {
    artMissing += 1;
    continue;
  }
  if (sha256(p) !== String(a.sha256).toLowerCase()) artHashBad += 1;
  else artOk += 1;
}
check(`rule 7 — every artifact exists on disk`, artMissing === 0, `${artMissing} missing`);
check(`rule 7 — every artifact matches its recorded sha256`, artHashBad === 0, `${artHashBad} mismatched`);
check(`artifacts verified (${artOk}/${parsed.artifacts.length})`, artOk === parsed.artifacts.length);

/* ------------------------- rule 8: url-only is never presented as archived */

const rule8 = parsed.evidence.filter((e) => {
  if (e.archived === false) {
    return (
      e.artifact_relative_path != null || e.sha256 != null || e.url_only_evidence !== true
    );
  }
  return false;
});
check(
  "rule 8 — a URL-only source is never presented as archived",
  rule8.length === 0,
  `${rule8.length} violation(s)`,
);

/* ---------------------------- rule 10: no local absolute path in outputs */

const ABS = /(^|["'\s])([A-Za-z]:\\|\/(Users|home|mnt|var|tmp)\/)/;
let absHits = 0;
for (const name of Object.values(files)) {
  const p = join(pkgDir, name);
  if (!existsSync(p)) continue;
  const txt = readFileSync(p, "utf8");
  if (ABS.test(txt)) absHits += 1;
}
check("rule 10 — no output file carries a local absolute path", absHits === 0, `${absHits} file(s)`);
check(
  "artifact relative_path values are relative, not absolute",
  parsed.artifacts.every((a) => !isAbsolute(String(a.relative_path ?? ""))),
);

/* ------------------------------ §3 ingestion invariants, checked statically */

const flagFalse = (field) =>
  parsed.clinical.filter((r) => r[field] !== false).length === 0;
check("§3.1 clinically_approved is false on every record", flagFalse("clinically_approved"));
check("§3.1 practitioner_verified is false on every record", flagFalse("practitioner_verified"));
check("§3.1 imported is false on every record", flagFalse("imported"));

const DISPOSITIONS = new Set([
  "exact_identity_candidate",
  "conflicting_official_sources",
  "ambiguous_identity",
  "probable_identity_needs_review",
  "insufficient_authoritative_evidence",
  "commercial_only",
  "unmatched",
  "discontinued_confirmed",
  "needs_physical_label",
  "research_blocked",
]);
const badDisp = parsed.clinical.filter((r) => !DISPOSITIONS.has(r.research_disposition));
check(
  "§4 every record carries exactly one disposition from the closed set",
  badDisp.length === 0,
  `${badDisp.length} invalid`,
);

const proposable = parsed.clinical.filter(
  (r) => r.research_disposition === "exact_identity_candidate",
).length;
check(
  "§3.2 only exact_identity_candidate records are proposable",
  proposable === manifest.counts?.by_research_disposition?.exact_identity_candidate,
  `${proposable} proposable; the other ${parsed.clinical.length - proposable} must never reach a product table`,
);

// §3.6 — clinical and commercial share NOTHING but the join key and the
// provenance columns. Checked both directions rather than asserted.
const COMMERCIAL_ONLY_FIELDS = [
  "original_affiliate_url", "clean_destination_url", "destination_type",
  "affiliate_relationship", "tracking_parameters_present", "discount_code",
  "disclosure_text_present", "destination_resolves", "link_status",
];
const CLINICAL_ONLY_FIELDS = [
  "ingredients", "serving_size", "contraindications", "warnings", "allergens",
  "pregnancy_nursing_warnings", "pediatric_warnings", "restriction_flags",
];
const leakIntoClinical = new Set();
for (const r of parsed.clinical) {
  for (const f of COMMERCIAL_ONLY_FIELDS) if (f in r) leakIntoClinical.add(f);
}
const leakIntoCommercial = new Set();
for (const r of parsed.commercial) {
  for (const f of CLINICAL_ONLY_FIELDS) if (f in r) leakIntoCommercial.add(f);
}
check(
  "§3.6 no commercial field appears on a clinical record",
  leakIntoClinical.size === 0,
  [...leakIntoClinical].join(", "),
);
check(
  "§3.6 no clinical label fact appears on a commercial record",
  leakIntoCommercial.size === 0,
  [...leakIntoCommercial].join(", "),
);

const linked = parsed.commercial.filter((r) => r.link_status === "linked").length;
check(
  "§3.6 only governed-identifier commercial links are `linked`",
  linked === manifest.counts?.commercial_link_status?.linked,
  `${linked} linked; the rest are pending and must not be attached`,
);

// §3.4 — no conflict packet may be auto-resolvable.
const autoResolvable = parsed.conflicts.filter(
  (c) => c.practitioner_decision_required !== true,
);
check(
  "§3.4 every conflict packet requires a practitioner decision",
  autoResolvable.length === 0,
  `${autoResolvable.length} packet(s) not marked`,
);

// §3.7 — restriction flags present in at least the declared volume.
const withFlags = parsed.clinical.filter(
  (r) => Array.isArray(r.restriction_flags) && r.restriction_flags.length > 0,
).length;
check(
  "§3.7 restriction-flagged record count matches the manifest",
  withFlags === manifest.counts?.records_with_restriction_flags,
  `${withFlags} flagged`,
);

// §4 — the forbidden vocabulary must not appear as a STATUS anywhere.
const FORBIDDEN_STATUS = /"(status|state|disposition)"\s*:\s*"(verified|approved|clinically_approved|safe|recommended)"/;
let forbiddenHits = 0;
for (const name of Object.values(files)) {
  const p = join(pkgDir, name);
  if (existsSync(p) && FORBIDDEN_STATUS.test(readFileSync(p, "utf8"))) forbiddenHits += 1;
}
check(
  "§4 no record carries a verified/approved/safe/recommended status",
  forbiddenHits === 0,
  `${forbiddenHits} file(s)`,
);

/* -------------------------------------------------------------- reporting */

const width = Math.max(...results.map((r) => r.name.length)) + 2;
console.log("\nPhase 9F — authorized research package preflight");
console.log(`package: ${pkgDir}`);
console.log("(read-only: nothing is written, repaired, or imported)\n");
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)} ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nPREFLIGHT FAILED — the package is not importable as delivered.");
  console.log("Do not repair it here. Report the exact check to the package author.");
  process.exit(1);
}
console.log("\nPREFLIGHT PASS — the package matches every declared invariant.");
console.log("Import remains gated on a signed-in practitioner no-PHI attestation.");
process.exit(0);
