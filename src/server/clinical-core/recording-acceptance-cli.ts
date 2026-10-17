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
import { assertBoundaryUnchangedSince, observeAcceptanceBoundary, observeQualificationTarget, RECORDING_ACCEPTANCE_CANDIDATES } from "./qualification-target-observation";
import { boundaryDigest, boundarySummary } from "./qualification-target-boundary";

/** Hosted runner, bound to the reviewed qualification target manifest (`CLINICAL_QUALIFICATION_TARGET`). `fixture` starts
 * (or reuses) the acceptance encounter for the synthetic fixture patient through the administrative path, in the
 * manifest's qualification database only: the database name is re-checked here (never `clinical_core`, never the
 * staging database) and the database's migration ledger must equal the built artifact before the encounter is written,
 * so a direct invocation cannot write into the staging database. `run` drives the recording pipeline against the
 * manifest's API with the workforce and consumer tokens read from the process environment only. The PowerShell wrapper
 * pins the account with STS and passes the observed value; the binding refuses a mismatch, the production account, a
 * stale checkout, another built artifact and any ambient override that disagrees with the manifest. The exit status is
 * the verdict; `ACCEPTANCE_MODE=exploratory` keeps a partial run honest instead.
 *
 * Acceptance mode is bounded at the source (qualification-target-boundary.ts): both commands require a clean checkout at
 * the manifest's exact commit and observe every recording candidate before their first write or request, and refuse an
 * asserted SOURCE_COMMIT or OBSERVED_AWS_ACCOUNT_ID that disagrees with what they observed. `fixture` prints its boundary
 * digest and `run` refuses a deployment that differs from it (`CLINICAL_RECORDING_FIXTURE_BOUNDARY`); `run` observes the
 * target again after its last request, and a change between the two invalidates the report. Only `qualified` exits 0. */
async function main() {
  const command = process.argv[2];
  if (command !== "fixture" && command !== "run") throw new Error("acceptance_command_invalid");
  const manifest = loadQualificationTargetManifest(required("CLINICAL_QUALIFICATION_TARGET"));
  const migrations = loadClinicalCoreMigrations(path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations"));
  const mode = process.env.ACCEPTANCE_MODE?.trim() === "exploratory" ? "exploratory" : "acceptance";
  // The fixture writes to the qualification database, so it observes the live target too, whatever the mode; acceptance
  // observes it at the source boundary (a clean exact checkout), and an exploratory fixture as before.
  const before = mode === "acceptance" ? observeAcceptanceBoundary(manifest, RECORDING_ACCEPTANCE_CANDIDATES, { asserted: process.env }) : null;
  const observation = before ?? (command === "fixture" ? observeQualificationTarget(manifest, RECORDING_ACCEPTANCE_CANDIDATES) : null);
  // The run must see the deployment its fixture saw; a stack that changed between the two commands refuses the run here.
  if (before && command === "run") assertBoundaryUnchangedSince(before, process.env.CLINICAL_RECORDING_FIXTURE_BOUNDARY);
  const sourceCommit = observation?.sourceCommit ?? (process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  const awsAccountId = observation?.awsAccountId ?? required("OBSERVED_AWS_ACCOUNT_ID");
  const target = bindQualificationTarget(manifest, { awsAccountId, sourceCommit, migrationReleaseHash: productionArtifactReleaseHash(migrations) }, process.env);
  if (command === "fixture") {
    const synthetic = loadSyntheticAcceptanceManifest(required("CLINICAL_SYNTHETIC_MANIFEST"));
    if (synthetic.awsAccountId !== target.expectedAwsAccountId || synthetic.awsAccountId === "173535830222") throw new Error("boundary_refused");
    if (synthetic.fixture.consumerSubject !== manifest.identitySubjects.consumer || synthetic.fixture.workforceSubject !== manifest.identitySubjects.workforce) throw new Error("boundary_refused");
    assertQualificationDatabaseName(target.database.databaseName, target.database.stagingDatabaseName);
    const database = createRdsDataAdministrativeDatabase({ clusterArn: target.database.clusterArn, secretArn: target.database.secretArn, databaseName: target.database.databaseName, region: target.region }, { purpose: "reviewed_synthetic_migration" });
    const ledger = await inspectProductionClinicalCoreMigrations(database, migrations);
    if (!ledger.ledgerPresent || ledger.missing.length || ledger.mismatched.length || ledger.unknown.length || ledger.artifactReleaseHash !== target.migrationReleaseHash) throw new Error("qualification_schema_incomplete");
    console.log(JSON.stringify({ ok: true, mode: "recording_acceptance_fixture", database: target.database.databaseName, target: { source: "observed", stacks: observation!.stacks },
      boundary: boundaryDigest(observation!), ...(await provisionRecordingAcceptanceEncounter(database, synthetic)) }));
    return;
  }
  const audioFile = process.env.CLINICAL_RECORDING_AUDIO_FILE?.trim();
  const report = await runRecordingAcceptance({
    apiOrigin: target.apiOrigin, workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"), consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"),
    encounterId: required("CLINICAL_RECORDING_ENCOUNTER_ID"), jurisdiction: required("CLINICAL_RECORDING_JURISDICTION"), locale: process.env.CLINICAL_RECORDING_LOCALE?.trim() || undefined,
    ...(audioFile ? { audio: { bytes: new Uint8Array(readFileSync(audioFile)), source: "supplied_file" as const } } : {}),
    expectedAwsAccountId: target.expectedAwsAccountId, observedAwsAccountId: target.observedAwsAccountId, sourceCommit: target.sourceCommit, migrationReleaseHash: target.migrationReleaseHash,
    mode, expectedExecution: "qualification",
    ...(before ? { sourceBoundary: { before, after: () => observeAcceptanceBoundary(manifest, RECORDING_ACCEPTANCE_CANDIDATES) } } : {}),
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/recording-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, qualified: report.qualified, report: out, evidenceSha256: report.evidenceSha256, execution: report.execution, unmarkedDenials: report.unmarkedDenials,
    unverified: report.unverified, verdict: report.verdict, sourceBoundary: boundarySummary(report.sourceBoundary),
    target: observation ? { source: "observed", stacks: observation.stacks } : { source: "asserted_by_caller", stacks: [] },
    notConfigured: report.steps.filter((s) => s.outcome === "not_configured").map((s) => `${s.name}:${s.detail ?? ""}`),
    failed: report.steps.filter((s) => s.outcome === "failed").map((s) => `${s.name}:${s.detail ?? ""}`), retained: report.retained }));
  // Acceptance exits 0 only for a qualified run; exploration keeps its own (never qualified) partial verdict.
  if (!(mode === "acceptance" ? report.qualified : report.ok)) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => {
  const category = error instanceof QualificationTargetManifestError ? `${error.category}${error.field ? ":" + error.field : ""}` : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed";
  console.error(JSON.stringify({ ok: false, error: category })); process.exitCode = 1;
});
