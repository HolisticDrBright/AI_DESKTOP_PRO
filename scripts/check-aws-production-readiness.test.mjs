import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./check-aws-production-readiness.mjs", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const directory = mkdtempSync(join(tmpdir(), "production-readiness-"));
const manifestPath = join(directory, "manifest.json");
const base = {
  schema_version: 1,
  environment: "production-clinical",
  aws_account_id: "111122223333",
  synthetic_account_id: "588966314750",
  region: "us-east-2",
  aws_organizations_baa: { status: "active", effective_date: "2026-08-18", evidence_reference: "controlled-record-1" },
  controls: Object.fromEntries([
    "dedicated_production_account", "hipaa_eligible_service_review", "risk_analysis",
    "vendor_baa_inventory", "workforce_cognito", "consumer_cognito", "tenant_isolation",
    "consent_enforcement", "durable_audit", "organization_cloudtrail", "guardduty",
    "security_hub", "aws_config", "access_analyzer", "backup_restore_rehearsal",
    "incident_response_rehearsal", "vulnerability_gate", "mobile_secure_storage_review",
    "junction_approval", "passio_approval", "clinical_ai_approval", "desktop_compatibility_contract",
  ].map((name) => [name, "approved"])),
  runtime_boundaries: {
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
  },
  approvals: Object.fromEntries(["legal_compliance", "security", "clinical_safety", "engineering"].map((name) => [name, {
    status: "approved", reviewer: `${name}-owner`, reviewed_at: "2026-08-18T12:00:00Z",
  }])),
  phi_activation: "approved",
};

function run(manifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, manifestPath], { encoding: "utf8" });
}

assert.equal(run(base).status, 0);
assert.notEqual(run({ ...base, aws_account_id: base.synthetic_account_id }).status, 0);
assert.notEqual(run({ ...base, controls: { ...base.controls, risk_analysis: "blocked" } }).status, 0);
assert.notEqual(run({ ...base, controls: {} }).status, 0);
assert.notEqual(run({ ...base, runtime_boundaries: { ...base.runtime_boundaries, supabase_saas_removed: "blocked" } }).status, 0);
assert.notEqual(run({ ...base, approvals: {} }).status, 0);
assert.notEqual(run({ ...base, phi_activation: "blocked" }).status, 0);
console.log("Production readiness fail-closed checks passed.");
