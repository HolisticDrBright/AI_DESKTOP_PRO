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
if (manifest.schema_version !== 1) blockers.push("schema_version");
if (manifest.environment !== "production-clinical") blockers.push("environment");
if (!/^\d{12}$/.test(manifest.aws_account_id ?? "") || manifest.aws_account_id === "000000000000") blockers.push("aws_account_id");
if (manifest.aws_account_id === manifest.synthetic_account_id) blockers.push("dedicated_production_account");
if (manifest.region !== "us-east-2") blockers.push("reviewed_region");
if (manifest.aws_organizations_baa?.status !== "active") blockers.push("aws_organizations_baa");
if (!String(manifest.aws_organizations_baa?.evidence_reference ?? "").trim() || manifest.aws_organizations_baa.evidence_reference.startsWith("REPLACE_")) {
  blockers.push("baa_evidence_reference");
}

for (const [name, status] of Object.entries(manifest.controls ?? {})) {
  if (status !== "approved") blockers.push(`control:${name}`);
}
for (const [name, approval] of Object.entries(manifest.approvals ?? {})) {
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
  controls: Object.keys(manifest.controls).length,
  approvals: Object.keys(manifest.approvals).length,
}));
