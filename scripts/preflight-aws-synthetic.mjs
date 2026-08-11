import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAndValidateTemplate } from "./check-aws-clinical-core.mjs";

export const DEPLOYMENT_MANIFEST_VERSION = "aws-clinical-core-deployment/1";

export function validateSyntheticManifest(manifest) {
  const errors = [];
  const require = (condition, message) => {
    if (!condition) errors.push(message);
  };

  require(manifest?.schema_version === DEPLOYMENT_MANIFEST_VERSION, `schema_version must be ${DEPLOYMENT_MANIFEST_VERSION}`);
  require(manifest?.environment === "synthetic-staging", "environment must be synthetic-staging");
  require(manifest?.data_classification === "synthetic_only", "data_classification must be synthetic_only");
  require(manifest?.contains_phi === false, "contains_phi must be false");
  require(manifest?.real_patient_data_allowed === false, "real_patient_data_allowed must be false");
  require(manifest?.vendor_phi_enabled === false, "vendor_phi_enabled must be false");
  require(manifest?.aws_baa_status === "accepted", "AWS BAA must be accepted before deployment");
  require(/^\d{12}$/.test(manifest?.aws_account_id ?? "") && !/^0{12}$/.test(manifest.aws_account_id), "aws_account_id must be the intended 12-digit account");
  require(manifest?.aws_region === "us-east-2", "aws_region must be the reviewed us-east-2 region");
  require(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(manifest?.budget_alert_email ?? ""), "budget_alert_email must be valid");
  require(Array.isArray(manifest?.allowed_client_origins) && manifest.allowed_client_origins.length > 0, "allowed_client_origins must be a non-empty array");
  for (const origin of manifest?.allowed_client_origins ?? []) {
    try {
      const url = new URL(origin);
      require(url.origin === origin && (url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)), `unapproved client origin: ${origin}`);
    } catch {
      require(false, `invalid client origin: ${origin}`);
    }
  }
  require(typeof manifest?.approvals?.infrastructure_owner === "string" && manifest.approvals.infrastructure_owner.trim().length >= 3, "infrastructure_owner approval is required");
  require(typeof manifest?.approvals?.security_reviewer === "string" && manifest.approvals.security_reviewer.trim().length >= 3, "security_reviewer approval is required");
  require(!Number.isNaN(Date.parse(manifest?.approvals?.reviewed_at ?? "")), "approvals.reviewed_at must be an ISO timestamp");

  return errors;
}

function run() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node scripts/preflight-aws-synthetic.mjs <deployment-manifest.json>");
    process.exitCode = 1;
    return;
  }

  const templateErrors = readAndValidateTemplate();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const errors = [...templateErrors, ...validateSyntheticManifest(manifest)];
  if (errors.length) {
    for (const error of errors) console.error(`AWS synthetic preflight failed: ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    environment: manifest.environment,
    data_classification: manifest.data_classification,
    contains_phi: manifest.contains_phi,
    aws_account_id: manifest.aws_account_id,
    aws_region: manifest.aws_region,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
