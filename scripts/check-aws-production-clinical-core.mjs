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
assert(manifest.migrations.length === 10, "expected six transformed migrations and four production overlays");
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
const auditOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821060000_production_registered_audit_actions.sql"), "utf8");
const membershipOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821070000_production_workforce_memberships.sql"), "utf8");
const reviewQueueOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821080000_production_review_queue.sql"), "utf8");
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
assert(auditOverlay.includes("clinical_core.record_registered_audit_event")
  && auditOverlay.includes("clinical_core.list_audit_events")
  && auditOverlay.includes("clinical_private.assert_production_context")
  && auditOverlay.includes("clinical_private.has_clinical_role"),
"registered audit actions must enforce production context and clinical role");
assert(auditOverlay.includes("where patient.id = _patient_id")
  && auditOverlay.includes("patient.organization_id = _organization_id")
  && auditOverlay.includes("patient.deleted_at is null"),
"registered audit actions must bind patients to the caller organization");
assert(auditOverlay.includes("where event.organization_id = _organization_id")
  && auditOverlay.includes("limit _limit"),
"audit history must be tenant-scoped and bounded");
assert(!/email|date_of_birth|authorization|cookie|payload/i.test(
  auditOverlay.match(/from \(values[\s\S]*?\) as definition/)?.[0] ?? ""),
"registered audit definitions contain a prohibited metadata key");
for (const operation of ["list_my_organizations", "list_org_members", "set_org_member_role", "remove_org_member"]) {
  assert(membershipOverlay.includes(`clinical_core.${operation}`), `missing production membership operation ${operation}`);
}
assert(membershipOverlay.includes("caller.role in ('owner','admin')")
  && membershipOverlay.includes("last_owner_protected")
  && membershipOverlay.includes("self_suspension_refused")
  && membershipOverlay.includes("set status = 'suspended'"),
"membership administration lacks owner/admin, last-owner, self, or retention guards");
assert(!membershipOverlay.includes("add_org_member")
  && !membershipOverlay.includes("activate_my_memberships")
  && !membershipOverlay.includes("_email"),
"production membership overlay must not recreate legacy email invitation or self-activation");
for (const operation of ["create_review_task", "list_review_queue", "resolve_review_queue_item"]) {
  assert(reviewQueueOverlay.includes(`clinical_core.${operation}`), `missing production review operation ${operation}`);
}
assert(reviewQueueOverlay.includes("review_queue_identity_immutable")
  && reviewQueueOverlay.includes("where id = _item_id")
  && reviewQueueOverlay.includes("organization_id = _organization_id")
  && reviewQueueOverlay.includes("note_present")
  && !/['\"]title['\"]\s*,\s*_normalized_title/.test(
    reviewQueueOverlay.match(/insert into clinical_audit\.events[\s\S]*?;/g)?.join("\n") ?? ""),
"review queue lacks immutable identity, tenant scope, or minimum audit content");

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const releaseHash = createHash("sha256").update(combined).digest("hex");
console.log(`Production clinical-core gate passed: 10 migrations, zero seeded rows (${releaseHash}).`);
