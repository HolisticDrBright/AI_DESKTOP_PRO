import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runRecordingAcceptance } from "./recording-acceptance";
import { provisionRecordingAcceptanceEncounter } from "./recording-acceptance-fixture";
import { loadSyntheticAcceptanceManifest } from "./synthetic-fixtures";
import { createRdsDataAdministrativeDatabase } from "./rds-data-database";
import { loadClinicalCoreMigrations } from "./migrations";
import { inspectProductionClinicalCoreMigrations, productionArtifactReleaseHash } from "./production-migrations";
import { assertQualificationDatabaseName } from "./qualification-target";
import { bindQualificationTarget, loadQualificationTargetManifest, QualificationTargetManifestError } from "./qualification-target-manifest";

/** Hosted runner, bound to the reviewed qualification target manifest (`CLINICAL_QUALIFICATION_TARGET`). `fixture` starts
 * (or reuses) the acceptance encounter for the synthetic fixture patient through the administrative path, in the
 * manifest's qualification database only: the database name is re-checked here (never `clinical_core`, never the
 * staging database) and the database's migration ledger must equal the built artifact before the encounter is written,
 * so a direct invocation cannot write into the staging database. `run` drives the recording pipeline against the
 * manifest's API with the workforce and consumer tokens read from the process environment only. The PowerShell wrapper
 * pins the account with STS and passes the observed value; the binding refuses a mismatch, the production account, a
 * stale checkout, another built artifact and any ambient override that disagrees with the manifest. The exit status is
 * the verdict; `ACCEPTANCE_MODE=exploratory` keeps a partial run honest instead. */
async function main() {
  const command = process.argv[2];
  if (command !== "fixture" && command !== "run") throw new Error("acceptance_command_invalid");
  const manifest = loadQualificationTargetManifest(required("CLINICAL_QUALIFICATION_TARGET"));
  const migrations = loadClinicalCoreMigrations(path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations"));
  const sourceCommit = process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const target = bindQualificationTarget(manifest, { awsAccountId: required("OBSERVED_AWS_ACCOUNT_ID"), sourceCommit, migrationReleaseHash: productionArtifactReleaseHash(migrations) }, process.env);
  if (command === "fixture") {
    const synthetic = loadSyntheticAcceptanceManifest(required("CLINICAL_SYNTHETIC_MANIFEST"));
    if (synthetic.awsAccountId !== target.expectedAwsAccountId || synthetic.awsAccountId === "173535830222") throw new Error("boundary_refused");
    if (synthetic.fixture.consumerSubject !== manifest.identitySubjects.consumer || synthetic.fixture.workforceSubject !== manifest.identitySubjects.workforce) throw new Error("boundary_refused");
    assertQualificationDatabaseName(target.database.databaseName, target.database.stagingDatabaseName);
    const database = createRdsDataAdministrativeDatabase({ clusterArn: target.database.clusterArn, secretArn: target.database.secretArn, databaseName: target.database.databaseName, region: target.region }, { purpose: "reviewed_synthetic_migration" });
    const ledger = await inspectProductionClinicalCoreMigrations(database, migrations);
    if (!ledger.ledgerPresent || ledger.missing.length || ledger.mismatched.length || ledger.unknown.length || ledger.artifactReleaseHash !== target.migrationReleaseHash) throw new Error("qualification_schema_incomplete");
    console.log(JSON.stringify({ ok: true, mode: "recording_acceptance_fixture", database: target.database.databaseName, ...(await provisionRecordingAcceptanceEncounter(database, synthetic)) }));
    return;
  }
  const audioFile = process.env.CLINICAL_RECORDING_AUDIO_FILE?.trim();
  const mode = process.env.ACCEPTANCE_MODE?.trim() === "exploratory" ? "exploratory" : "acceptance";
  const report = await runRecordingAcceptance({
    apiOrigin: target.apiOrigin, workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"), consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"),
    encounterId: required("CLINICAL_RECORDING_ENCOUNTER_ID"), jurisdiction: required("CLINICAL_RECORDING_JURISDICTION"), locale: process.env.CLINICAL_RECORDING_LOCALE?.trim() || undefined,
    ...(audioFile ? { audio: { bytes: new Uint8Array(readFileSync(audioFile)), source: "supplied_file" as const } } : {}),
    expectedAwsAccountId: target.expectedAwsAccountId, observedAwsAccountId: target.observedAwsAccountId, sourceCommit: target.sourceCommit, migrationReleaseHash: target.migrationReleaseHash,
    mode, expectedExecution: "qualification",
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/recording-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, report: out, evidenceSha256: report.evidenceSha256, execution: report.execution, unmarkedDenials: report.unmarkedDenials, verdict: report.verdict,
    notConfigured: report.steps.filter((s) => s.outcome === "not_configured").map((s) => `${s.name}:${s.detail ?? ""}`),
    failed: report.steps.filter((s) => s.outcome === "failed").map((s) => `${s.name}:${s.detail ?? ""}`), retained: report.retained }));
  if (!report.ok) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => {
  const category = error instanceof QualificationTargetManifestError ? `${error.category}${error.field ? ":" + error.field : ""}` : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed";
  console.error(JSON.stringify({ ok: false, error: category })); process.exitCode = 1;
});
