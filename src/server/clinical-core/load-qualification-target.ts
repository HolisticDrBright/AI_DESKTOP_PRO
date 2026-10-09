import { execFileSync } from "node:child_process";
import { loadQualificationTargetManifest } from "./qualification-target-manifest";
import { observeQualificationTarget } from "./qualification-target-observation";

/** Only refusal-path load evidence. Neither provider acceptance nor PHI approval. */
export function inspectLoadQualificationTarget(targetPath: string, origin: string) {
  const manifest = loadQualificationTargetManifest(targetPath);
  if (manifest.apiOrigin !== origin) throw new Error("load_target_origin_mismatch");
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
  if (dirty) throw new Error("load_source_dirty");
  const observation = observeQualificationTarget(manifest, ["personal-storage", "owned-lab"]);
  return {
    kind: "hosted_qualification_refusal_only",
    positiveClinicalAcceptance: false,
    activationEvidence: false,
    apiOrigin: manifest.apiOrigin,
    declaredMigrationReleaseHash: manifest.migrationReleaseHash,
    observation,
  };
}
