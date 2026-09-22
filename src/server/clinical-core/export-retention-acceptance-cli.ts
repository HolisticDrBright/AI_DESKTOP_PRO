import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runExportRetentionAcceptance } from "./export-retention-acceptance";
import { loadClinicalCoreMigrations } from "./migrations";
import { productionArtifactReleaseHash } from "./production-migrations";
import { bindQualificationTarget, loadQualificationTargetManifest, QualificationTargetManifestError } from "./qualification-target-manifest";
import { EXPORT_ACCEPTANCE_CANDIDATES, observeQualificationTarget } from "./qualification-target-observation";

/** Hosted runner, bound to the reviewed qualification target manifest (`CLINICAL_QUALIFICATION_TARGET`): the API origin,
 * account, export bucket, source commit and migration ledger come from it and from nothing else. The PowerShell wrapper
 * pins the account with STS and passes the observed value; the binding refuses a mismatch, the production account, a
 * stale checkout, another built artifact and any ambient override that disagrees with the manifest. Tokens are read from
 * the process environment only.
 *
 * An acceptance verdict is issued only from observations this process made itself: in acceptance mode (the default) it
 * runs `git rev-parse HEAD`, `aws sts get-caller-identity` and `aws cloudformation describe-stacks` for the
 * personal-storage and privacy-operations stacks, and checks their posture, source and resource parameters against the
 * manifest before the first request. `SOURCE_COMMIT` and `OBSERVED_AWS_ACCOUNT_ID` are assertions by whoever set them, so
 * they are never accepted in place of that; a value that disagrees is refused. `ACCEPTANCE_MODE=exploratory` runs a
 * diagnostic on asserted values instead, and its report can never read as acceptance. The exit status is the verdict. */
async function main() {
  const manifest = loadQualificationTargetManifest(required("CLINICAL_QUALIFICATION_TARGET"));
  const migrations = loadClinicalCoreMigrations(path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations"));
  const mode = process.env.ACCEPTANCE_MODE?.trim() === "exploratory" ? "exploratory" : "acceptance";
  // Declared only when the scheduled retention sweep is released and active: the run then waits for the schedule itself
  // to record the removal, because a pending cleanup state is not completed deletion.
  const scheduledMinutes = process.env.SCHEDULED_CLEANUP_WAIT_MINUTES?.trim();
  const scheduledCleanupWaitMs = scheduledMinutes ? Number(scheduledMinutes) * 60_000 : undefined;
  if (scheduledCleanupWaitMs !== undefined && (!Number.isSafeInteger(scheduledCleanupWaitMs) || scheduledCleanupWaitMs <= 0 || scheduledCleanupWaitMs > 3 * 60 * 60_000)) throw new Error("scheduled_cleanup_wait_invalid");
  const observation = mode === "acceptance" ? observeQualificationTarget(manifest, EXPORT_ACCEPTANCE_CANDIDATES) : null;
  const sourceCommit = observation?.sourceCommit ?? (process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  const awsAccountId = observation?.awsAccountId ?? required("OBSERVED_AWS_ACCOUNT_ID");
  const target = bindQualificationTarget(manifest, { awsAccountId, sourceCommit, migrationReleaseHash: productionArtifactReleaseHash(migrations) }, process.env);
  const report = await runExportRetentionAcceptance({
    apiOrigin: target.apiOrigin, consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"), workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"),
    foreignConsumerIdToken: process.env.CLINICAL_FOREIGN_CONSUMER_ID_TOKEN || undefined, staleConsumerIdToken: process.env.CLINICAL_STALE_CONSUMER_ID_TOKEN || undefined,
    expectedAwsAccountId: target.expectedAwsAccountId, observedAwsAccountId: target.observedAwsAccountId, sourceCommit: target.sourceCommit, migrationReleaseHash: target.migrationReleaseHash,
    mode, expectedExecution: "qualification", expectedExportBucket: target.expectedExportBucket, expectedRegion: target.region,
    ...(scheduledCleanupWaitMs === undefined ? {} : { scheduledCleanupWaitMs }),
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/export-retention-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, report: out, evidenceSha256: report.evidenceSha256, execution: report.execution, unmarkedDenials: report.unmarkedDenials, verdict: report.verdict,
    target: observation ? { source: "observed", stacks: observation.stacks } : { source: "asserted_by_caller", stacks: [] },
    notConfigured: report.steps.filter((s) => s.outcome === "not_configured").map((s) => s.name), failed: report.steps.filter((s) => s.outcome === "failed").map((s) => `${s.name}:${s.detail ?? ""}`), retained: report.retained }));
  if (!report.ok) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => {
  const category = error instanceof QualificationTargetManifestError ? `${error.category}${error.field ? ":" + error.field : ""}` : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed";
  console.error(JSON.stringify({ ok: false, error: category })); process.exitCode = 1;
});
