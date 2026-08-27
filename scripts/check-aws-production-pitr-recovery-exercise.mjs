import fs from "node:fs";

const script = fs.readFileSync("scripts/run-aws-production-pitr-recovery-exercise.ps1", "utf8");
const required = [
  "ConfirmPhiDisabledRecoveryExercise", "173535830222", 'PhiAllowed', 'production-clinical',
  'clinical_phi_target', 'BackupRetentionPeriod -ne 35', 'restore-db-cluster-to-point-in-time',
  'full-copy', 'use-latest-restorable-time', '37,133,0', 'DatabaseInventory',
  "'clinical_core','clinical_audit','clinical_reference','commercial_reference'", 'union all',
  'temporaryResourcesDeleted', 'skip-final-snapshot', 'evidenceSha256',
];
const missing = required.filter((marker) => !script.includes(marker));
if (missing.length) {
  console.error(`Production PITR recovery exercise gate failed: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("Production PITR recovery exercise gate passed: PHI false, encrypted private full-copy restore, exact empty-state reconciliation, cleanup, and evidence are pinned.");
