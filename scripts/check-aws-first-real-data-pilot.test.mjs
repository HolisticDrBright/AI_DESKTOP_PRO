import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./check-aws-first-real-data-pilot.mjs", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const directory = mkdtempSync(join(tmpdir(), "real-data-pilot-"));
const manifestPath = join(directory, "manifest.json");
const controls = [
  "hipaa_eligible_service_review", "risk_analysis", "minimum_necessary_data_flow",
  "vendor_inventory_for_enabled_path", "privacy_and_consent_review", "workforce_cognito",
  "consumer_cognito", "tenant_and_role_isolation", "delivery_time_consent", "durable_audit",
  "security_monitoring", "backup_restore_rehearsal", "incident_response_rehearsal",
  "vulnerability_gate", "mobile_secure_storage_review", "clinical_safety_review",
  "exact_build_synthetic_e2e", "rollback_rehearsal", "pilot_observation_and_kill_switch",
];
const boundaries = {
  desktop_compute: "ecs_fargate", patient_api_compute: "ecs_fargate",
  clinical_database: "aurora_postgresql", workforce_identity: "cognito",
  consumer_identity: "cognito", object_storage: "s3_kms", desktop_scope: "lab_intake_only",
  organization_scope: "single_named_organization", supabase_phi_path: "disabled",
  fly_phi_path: "disabled", app_runner_phi_path: "disabled", junction: "disabled",
  passio: "disabled", clinical_ai: "disabled", billing: "disabled", messaging: "disabled",
  protocol_activation: "disabled",
};
const approvals = Object.fromEntries([
  "legal_compliance", "security", "clinical_safety", "engineering", "pilot_owner",
].map((name) => [name, { status: "approved", reviewer: `${name}-owner`, reviewed_at: "2026-08-26T18:00:00Z" }]));
const base = {
  schema_version: "first-real-data-pilot-readiness/1", environment: "production-clinical",
  scope: "lab_intake_only", aws_account_id: "173535830222", synthetic_account_id: "588966314750",
  region: "us-east-2", pilot_organization_id: "11111111-1111-4111-8111-111111111111",
  controlled_identity_record: "controlled-record-1",
  aws_organizations_baa: { status: "active", effective_date: "2026-08-18", evidence_reference: "controlled-baa-1" },
  controls: Object.fromEntries(controls.map((name) => [name, "approved"])),
  runtime_boundaries: boundaries,
  evidence: {
    desktop_source_commit: "a".repeat(40), v2_source_commit: "b".repeat(40),
    desktop_image_digest: `sha256:${"c".repeat(64)}`, patient_api_image_digest: `sha256:${"d".repeat(64)}`,
    synthetic_e2e_sha256: "e".repeat(64), rollback_sha256: "f".repeat(64),
  },
  approvals, phi_activation: "approved",
};

function run(manifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, manifestPath], { encoding: "utf8" });
}

assert.equal(run(base).status, 0);
const expandedControls = [
  "apple_health_physical_device_e2e", "android_health_connect_physical_device_e2e",
  "reproductive_health_consent_review", "reproductive_health_withdrawal_e2e",
  "ai_provider_baa_and_retention_review", "measured_data_only_ai_e2e",
  "cycle_and_wearable_minimum_necessary_review", "ai_safety_and_escalation_review",
];
const expanded = {
  ...base,
  scope: "lab_intake_wearables_cycle_ai",
  controls: { ...base.controls, ...Object.fromEntries(expandedControls.map((name) => [name, "approved"])) },
  runtime_boundaries: {
    ...boundaries,
    desktop_scope: "lab_intake_wearables_cycle_ai", clinical_ai: "governed_aws_endpoint",
    wearables: "device_health_import", reproductive_health: "explicit_consent",
    daily_guidance_inputs: "measured_data_only",
  },
};
assert.equal(run(expanded).status, 0);
assert.notEqual(run({ ...expanded, controls: { ...expanded.controls, measured_data_only_ai_e2e: "blocked" } }).status, 0);
assert.notEqual(run({ ...base, scope: "all_features" }).status, 0);
assert.notEqual(run({ ...base, aws_account_id: base.synthetic_account_id }).status, 0);
assert.notEqual(run({ ...base, pilot_organization_id: "00000000-0000-0000-0000-000000000000" }).status, 0);
assert.notEqual(run({ ...base, runtime_boundaries: { ...boundaries, junction: "enabled" } }).status, 0);
assert.notEqual(run({ ...base, controls: { ...base.controls, risk_analysis: "blocked" } }).status, 0);
assert.notEqual(run({ ...base, approvals: {} }).status, 0);
assert.notEqual(run({ ...base, phi_activation: "blocked" }).status, 0);
console.log("First real-data pilot fail-closed checks passed.");
