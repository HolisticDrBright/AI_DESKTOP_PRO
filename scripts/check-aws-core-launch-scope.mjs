// Reconciles the declared Core launch scope with the owned-storage services that
// enforce it. The manifest activates nothing; this gate only refuses drift
// between the declaration, the server allow-lists, the deployment templates and
// the personal posture route that the consumer app reads.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Canonical release bytes are LF; a CRLF checkout is normalized rather than re-pinned.
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };

// Pinned in V2 `expo/__tests__/core-launch-scope.test.ts`; both change together.
export const CORE_LAUNCH_SCOPE_SHA256 = "e2248e1be6329b99d44d6aaa16a428fa8331fa48b937aeab4fb90ea09294f6db";

const manifestText = read("infra/aws-clinical-core/core-launch-scope.json");
const manifest = JSON.parse(manifestText);
const digest = createHash("sha256").update(manifestText).digest("hex");
assert(digest === CORE_LAUNCH_SCOPE_SHA256, `manifest digest ${digest} is not the pinned digest; update both repositories together`);
assert(manifest.contractVersion === "core-launch-scope/1" && manifest.launchTier === "core", "manifest contract or tier is invalid");

const literalList = (source, name) => {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`).exec(source);
  if (!match) throw new Error(`${name} not found`);
  return match[1].split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
};
const storageScopes = literalList(read("src/server/clinical-core/owned-consumer-records.ts"), "OWNED_STORAGE_SCOPES");
const labScopes = literalList(read("src/server/clinical-core/owned-lab-authorization.ts"), "LAB_AUTHORIZATION_SCOPES");
const voiceApi = read("src/server/clinical-core/owned-voice-api.ts");
const voiceScopes = literalList(voiceApi, "const featureEnabled");
const consumerApi = read("src/server/clinical-core/owned-consumer-api.ts");
const collectionBlock = /COLLECTION_SCOPE:Record<[^=]+=\{([\s\S]*?)\n\};/.exec(consumerApi)?.[1] ?? "";
const collectionScopes = [...collectionBlock.matchAll(/:\s*['"]([a-z_]+)['"]/g)].map((match) => match[1]);
assert(collectionScopes.length >= 18, "collection scope map could not be parsed");

const core = manifest.services.personal_storage.coreScopes;
const sorted = (list) => [...list].sort();
assert(JSON.stringify(sorted(core)) === JSON.stringify(sorted(storageScopes)), "Core scopes must equal the server's owned storage scopes exactly; a new scope needs a launch decision");
assert(JSON.stringify(core) === JSON.stringify(sorted(core)), "Core scopes must be listed in sorted order");
for (const scope of collectionScopes) assert(core.includes(scope), `collection scope ${scope} is outside the Core declaration`);

const features = Object.entries(manifest.features);
assert(features.length === 10, "expected ten Core features");
const required = new Set();
for (const [name, feature] of features) {
  assert(["personal_storage", "owned_lab", "owned_voice"].includes(feature.service), `${name} names an unknown service`);
  assert(Array.isArray(feature.scopes) && feature.scopes.length > 0, `${name} has no scopes`);
  for (const scope of feature.scopes ?? []) { assert(core.includes(scope), `${name} requires ${scope}, which is not a Core scope`); required.add(scope); }
}
for (const scope of core) assert(required.has(scope), `Core scope ${scope} is not required by any feature`);
assert(JSON.stringify(manifest.features.lab_document_processing.scopes) === JSON.stringify(sorted(labScopes)), "lab processing feature must require exactly the server's lab authorization scopes");
assert(JSON.stringify(manifest.features.voice_notes.scopes) === JSON.stringify(sorted(voiceScopes)), "voice feature must require exactly the server's voice scopes");
assert(manifest.services.owned_lab.activeValue === sorted(labScopes).join(","), "owned lab active value must match the server's lab scopes");
assert(manifest.services.owned_voice.activeValue === sorted(voiceScopes).join(","), "owned voice active value must match the server's voice scopes");

const allowedValues = (relative) => {
  const match = /AllowedScopes:\{Type:'String',Default:'',AllowedValues:\[([^\]]+)\]\}/.exec(read(relative));
  if (!match) throw new Error(`${relative} AllowedScopes not found`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((item) => item[1]);
};
const labTemplate = read("scripts/build-aws-owned-lab.mjs");
assert(/AllowedValues:\['','ai_context,lab_history'\]/.test(labTemplate) && allowedValues("scripts/build-aws-owned-lab.mjs").includes(manifest.services.owned_lab.activeValue),
  "owned lab template must accept exactly the declared active value");
assert(allowedValues("scripts/build-aws-owned-voice.mjs").includes(manifest.services.owned_voice.activeValue), "owned voice template must accept the declared active value");
const candidate = read("scripts/personal-storage-candidate.mjs");
const candidateScopes = literalList(candidate, "const scopes");
assert(JSON.stringify(sorted(candidateScopes)) === JSON.stringify(core), "personal storage candidate AllowedScopes pattern must accept exactly the Core scopes");
assert(read("scripts/build-aws-personal-storage.mjs").includes("PERSONAL_STORAGE_ALLOWED_SCOPES:''"), "legacy disabled template must keep an empty allow-list");

for (const program of ["peptide_program", "longevity_program"]) assert(manifest.programs[program]?.available === false, `${program} must stay unavailable at launch`);
assert(manifest.clinicSharingPilotScope === "lab_intake_only" && read("src/server/clinical-core/production-pilot-policy.ts").includes('PRODUCTION_PILOT_SCOPE: ProductionPilotScope = "lab_intake_only"'),
  "clinic-sharing pilot scope must match the production pilot policy");

assert(consumerApi.includes("`GET ${BASE}/posture`") && consumerApi.includes("contractVersion:'personal-posture/1'") && consumerApi.includes("enabledScopes:[...c.allowedScopes].sort()"),
  "the personal posture route must publish the deployment's sorted allow-list");
assert(read("scripts/build-aws-personal-storage.mjs").includes("'GET posture'"), "the posture route must be deployed with the personal storage templates");

if (errors.length) {
  for (const error of errors) console.error(`Core launch scope check failed: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Core launch scope check passed: ${core.length} Core scopes, ${features.length} features, lab and voice allow-lists reconciled, add-on programs unavailable, manifest ${digest.slice(0, 12)}.`);
}
