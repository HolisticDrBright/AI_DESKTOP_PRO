import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runRecordingAcceptance } from "./recording-acceptance";
import { provisionRecordingAcceptanceEncounter } from "./recording-acceptance-fixture";
import { loadSyntheticAcceptanceManifest } from "./synthetic-fixtures";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";

/** Hosted runner. `fixture` starts (or reuses) the acceptance encounter for the synthetic fixture patient through the
 * administrative path and prints its id. `run` drives the recording pipeline against the API with the workforce and
 * consumer tokens read from the process environment only; the PowerShell wrapper pins the account with STS first. */
async function main() {
  const command = process.argv[2];
  if (command === "fixture") {
    const manifest = loadSyntheticAcceptanceManifest(required("CLINICAL_SYNTHETIC_MANIFEST"));
    if (manifest.awsAccountId !== required("EXPECTED_AWS_ACCOUNT_ID") || manifest.awsAccountId === "173535830222") throw new Error("boundary_refused");
    const database = createRdsDataAdministrativeDatabase({ clusterArn: required("CLINICAL_DATABASE_CLUSTER_ARN"), secretArn: required("CLINICAL_DATABASE_SECRET_ARN"),
      databaseName: required("CLINICAL_DATABASE_NAME"), region: required("AWS_REGION") }, { purpose: "reviewed_synthetic_migration" });
    console.log(JSON.stringify({ ok: true, mode: "recording_acceptance_fixture", ...(await provisionRecordingAcceptanceEncounter(database, manifest)) }));
    return;
  }
  if (command !== "run") throw new Error("acceptance_command_invalid");
  const migrations = JSON.parse(readFileSync("dist/aws-clinical-core/production-migrations/manifest.json", "utf8")) as { migrations: Array<{ version: string; file: string }> };
  const releaseHash = createHash("sha256").update(migrations.migrations.map((m) => `${m.version}:${createHash("sha256").update(readFileSync(`dist/aws-clinical-core/production-migrations/${m.file}`)).digest("hex")}`).join("\n")).digest("hex");
  const sourceCommit = process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const audioFile = process.env.CLINICAL_RECORDING_AUDIO_FILE?.trim();
  const report = await runRecordingAcceptance({
    apiOrigin: required("CLINICAL_API_ORIGIN"), workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"), consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"),
    encounterId: required("CLINICAL_RECORDING_ENCOUNTER_ID"), jurisdiction: required("CLINICAL_RECORDING_JURISDICTION"), locale: process.env.CLINICAL_RECORDING_LOCALE?.trim() || undefined,
    ...(audioFile ? { audio: { bytes: new Uint8Array(readFileSync(audioFile)), source: "supplied_file" as const } } : {}),
    expectedAwsAccountId: required("EXPECTED_AWS_ACCOUNT_ID"), observedAwsAccountId: required("OBSERVED_AWS_ACCOUNT_ID"), sourceCommit, migrationReleaseHash: releaseHash,
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/recording-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, report: out, evidenceSha256: report.evidenceSha256, notConfigured: report.steps.filter((s) => s.outcome === "not_configured").map((s) => `${s.name}:${s.detail ?? ""}`),
    failed: report.steps.filter((s) => s.outcome === "failed").map((s) => `${s.name}:${s.detail ?? ""}`), retained: report.retained }));
  if (!report.ok) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]; if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed" })); process.exitCode = 1; });
