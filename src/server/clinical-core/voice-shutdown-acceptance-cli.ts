import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runVoiceShutdownAcceptance, type VoiceInventoryObservation } from "./voice-shutdown-acceptance";
import { loadClinicalCoreMigrations } from "./migrations";
import { productionArtifactReleaseHash } from "./production-migrations";
import { bindQualificationTarget, loadQualificationTargetManifest, QualificationTargetManifestError } from "./qualification-target-manifest";
import { observeQualificationTarget } from "./qualification-target-observation";
import { readVoiceDrainInventory } from "./owned-voice-inventory-reader";

/** Hosted acceptance of the reviewed voice shutdown transition, bound to the same reviewed qualification target manifest
 * as the other harnesses. The owned-voice candidate must be in the drain posture (`Activation=draining`,
 * `QualificationExecution=disabled`, PHI false), which this run observes for itself in acceptance mode before asking the
 * deployment anything. Acceptance reads two inventories directly from the reviewed stack around the HTTP probes.
 * `CLINICAL_VOICE_INVENTORIES` is allowed only for exploratory diagnostics, never as acceptance evidence.
 * Nothing here certifies erasure: the report says so on its face. */
async function main() {
  const manifest = loadQualificationTargetManifest(required("CLINICAL_QUALIFICATION_TARGET"));
  const migrations = loadClinicalCoreMigrations(path.join(process.cwd(), "dist", "aws-clinical-core", "production-migrations"));
  const mode = process.env.ACCEPTANCE_MODE?.trim() === "exploratory" ? "exploratory" : "acceptance";
  const observation = mode === "acceptance" ? observeQualificationTarget(manifest, ["owned-voice"], { posture: "drain" }) : null;
  const sourceCommit = observation?.sourceCommit ?? (process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  const awsAccountId = observation?.awsAccountId ?? required("OBSERVED_AWS_ACCOUNT_ID");
  const target = bindQualificationTarget(manifest, { awsAccountId, sourceCommit, migrationReleaseHash: productionArtifactReleaseHash(migrations) }, process.env);
  const inventoryFile = process.env.CLINICAL_VOICE_INVENTORIES?.trim();
  if (mode === "acceptance" && inventoryFile) throw new Error("asserted_voice_inventories_refused");
  const inventories = inventoryFile ? (JSON.parse(readFileSync(inventoryFile, "utf8")) as VoiceInventoryObservation[]) : undefined;
  if (inventories !== undefined && !Array.isArray(inventories)) throw new Error("voice_inventories_invalid");
  let inventoryRevision: string | undefined;
  const readInventory = async (): Promise<VoiceInventoryObservation> => {
    const result = await readVoiceDrainInventory({account:manifest.awsAccountId,region:manifest.awsRegion,stack:manifest.stacks["owned-voice"]}, async args => {
      const raw = execFileSync("aws",[...args,"--region",manifest.awsRegion,"--output","json","--no-cli-pager"],{
        encoding:"utf8",timeout:30_000,maxBuffer:20_000_000,windowsHide:true,stdio:["ignore","pipe","pipe"],
      });
      return JSON.parse(raw);
    });
    if (inventoryRevision !== undefined && inventoryRevision !== result.configurationRevision) throw new Error("voice_inventory_revision_changed");
    inventoryRevision = result.configurationRevision;
    if(result.version!=="owned-voice-inventory/1"||result.atomicSnapshot!==false||result.deletionCertified!==false)throw new Error("voice_inventory_report_invalid");
    return {version:result.version,atomicSnapshot:result.atomicSnapshot,deletionCertified:result.deletionCertified,
      counts:result.counts,fingerprint:result.fingerprint,observedAt:new Date().toISOString()};
  };
  const report = await runVoiceShutdownAcceptance({
    apiOrigin: target.apiOrigin, consumerIdToken: required("CLINICAL_CONSUMER_ID_TOKEN"), workforceIdToken: required("CLINICAL_WORKFORCE_ID_TOKEN"),
    expectedAwsAccountId: target.expectedAwsAccountId, observedAwsAccountId: target.observedAwsAccountId,
    sourceCommit: target.sourceCommit, migrationReleaseHash: target.migrationReleaseHash, mode, inventories,
    ...(mode === "acceptance" ? {readInventory} : {}),
  });
  mkdirSync("dist/qualification", { recursive: true });
  const out = `dist/qualification/voice-shutdown-acceptance-${report.finishedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ ok: report.ok, report: out, evidenceSha256: report.evidenceSha256, execution: report.execution, verdict: report.verdict, retained: report.retained,
    certifies: report.certifies, target: observation ? { source: "observed", stacks: observation.stacks } : { source: "asserted_by_caller", stacks: [] },
    failed: report.steps.filter((s) => s.outcome === "failed").map((s) => `${s.name}:${s.detail ?? ""}`) }));
  if (!report.ok) process.exitCode = 1;
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error("acceptance_configuration_missing"); return value; }
main().catch((error) => {
  const category = error instanceof QualificationTargetManifestError ? `${error.category}${error.field ? ":" + error.field : ""}` : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "acceptance_failed";
  console.error(JSON.stringify({ ok: false, error: category })); process.exitCode = 1;
});
