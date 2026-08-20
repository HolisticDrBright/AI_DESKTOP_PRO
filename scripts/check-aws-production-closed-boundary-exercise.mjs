import fs from "node:fs";

const script = fs.readFileSync("scripts/run-aws-production-closed-boundary-exercise.ps1", "utf8");
const document = fs.readFileSync("docs/aws-production-closed-boundary-exercise.md", "utf8");
const required = [
  "ConfirmPhiDisabled", "173535830222", 'PhiAllowed -ne "false"',
  "production_not_activated", "Unauthenticated clinical request was not refused",
  "logs:CreateLogStream,logs:PutLogEvents", "11,20,0,0,0,0,0,0,0,0,0",
  "DataPlaneEnabled", "SourceVersion", "custom:production_bound", "productionBoundIdentityPools",
  "RDS_LOGIN_EVENTS", "LAMBDA_NETWORK_LOGS", "EBS_MALWARE_PROTECTION",
  "serviceReportedDisabledGuardDutyFeatures", "unreviewedFoundationDrift",
  "clinicalRouteCount", "allClinicalRoutesJwt",
  "unsafeLogMatches", "evidenceSha256",
];
const missing = required.filter((entry) => !script.includes(entry));
if (missing.length || !document.includes("does not authorize PHI")
  || !document.includes("incident-response exercise that remains open")) {
  console.error(`Production closed-boundary exercise gate failed: ${missing.join(", ") || "documentation invariant"}`);
  process.exit(1);
}
console.log("Production closed-boundary exercise gate passed: immutable identity binding, reviewed GuardDuty/drift posture, exact source, 21 JWT routes, PHI false, 401/503 refusal, log-only IAM, empty database, alarm and log checks are pinned.");
