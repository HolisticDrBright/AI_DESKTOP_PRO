import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runExportRetentionAcceptance } from "./export-retention-acceptance";

/** Hosted runner. Requires the caller (the PowerShell wrapper) to have pinned the AWS account with STS and to pass it in;
 * the harness refuses a mismatch and the production account. Tokens are read from the process environment only. */
async function main() {
  const migrations = JSON.parse(readFileSync("dist/aws-clinical-core/production-migrations/manifest.json", "utf8")) as { migrations: Array<{ version: string; file: string }> };
  const releaseHash = createHash("sha256").update(migrations.migrations.map((m) => `${m.version}:${createHash("sha256").update(readFileSync(`dist/aws-clinical-core/production-migrations/${m.file}`)).digest("hex")}`).join("\n")).digest("hex");
  const sourceCommit = process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const report = await runExportRetentionAcceptance({
    apiOrigin: required("CLINICAL_API_ORIGIN"), consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"), workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"),
    foreignConsumerIdToken: process.env.CLINICAL_FOREIGN_CONSUMER_ID_TOKEN || undefined,
    expectedAwsAccountId: required("EXPECTED_AWS_ACCOUNT_ID"), observedAwsAccountId: required("OBSERVED_AWS_ACCOUNT_ID"), sourceCommit, migrationReleaseHash: releaseHash,
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/export-retention-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, report: out, evidenceSha256: report.evidenceSha256, notConfigured: report.steps.filter((s) => s.outcome === "not_configured").map((s) => s.name), retained: report.retained }));
  if (!report.ok) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]; if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed" })); process.exitCode = 1; });
