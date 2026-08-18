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
  controls: { dedicated_production_account: "approved", risk_analysis: "approved" },
  approvals: { security: { status: "approved", reviewer: "security-owner", reviewed_at: "2026-08-18T12:00:00Z" } },
  phi_activation: "approved",
};

function run(manifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, manifestPath], { encoding: "utf8" });
}

assert.equal(run(base).status, 0);
assert.notEqual(run({ ...base, aws_account_id: base.synthetic_account_id }).status, 0);
assert.notEqual(run({ ...base, controls: { ...base.controls, risk_analysis: "blocked" } }).status, 0);
assert.notEqual(run({ ...base, phi_activation: "blocked" }).status, 0);
console.log("Production readiness fail-closed checks passed.");
