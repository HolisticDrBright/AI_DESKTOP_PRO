import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "scripts", "build-aws-production-clinical-core.mjs")], {
  cwd: root,
  stdio: "inherit",
});

const directory = path.join(root, "dist", "aws-clinical-core", "production-migrations");
const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };

assert(manifest.contract_version === "clinical-core-migrations/1", "generated manifest contract is invalid");
assert(manifest.migrations.length === 7, "expected six transformed migrations and one production overlay");
assert(new Set(manifest.migrations.map((entry) => entry.version)).size === manifest.migrations.length,
  "migration versions must be unique");

let previous = "";
let combined = "";
for (const entry of manifest.migrations) {
  assert(/^\d{14}_[a-z0-9_]+\.sql$/.test(entry.file), `invalid migration filename ${entry.file}`);
  assert(entry.version > previous, `migration ${entry.version} is not strictly ordered`);
  previous = entry.version;
  const sql = readFileSync(path.join(directory, entry.file), "utf8");
  assert(sql.trim().length > 0, `${entry.file} is empty`);
  combined += `\n${sql}`;
}

for (const [pattern, description] of [
  [/synthetic/i, "production artifact contains a synthetic marker"],
  [/supabase/i, "production artifact contains a Supabase dependency"],
  [/\bauth\./i, "production artifact contains a provider auth helper"],
  [/\bfly\b/i, "production artifact contains a Fly dependency"],
  [/app\s*runner/i, "production artifact contains an App Runner dependency"],
]) assert(!pattern.test(combined), description);

for (const marker of [
  "environment = 'production-clinical'",
  "data_classification = 'clinical_phi'",
  "contains_phi = true",
  "production_bound = true",
  "clinical_private.assert_production_context",
  "clinical_core.create_patient_profile",
  "clinical_core.review_biomarker",
  "'patient.created'",
  "'lab_observation.reviewed'",
]) assert(combined.includes(marker), `missing production invariant ${marker}`);

const topLevelSql = combined.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "");
assert(!/insert\s+into\s+clinical_core\.(organizations|persons|identities|organization_memberships|patient_records)\b/i
  .test(topLevelSql), "production migrations must not seed organization, identity, membership, or patient rows");

const overlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821050000_production_patient_directory.sql"), "utf8");
assert(overlay.includes("_organization_id uuid") && overlay.includes("_first_name text")
  && overlay.includes("_last_name text") && overlay.includes("_date_of_birth date")
  && overlay.includes("_sex text") && overlay.includes("_mrn text")
  && overlay.includes("_email text") && overlay.includes("_phone text"),
"patient creation signature no longer matches the Desktop contract");
assert(overlay.includes("_observation_id uuid") && overlay.includes("_decision text")
  && overlay.includes("_note text"), "biomarker review signature no longer matches the Desktop contract");
const auditStatements = [...overlay.matchAll(/insert into clinical_audit\.events\([\s\S]*?;/g)]
  .map((match) => match[0]);
const patientAudit = auditStatements.find((statement) => statement.includes("'patient.created'")) ?? "";
const reviewAudit = auditStatements.find((statement) => statement.includes("'lab_observation.reviewed'")) ?? "";
assert(patientAudit.includes("jsonb_build_object('source', 'manual')"),
  "patient audit must contain only the manual-source marker");
assert(!/(_first|_last|_normalized_email|_normalized_phone|date_of_birth)/i.test(patientAudit),
  "patient audit contains identifying field content");
assert(reviewAudit.includes("'note_present', coalesce(char_length(btrim(_note)), 0) > 0")
  && !/['\"]note['\"]\s*,\s*_note/i.test(reviewAudit),
  "review audit must record only note presence, never note content");

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const releaseHash = createHash("sha256").update(combined).digest("hex");
console.log(`Production clinical-core gate passed: 7 migrations, zero seeded rows (${releaseHash}).`);
