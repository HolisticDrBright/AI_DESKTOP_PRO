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
assert(manifest.migrations.length === 21, "expected seven transformed migrations and fourteen production overlays");
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
const schedulingOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821090000_production_scheduling.sql"), "utf8");
const encounterOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821100000_production_encounters_notes.sql"), "utf8");
const overviewOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821110000_production_patient_overview.sql"), "utf8");
const syncControlOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821120000_production_patient_sync_control.sql"), "utf8");
const syncInvitationRepair = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260821121000_production_patient_sync_invitation_pgcrypto.sql"), "utf8");
const syncDeliveryOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260825100000_production_patient_sync_delivery_controls.sql"), "utf8");
const syncWorkerOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260825120000_production_patient_sync_worker.sql"), "utf8");
const syncLabSummaryRepair = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260825123000_production_sync_lab_summary_observed_at.sql"), "utf8");
const patientAppIntakeOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260825140000_production_consumer_health_intake_review.sql"), "utf8");
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
for (const operation of [
  "get_desktop_calendar", "book_appointment", "update_appointment_status",
  "reschedule_appointment", "transition_appointment", "correct_appointment_status",
]) {
  assert(schedulingOverlay.includes(`clinical_core.${operation}`), `missing production scheduling operation ${operation}`);
}
assert(schedulingOverlay.includes("appointment_status_events_append_only")
  && schedulingOverlay.includes("appointment_transition_allowed")
  && schedulingOverlay.includes("appointment_overlap")
  && schedulingOverlay.includes("appointment_version_conflict")
  && schedulingOverlay.includes("idempotency_key")
  && schedulingOverlay.includes("organization_admin_required")
  && schedulingOverlay.includes("pg_catalog.pg_advisory_xact_lock"),
"scheduling lacks append-only history, state, overlap, concurrency, idempotency, admin-correction, or locking guards");
const schedulingAudits = schedulingOverlay.match(/insert into clinical_audit\.events[\s\S]*?;/g)?.join("\n") ?? "";
assert(!/['\"](?:title|location|telehealth_url|reason)['\"]\s*,\s*_(?:title|location|telehealth_url|reason)/i.test(schedulingAudits)
  && schedulingAudits.includes("reason_present"),
"scheduling audit must retain only bounded facts, never appointment content");
for (const operation of [
  "start_encounter", "set_encounter_status", "save_note_draft", "mark_note_ready", "sign_note",
  "add_note_addendum", "mark_note_error", "get_desktop_encounter",
  "list_desktop_patient_encounters", "get_desktop_note", "get_desktop_patient_timeline",
]) assert(encounterOverlay.includes(`clinical_core.${operation}`), `missing production encounter operation ${operation}`);
for (const invariant of [
  "clinical_note_versions_freeze", "clinical_note_versions_append_only", "note_signatures_append_only",
  "note_addenda_append_only", "note_version_conflict", "note_content_frozen",
  "note_provenance_freeze", "content_sha256", "appointment_patient_mismatch",
  "appointments_identity_patient_uniq", "require_clinical_patient",
]) assert(encounterOverlay.includes(invariant), `missing encounter/note invariant ${invariant}`);
const noteAudits = encounterOverlay.match(/insert into clinical_audit\.events[\s\S]*?;/g)?.join("\n") ?? "";
assert(!/['\"](?:content|reason|status_reason)['\"]\s*,\s*_(?:content|reason)/i.test(noteAudits)
  && noteAudits.includes("reason_present"), "encounter/note audit contains clinical content or lacks presence-only reason evidence");
assert(overviewOverlay.includes("clinical_core.get_patient_overview")
  && overviewOverlay.includes("clinical_private.require_clinical_patient")
  && overviewOverlay.includes("'hasEmail',_patient.email is not null")
  && overviewOverlay.includes("'allergies','[]'::jsonb")
  && overviewOverlay.includes("'No allergy list recorded'")
  && overviewOverlay.includes("limit 10"),
"patient overview lacks tenant gate, contact minimization, explicit missing-data state, or bounded changes");
for (const operation of [
  "create_sync_invitation", "pause_sync_connection", "resume_sync_connection",
  "revoke_sync_connection", "set_sync_consent_scope", "get_patient_sync_overview",
  "get_org_sync_operations",
]) assert(syncControlOverlay.includes(`clinical_core.${operation}`), `missing production sync-control operation ${operation}`);
assert(syncInvitationRepair.includes("public.gen_random_bytes(8)")
  && syncInvitationRepair.includes("substr(translate(rtrim(encode")
  && syncInvitationRepair.includes("public.digest(_token,'sha256')")
  && syncInvitationRepair.includes("security definer set search_path = ''")
  && syncControlOverlay.includes("'approved_consent_artifact_required'")
  && syncControlOverlay.includes("'lab_results_import'")
  && syncControlOverlay.includes("connection_version_conflict")
  && syncControlOverlay.includes("connection_revoked")
  && syncControlOverlay.includes("provider.state='active'"),
"sync controls lack short one-time code hashing, governed consent, lab scope, concurrency, revocation, or provider gate");
const syncAudits = syncControlOverlay.match(/insert into clinical_audit\.events[\s\S]*?;/g)?.join("\n") ?? "";
assert(!/['"]reason['"]\s*,\s*_reason/i.test(syncAudits)
  && syncAudits.includes("'reason_present',true"),
"sync audit must retain reason presence only, never reason text");
for (const operation of [
  "queue_sync_export", "withdraw_sync_resource", "retry_sync_event", "cancel_sync_event",
  "resolve_sync_conflict", "review_sync_inbound", "record_sync_inbound_correction",
]) assert(syncDeliveryOverlay.includes(`clinical_core.${operation}`), `missing production sync delivery operation ${operation}`);
for (const invariant of [
  "active_sync_provider_required", "consent_required", "consent_revoke_cancels_sync",
  "sync_event_content_immutable", "sync_inbound_corrections_append_only",
  "governed_product_review_required", "chartMaterialized',false", "deliveryEnabled',false",
]) assert(syncDeliveryOverlay.includes(invariant), `missing sync delivery invariant ${invariant}`);
const syncDeliveryAudits = syncDeliveryOverlay.match(/insert into clinical_audit\.events[\s\S]*?;/g)?.join("\n") ?? "";
assert(!/['"](?:reason|note|payload)['"]\s*,\s*_(?:reason|note|payload)/i.test(syncDeliveryAudits)
  && syncDeliveryAudits.includes("'reason_present',true"),
"sync delivery audits must never contain payload/reason/note content");

for (const operation of [
  "register_sync_provider", "review_sync_provider", "claim_sync_outbound", "recheck_sync_export",
  "record_sync_delivery", "record_sync_inbound", "record_sync_lab_result",
  "record_sync_worker_cycle", "register_sync_callback_nonce",
]) assert(syncWorkerOverlay.includes(`clinical_core.${operation}`), `missing AWS sync worker operation ${operation}`);
for (const invariant of [
  "clinical_sync_worker nologin noinherit", "sync_worker_role_required", "for update of e skip locked",
  "lab_import_consent_required", "chartMaterialized',false", "deliveryEnabled',false",
  "sync_delivery_events_append_only", "sync_callback_nonces_append_only",
]) assert(syncWorkerOverlay.includes(invariant), `missing AWS sync worker invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_core\.sync_providers[\s\S]*?'active'/i.test(
  syncWorkerOverlay.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"AWS sync worker migration must not seed or approve a provider");
assert(syncLabSummaryRepair.includes("max(o.observed_at)")
  && syncLabSummaryRepair.includes("'lastObservedAt'")
  && !syncLabSummaryRepair.includes("max(o.collected_at)"),
"lab summary repair must project the governed observation timestamp");
assert(patientAppIntakeOverlay.includes("clinical_core.get_patient_app_intake")
  && patientAppIntakeOverlay.includes("clinical_private.require_clinical_patient")
  && patientAppIntakeOverlay.includes("scope = 'forms_checkins'")
  && patientAppIntakeOverlay.includes("Patient app health intake update")
  && patientAppIntakeOverlay.includes("distinct on (r.record_key)"),
"patient app intake lacks consent status, patient access, review task, or current-version projection");
assert(!/insert\s+into\s+clinical_core\.patient_records/i.test(patientAppIntakeOverlay),
"patient app intake must not silently overwrite the practitioner-authored patient record");

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const releaseHash = createHash("sha256").update(combined).digest("hex");
console.log(`Production clinical-core gate passed: 21 migrations, zero seeded rows (${releaseHash}).`);
