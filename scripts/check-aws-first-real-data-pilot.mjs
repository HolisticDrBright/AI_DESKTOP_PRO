import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "infra/aws-clinical-core/first-real-data-pilot-readiness.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.error("First real-data pilot refused: the reviewed local manifest is missing or invalid.");
  process.exit(1);
}

const blockers = [];
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requiredControls = [
  "hipaa_eligible_service_review", "risk_analysis", "minimum_necessary_data_flow",
  "vendor_inventory_for_enabled_path", "privacy_and_consent_review", "workforce_cognito",
  "consumer_cognito", "tenant_and_role_isolation", "delivery_time_consent", "durable_audit",
  "security_monitoring", "backup_restore_rehearsal", "incident_response_rehearsal",
  "vulnerability_gate", "mobile_secure_storage_review", "clinical_safety_review",
  "exact_build_synthetic_e2e", "rollback_rehearsal", "pilot_observation_and_kill_switch",
];
const requiredBoundaries = {
  desktop_compute: "ecs_fargate",
  patient_api_compute: "ecs_fargate",
  clinical_database: "aurora_postgresql",
  workforce_identity: "cognito",
  consumer_identity: "cognito",
  object_storage: "s3_kms",
  desktop_scope: "lab_intake_only",
  organization_scope: "single_named_organization",
  supabase_phi_path: "disabled",
  fly_phi_path: "disabled",
  app_runner_phi_path: "disabled",
  junction: "disabled",
  passio: "disabled",
  clinical_ai: "disabled",
  billing: "disabled",
  messaging: "disabled",
  protocol_activation: "disabled",
};
const requiredApprovals = ["legal_compliance", "security", "clinical_safety", "engineering", "pilot_owner"];

if (manifest.schema_version !== "first-real-data-pilot-readiness/1") blockers.push("schema_version");
if (manifest.environment !== "production-clinical") blockers.push("environment");
if (manifest.scope !== "lab_intake_only") blockers.push("scope");
if (!/^\d{12}$/.test(manifest.aws_account_id ?? "") || manifest.aws_account_id === manifest.synthetic_account_id) {
  blockers.push("dedicated_production_account");
}
if (manifest.region !== "us-east-2") blockers.push("region");
if (!UUID.test(manifest.pilot_organization_id ?? "")
  || manifest.pilot_organization_id === "00000000-0000-0000-0000-000000000000") {
  blockers.push("pilot_organization_id");
}
if (!String(manifest.controlled_identity_record ?? "").trim()
  || String(manifest.controlled_identity_record).startsWith("REPLACE_")) blockers.push("controlled_identity_record");
if (manifest.aws_organizations_baa?.status !== "active"
  || !String(manifest.aws_organizations_baa?.evidence_reference ?? "").trim()
  || String(manifest.aws_organizations_baa?.evidence_reference).startsWith("REPLACE_")) blockers.push("aws_baa_evidence");

for (const control of requiredControls) {
  if (manifest.controls?.[control] !== "approved") blockers.push(`control:${control}`);
}
for (const [boundary, expected] of Object.entries(requiredBoundaries)) {
  if (manifest.runtime_boundaries?.[boundary] !== expected) blockers.push(`runtime_boundary:${boundary}`);
}
for (const approvalName of requiredApprovals) {
  const approval = manifest.approvals?.[approvalName];
  if (approval?.status !== "approved" || !String(approval?.reviewer ?? "").trim()
    || !/^\d{4}-\d{2}-\d{2}T/.test(approval?.reviewed_at ?? "")) blockers.push(`approval:${approvalName}`);
}
for (const name of ["desktop_source_commit", "v2_source_commit"]) {
  if (!COMMIT.test(manifest.evidence?.[name] ?? "")) blockers.push(`evidence:${name}`);
}
for (const name of ["synthetic_e2e_sha256", "rollback_sha256"]) {
  if (!SHA.test(manifest.evidence?.[name] ?? "")) blockers.push(`evidence:${name}`);
}
for (const name of ["desktop_image_digest", "patient_api_image_digest"]) {
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.evidence?.[name] ?? "")) blockers.push(`evidence:${name}`);
}
if (manifest.phi_activation !== "approved") blockers.push("phi_activation");

if (blockers.length) {
  console.error("First real-data pilot activation refused. Open blockers:");
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ready: true,
  scope: manifest.scope,
  account: manifest.aws_account_id,
  region: manifest.region,
  pilotOrganizationId: manifest.pilot_organization_id,
  controls: requiredControls.length,
  runtimeBoundaries: Object.keys(requiredBoundaries).length,
  approvals: requiredApprovals.length,
}));
