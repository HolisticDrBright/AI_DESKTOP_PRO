import fs from "node:fs";

/** Pins the safety markers of the application rollback rehearsal so the script
 * cannot silently lose its account, PHI, hash-verification, change-set review,
 * scope, timing or evidence guarantees. */
const script = fs.readFileSync("scripts/run-aws-application-rollback-rehearsal.ps1", "utf8");
const required = [
  "ConfirmApplicationRollbackRehearsal", "173535830222", 'PhiAllowed must be false', "head-object", "Get-FileHash",
  "Previous artifact hash mismatch", "ReForwardLambdaCodeKey", "UsePreviousValue = $true", "create-change-set", "--use-previous-template",
  "describe-change-set", 'touches resources other than Lambda functions', "ExecuteChangeSet", "execute-change-set", "stack-update-complete",
  "delete-change-set", "CodeSha256", "rollbackStartedAt", "rollbackCompletedAt", "recoveryTimeSeconds", "evidenceSha256",
  "PreviousArtifactSha256", "PreviousSourceVersion",
];
const missing = required.filter((marker) => !script.includes(marker));
const forbidden = ["--force", "delete-stack", "skip-final-snapshot", "sk_live_"].filter((marker) => script.includes(marker));
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`Application rollback rehearsal gate failed, missing: ${missing.join(", ")}`);
  if (forbidden.length) console.error(`Application rollback rehearsal gate failed, forbidden: ${forbidden.join(", ")}`);
  process.exit(1);
}
console.log("Application rollback rehearsal gate passed: account and PHI checks, hash-verified previous artifact, Lambda-only change set review, explicit execution, re-forward key, timings and evidence hash are pinned.");
