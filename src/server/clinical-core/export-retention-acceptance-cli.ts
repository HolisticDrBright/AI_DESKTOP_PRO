import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runExportRetentionAcceptance } from "./export-retention-acceptance";
import { loadClinicalCoreMigrations } from "./migrations";
import { productionArtifactReleaseHash } from "./production-migrations";
import { bindQualificationTarget, loadQualificationTargetManifest, QualificationTargetManifestError } from "./qualification-target-manifest";

/** Hosted runner, bound to the reviewed qualification target manifest (`CLINICAL_QUALIFICATION_TARGET`): the API origin,
 * account, export bucket, source commit and migration ledger come from it and from nothing else. The PowerShell wrapper
 * pins the account with STS and passes the observed value; the binding refuses a mismatch, the production account, a
 * stale checkout, another built artifact and any ambient override that disagrees with the manifest. Tokens are read from
 * the process environment only. `ACCEPTANCE_MODE=exploratory` keeps a partial run honest; the default is acceptance, in
 * which every case is mandatory and only qualification execution may answer. The exit status is the verdict. */
async function main() {
  const manifest = loadQualificationTargetManifest(required("CLINICAL_QUALIFICATION_TARGET"));
  const migrations = loadClinicalCoreMigrations(path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations"));
  const sourceCommit = process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const target = bindQualificationTarget(manifest, { awsAccountId: required("OBSERVED_AWS_ACCOUNT_ID"), sourceCommit, migrationReleaseHash: productionArtifactReleaseHash(migrations) }, process.env);
  const mode = process.env.ACCEPTANCE_MODE?.trim() === "exploratory" ? "exploratory" : "acceptance";
  const report = await runExportRetentionAcceptance({
    apiOrigin: target.apiOrigin, consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"), workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"),
    foreignConsumerIdToken: process.env.CLINICAL_FOREIGN_CONSUMER_ID_TOKEN || undefined, staleConsumerIdToken: process.env.CLINICAL_STALE_CONSUMER_ID_TOKEN || undefined,
    expectedAwsAccountId: target.expectedAwsAccountId, observedAwsAccountId: target.observedAwsAccountId, sourceCommit: target.sourceCommit, migrationReleaseHash: target.migrationReleaseHash,
    mode, expectedExecution: "qualification", expectedExportBucket: target.expectedExportBucket, expectedRegion: target.region,
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/export-retention-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, report: out, evidenceSha256: report.evidenceSha256, execution: report.execution, unmarkedDenials: report.unmarkedDenials, verdict: report.verdict,
    notConfigured: report.steps.filter((s) => s.outcome === "not_configured").map((s) => s.name), failed: report.steps.filter((s) => s.outcome === "failed").map((s) => `${s.name}:${s.detail ?? ""}`), retained: report.retained }));
  if (!report.ok) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => {
  const category = error instanceof QualificationTargetManifestError ? `${error.category}${error.field ? ":" + error.field : ""}` : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed";
  console.error(JSON.stringify({ ok: false, error: category })); process.exitCode = 1;
});
