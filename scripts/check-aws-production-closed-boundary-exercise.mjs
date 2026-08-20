import fs from "node:fs";

const script = fs.readFileSync("scripts/run-aws-production-closed-boundary-exercise.ps1", "utf8");
const document = fs.readFileSync("docs/aws-production-closed-boundary-exercise.md", "utf8");
const required = [
  "ConfirmPhiDisabled", "173535830222", 'PhiAllowed -ne "false"',
  "production_not_activated", "Unauthenticated clinical request was not refused",
  "logs:CreateLogStream,logs:PutLogEvents", "7,17,0,0,0,0,0,0",
  "DataPlaneEnabled", "SourceVersion", "clinicalRouteCount", "allClinicalRoutesJwt",
  "unsafeLogMatches", "evidenceSha256",
];
const missing = required.filter((entry) => !script.includes(entry));
if (missing.length || !document.includes("does not authorize PHI")
  || !document.includes("incident-response exercise that remains open")) {
  console.error(`Production closed-boundary exercise gate failed: ${missing.join(", ") || "documentation invariant"}`);
  process.exit(1);
}
console.log("Production closed-boundary exercise gate passed: exact source, 21 JWT routes, PHI false, 401/503 refusal, log-only IAM, empty database, alarm and log checks are pinned.");
