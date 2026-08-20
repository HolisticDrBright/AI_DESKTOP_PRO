import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "infra/aws-clinical-core/production-readiness.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.error("Production readiness refused: the reviewed local manifest is missing or invalid.");
  process.exit(1);
}

const blockers = [];
const requiredControls = [
  "dedicated_production_account",
  "hipaa_eligible_service_review",
  "risk_analysis",
  "vendor_baa_inventory",
  "workforce_cognito",
  "consumer_cognito",
  "tenant_isolation",
  "consent_enforcement",
  "durable_audit",
  "organization_cloudtrail",
  "guardduty",
  "security_hub",
  "aws_config",
  "access_analyzer",
  "backup_restore_rehearsal",
  "incident_response_rehearsal",
  "vulnerability_gate",
  "mobile_secure_storage_review",
  "junction_approval",
  "passio_approval",
  "clinical_ai_approval",
  "desktop_compatibility_contract",
];
const requiredApprovals = ["legal_compliance", "security", "clinical_safety", "engineering"];
const requiredRuntimeBoundaries = {
  desktop_compute: "ecs_fargate",
  patient_api_compute: "ecs_fargate",
  clinical_database: "aurora_postgresql",
  workforce_identity: "cognito",
  consumer_identity: "cognito",
  object_storage: "s3_kms",
  app_runner_removed: "approved",
  fly_removed: "approved",
  supabase_saas_removed: "approved",
  migration_reconciled: "approved",
  desktop_operations_migrated: "approved",
  forbidden_phi_services_absent: "approved",
};
if (manifest.schema_version !== 1) blockers.push("schema_version");
if (manifest.environment !== "production-clinical") blockers.push("environment");
if (!/^\d{12}$/.test(manifest.aws_account_id ?? "") || manifest.aws_account_id === "000000000000") blockers.push("aws_account_id");
if (manifest.aws_account_id === manifest.synthetic_account_id) blockers.push("dedicated_production_account");
if (manifest.region !== "us-east-2") blockers.push("reviewed_region");
if (manifest.aws_organizations_baa?.status !== "active") blockers.push("aws_organizations_baa");
if (!String(manifest.aws_organizations_baa?.evidence_reference ?? "").trim() || manifest.aws_organizations_baa.evidence_reference.startsWith("REPLACE_")) {
  blockers.push("baa_evidence_reference");
}

for (const name of requiredControls) {
  if (manifest.controls?.[name] !== "approved") blockers.push(`control:${name}`);
}
for (const [name, expected] of Object.entries(requiredRuntimeBoundaries)) {
  if (manifest.runtime_boundaries?.[name] !== expected) blockers.push(`runtime_boundary:${name}`);
}
for (const name of requiredApprovals) {
  const approval = manifest.approvals?.[name];
  if (approval?.status !== "approved" || !String(approval?.reviewer ?? "").trim() || !/^\d{4}-\d{2}-\d{2}T/.test(approval?.reviewed_at ?? "")) {
    blockers.push(`approval:${name}`);
  }
}
if (manifest.phi_activation !== "approved") blockers.push("phi_activation");

if (blockers.length) {
  console.error("Production PHI activation refused. Open blockers:");
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ready: true,
  environment: manifest.environment,
  account: manifest.aws_account_id,
  region: manifest.region,
  baa: "active",
  controls: requiredControls.length,
  runtime_boundaries: Object.keys(requiredRuntimeBoundaries).length,
  approvals: requiredApprovals.length,
}));
