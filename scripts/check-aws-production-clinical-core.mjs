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
assert(manifest.migrations.length === 47, "expected thirteen transformed migrations and thirty-four production overlays");
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
const governedCatalogOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826100000_production_governed_catalog.sql"), "utf8");
const protocolTemplateOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826110000_production_protocol_templates_and_interactions.sql"), "utf8");
const protocolAuditRepair = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826120000_production_protocol_audit_vocabulary_repair.sql"), "utf8");
const reasoningLensOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826130000_production_reasoning_lens_review.sql"), "utf8");
const clinicalPathwayOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826140000_production_clinical_pathway_registry.sql"), "utf8");
const clinicalKnowledgeImportOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826150000_production_clinical_knowledge_import_review.sql"), "utf8");
const clinicalKnowledgeImportRepair = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826151000_production_knowledge_import_url_validation_repair.sql"), "utf8");
const workforceInvitationOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826160000_production_workforce_invitation_claims.sql"), "utf8");
const workforceEmailDigestRepair = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826161000_production_workforce_email_digest_repair.sql"), "utf8");
const knowledgeImportCompatibility = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260826170000_production_knowledge_import_compatibility.sql"), "utf8");
const importReviewWorkspace = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827100000_production_import_review_workspace.sql"), "utf8");
const nutritionWorkspace = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827110000_production_nutrition_workspace.sql"), "utf8");
const billingInventory = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827120000_production_billing_inventory.sql"), "utf8");
const plansEntitlements = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827130000_production_plans_entitlements.sql"), "utf8");
const programsWorkspace = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827140000_production_programs.sql"), "utf8");
const inboxWorkspace = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827150000_production_inbox.sql"), "utf8");
const wearableRecordsOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260827160000_production_consumer_wearable_records.sql"), "utf8");
const patientRelationshipOverlay = readFileSync(path.join(root, "infra", "aws-clinical-core", "production-migrations",
  "20260831120000_production_patient_relationship_access.sql"), "utf8");
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
assert(workforceInvitationOverlay.includes("workforce_identity_directory")
  && workforceInvitationOverlay.includes("email_sha256")
  && !workforceInvitationOverlay.includes("email_canonical")
  && workforceInvitationOverlay.includes("workforce_identity_not_registered")
  && workforceInvitationOverlay.includes("status = 'pending'")
  && workforceInvitationOverlay.includes("clinical_private.require_organization_admin"),
"AWS workforce invitation must resolve a pre-registered identity by digest and remain admin-gated");
assert(workforceEmailDigestRepair.includes("public.digest(_normalized_email,'sha256')")
  && workforceEmailDigestRepair.includes("set search_path = ''"),
"AWS workforce email lookup must schema-qualify pgcrypto under an empty search path");
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
for (const invariant of [
  "Patient app wearable update", "wearablesSharingStatus", "wearableDailyRecords",
  "clinical_private.require_clinical_patient", "limit 30",
]) assert(wearableRecordsOverlay.includes(invariant), `missing consumer wearable invariant ${invariant}`);
assert(combined.includes("'wearable_daily_records'")
  && combined.includes("when 'wearable_daily_records' then 'wearables'"),
"generated production schema lacks the consent-scoped wearable collection");
assert(!/insert\s+into\s+clinical_core\.consumer_clinical_record_versions/i.test(
  wearableRecordsOverlay.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"consumer wearable migration must not seed patient-supplied records");
for (const invariant of [
  "clinical_private.patient_relationship_scope_allowed", "status='active'",
  "access_expires_at>now()", "_scope=any(relationship.granted_scopes)",
  "manual_secure_delivery_required", "granted_scopes='{}'",
  "patient_relationship_events_append_only",
]) assert(patientRelationshipOverlay.includes(invariant), `missing patient relationship invariant ${invariant}`);
for (const operation of [
  "get_patient_relationships", "create_patient_relationship_invitation", "revoke_patient_relationship",
]) assert(patientRelationshipOverlay.includes(`clinical_core.${operation}`),
  `missing patient relationship operation ${operation}`);
assert(!/insert\s+into\s+clinical_core\.patient_relationships/i.test(
  patientRelationshipOverlay.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"patient relationship migration must not seed family identities or access");
for (const operation of [
  "get_product_catalog", "get_product_label_detail", "verify_product_label_version",
  "get_protocol_template_detail", "compare_protocol_template_versions",
  "record_protocol_template_safety_review", "supersede_protocol_template",
]) assert(governedCatalogOverlay.includes(`clinical_core.${operation}`),
  `missing governed catalog operation ${operation}`);
for (const invariant of [
  "catalog_history_append_only", "catalog_product_payload_no_commercial_data",
  "protocol_item_dose_provenance", "organization_admin_required",
  "unsourced_dose_blocks_passed_review", "protocol_template_supersession_cycle",
]) assert(governedCatalogOverlay.includes(invariant), `missing governed catalog invariant ${invariant}`);
for (const operation of [
  "list_protocol_templates", "create_protocol_template", "approve_protocol_template_version",
  "archive_protocol_template", "search_protocol_catalog", "check_protocol_interactions",
  "review_protocol_item_interactions",
]) assert(protocolTemplateOverlay.includes(operation), `missing protocol-template operation ${operation}`);
for (const invariant of [
  "Patient free text was not copied", "reviewed_by_practitioner",
  "automated_check_completed',false", "Client verification claims",
]) assert(protocolTemplateOverlay.includes(invariant), `missing protocol-template invariant ${invariant}`);
for (const action of [
  "sync.provider_registered", "sync.provider_reviewed", "sync.inbound_accepted",
  "protocol.interaction_reviewed", "protocol_template.approved",
]) assert(protocolAuditRepair.includes(action), `missing repaired audit action ${action}`);
for (const operation of [
  "get_reasoning_workspace", "review_hypothesis", "list_desktop_lens_paradigms",
  "list_desktop_lens_domains", "list_desktop_lens_knowledge_sources",
  "get_desktop_lens_evaluation", "list_desktop_question_answers", "set_question_status",
  "dismiss_question", "answer_question", "correct_question_answer", "record_question_note_use",
  "submit_question_feedback", "review_safety_block",
]) assert(reasoningLensOverlay.includes(`clinical_core.${operation}`),
  `missing reasoning/Lens operation ${operation}`);
for (const invariant of [
  "not a medical probability", "nothing is generated or fabricated", "hypothesis_reviews_append_only",
  "question_answers_append_only", "question_transition_refused", "note_question_mismatch",
  "safety_block_already_reviewed",
]) assert(reasoningLensOverlay.includes(invariant), `missing reasoning/Lens invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_reference\.clinical_(?:paradigms|domains|knowledge_sources)/i.test(reasoningLensOverlay)
  && !/function\s+clinical_core\.(?:run|generate|create)_(?:lens|reasoning)/i.test(reasoningLensOverlay),
"reasoning/Lens overlay must not seed references or enable a generation path");
for (const operation of [
  "list_clinical_pathways", "create_clinical_pathway_draft",
  "update_clinical_pathway_draft", "approve_clinical_pathway_version",
]) assert(clinicalPathwayOverlay.includes(`clinical_core.${operation}`),
  `missing clinical pathway operation ${operation}`);
for (const invariant of [
  "clinical_pathway_version_append_only", "approved_clinical_pathway_immutable",
  "clinical_pathway_source_review_required", "knowledge_admin_role_required",
]) assert(clinicalPathwayOverlay.includes(invariant), `missing clinical pathway invariant ${invariant}`);
assert(clinicalPathwayOverlay.includes("affiliateUrl|destinationUrl|discountCode|trackingCode")
  && !/insert\s+into\s+clinical_core\.clinical_pathways/i.test(clinicalPathwayOverlay),
"clinical pathways must be commercially separated and unseeded");
for (const operation of [
  "stage_clinical_knowledge_import", "review_clinical_knowledge_import_item",
  "list_clinical_knowledge_import_batches", "list_clinical_knowledge_import_items",
]) assert(clinicalKnowledgeImportOverlay.includes(`clinical_core.${operation}`),
  `missing clinical knowledge import operation ${operation}`);
for (const invariant of [
  "knowledge_import_no_phi_attestation_required", "knowledge_import_commercial_data_refused",
  "knowledge_import_source_correction_required", "product_label_candidate",
  "knowledge_import_batch_append_only", "knowledge_import_item_source_immutable",
]) assert(clinicalKnowledgeImportOverlay.includes(invariant),
  `missing clinical knowledge import invariant ${invariant}`);
assert(!/insert\s+into\s+(?:clinical_core\.clinical_knowledge_import|clinical_reference\.product_label_candidates)/i
  .test(clinicalKnowledgeImportOverlay.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"clinical knowledge import migration must not seed imports or product candidates");
assert(!/\b(approved|verified)\b\s*[,)]/i.test(
  clinicalKnowledgeImportOverlay.match(/create table clinical_reference\.product_label_candidates[\s\S]*?;/i)?.[0] ?? ""),
"product label candidates must not support approval or verification in the staging queue");
assert(clinicalKnowledgeImportRepair.includes("drop constraint product_label_candidates_source_url_check")
  && clinicalKnowledgeImportRepair.includes("char_length(source_url)<=2000")
  && clinicalKnowledgeImportRepair.includes("char_length(coalesce(_payload->>'sourceUrl','')) not between 9 and 2000")
  && !clinicalKnowledgeImportRepair.includes("{1,1990}"),
"knowledge import URL repair must use scalar length bounds supported by PostgreSQL");
for (const operation of [
  "preview_knowledge_import", "get_knowledge_import_preview", "resolve_knowledge_import_conflict",
  "commit_knowledge_import", "cancel_knowledge_import", "list_label_commercial_links",
  "list_protocol_commercial_links", "get_research_handoff_review",
  "record_research_handoff_item_review",
]) assert(knowledgeImportCompatibility.includes(`clinical_core.${operation}`),
  `missing Desktop knowledge-import compatibility operation ${operation}`);
for (const invariant of [
  "knowledge_import_no_phi_attestation_required", "knowledge_import_commercial_only_refused",
  "knowledge_import_commercial_data_refused", "knowledge_import_conflicts_unresolved",
  "research_handoff_review_required", "approvalState','draft",
  "knowledge_import_conflict_resolutions_append_only", "research_handoff_item_reviews_append_only",
]) assert(knowledgeImportCompatibility.includes(invariant),
  `missing Desktop knowledge-import compatibility invariant ${invariant}`);
assert(!/insert\s+into\s+(?:clinical_core|clinical_reference|commercial_reference)\./i.test(
  knowledgeImportCompatibility.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"Desktop knowledge-import compatibility migration must not seed clinical, reference, or commercial rows");
for (const operation of [
  "approve_knowledge_reference", "attach_commercial_link_to_verified_product",
  "bulk_apply_org_tag", "bulk_assign_reviewer", "bulk_mark_duplicate",
  "clear_catalog_product_restriction", "complete_catalog_product_review",
  "create_knowledge_reference_draft", "create_product_label_draft",
  "get_catalog_review_queue", "get_import_provenance", "get_import_source_inventory",
  "get_restricted_review_history_v2", "get_restricted_review_queue",
  "list_knowledge_references", "list_product_label_versions", "list_warning_resolutions",
  "record_import_source_file", "record_restricted_review_outcome_v2",
  "record_warning_resolution", "resolve_knowledge_import_ambiguity",
  "revoke_commercial_link", "supersede_knowledge_reference",
  "supersede_product_label_version",
]) assert(importReviewWorkspace.includes(`'${operation}'`),
  `missing import-review operation ${operation}`);
for (const invariant of [
  "data_classification='reference_only'", "contains_phi=false",
  "verified_product_label_required", "restrictionsPreserved", "clinicalDataUnchanged",
  "restricted_review_decisions_append_only", "warning_resolutions_append_only",
  "clinical_private.require_knowledge_editor", "from public,clinical_core_api",
]) assert(importReviewWorkspace.includes(invariant), `missing import-review invariant ${invariant}`);
assert(!/insert\s+into\s+(?:clinical_core|clinical_reference|commercial_reference)\./i.test(
  importReviewWorkspace.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"import-review migration must not seed clinical, reference, or commercial rows");
for (const invariant of [
  "invoke_nutrition_operation", "nutrition_safety_review_unresolved",
  "clinical_inputs_require_review", "requires_practitioner_review=true",
  "nutrition_amendments_append_only", "nutrition_events_append_only",
  "affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode",
  "from public,clinical_core_api",
]) assert(nutritionWorkspace.includes(invariant), `missing nutrition invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_core\.nutrition_/i.test(
  nutritionWorkspace.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"nutrition migration must not seed templates, plans, flags, or check-ins");
for (const invariant of [
  "invoke_billing_operation", "card_payment_provider_not_approved",
  "billing_provider_registrations", "check(enabled=false)",
  "inventory_ledger_append_only", "billing_refunds_append_only",
  "patient_credit_entries_append_only", "billing_events_append_only",
  "from public,clinical_core_api",
]) assert(billingInventory.includes(invariant), `missing billing invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_core\.(?:billing_|inventory_|patient_credit_)/i.test(
  billingInventory.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"billing migration must not seed products, invoices, payments, credits, or providers");
for (const invariant of [
  "invoke_plan_operation", "paid_invoice_required", "published_package_not_found",
  "plan_acceptances_append_only", "entitlement_ledger_append_only", "plan_events_append_only",
  "granted_quantity=remaining_quantity+reserved_quantity+consumed_quantity+expired_quantity+refunded_quantity",
  "from public,clinical_core_api",
]) assert(plansEntitlements.includes(invariant), `missing plans invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_core\.(?:billing_plan|plan_acceptance|patient_membership|entitlement|reconciliation_exception)/i.test(
  plansEntitlements.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"plans migration must not seed plans, memberships, entitlements, or exceptions");
for (const invariant of [
  "invoke_program_operation", "program_paid_enrollment_requires_paid_invoice",
  "practitioner_review_note_required", "requires_practitioner_review=true",
  "program_version_events_append_only", "affiliateUrl','destinationUrl','discountCode','trackingCode",
  "from public,clinical_core_api",
]) assert(programsWorkspace.includes(invariant), `missing programs invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_core\.program/i.test(
  programsWorkspace.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"programs migration must not seed templates, programs, enrollments, or progress");
for (const invariant of [
  "invoke_inbox_operation", "provider_not_configured", "sent',false",
  "communication_consent_required", "check(enabled=false)",
  "message_draft_revisions_append_only", "message_ai_reviews_append_only",
  "conversation_events_append_only", "registration_only", "from public,clinical_core_api",
]) assert(inboxWorkspace.includes(invariant), `missing inbox invariant ${invariant}`);
assert(!/insert\s+into\s+clinical_core\.(?:communication_preferences|conversations|messages|message_|conversation_)/i.test(
  inboxWorkspace.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"inbox migration must not seed preferences, conversations, messages, providers, or events");
assert(governedCatalogOverlay.includes("contains_phi boolean not null default false check (contains_phi = false)")
  && governedCatalogOverlay.includes("data_classification text not null default 'reference_only'")
  && !/insert\s+into\s+(?:clinical_reference|commercial_reference)\./i.test(
    governedCatalogOverlay.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "")),
"governed catalog must remain reference-only and must not seed catalog or commercial rows");

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const releaseHash = createHash("sha256").update(combined).digest("hex");
console.log(`Production clinical-core gate passed: ${manifest.migrations.length} migrations, zero seeded rows (${releaseHash}).`);
