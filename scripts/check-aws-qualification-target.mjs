// Validates a filled qualification target manifest offline, before anything is deployed or run: shape, posture, account,
// region, the staging refusals, placeholders, the designated identities and every candidate stack name. With no argument
// it checks the committed example, which must stay a valid shape and must stay refused as a run target (its placeholders).
// No AWS call, no credential, no network. `npm run check:aws-qualification-target -- path/to/qualification-target.json`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const file = process.argv[2] ?? "infra/aws-clinical-core/qualification-target.example.json";
const expectExample = process.argv.length < 3;
if (!existsSync(file)) { console.error(JSON.stringify({ ok: false, error: "target_manifest_missing", file })); process.exit(2); }

// The validator is the same module the runners and CLIs use; it is bundled here so this check cannot drift from them.
const out = mkdtempSync(path.join(tmpdir(), "qualification-target-check-"));
const entry = path.join(out, "entry.mjs");
writeFileSync(entry, `
import { loadQualificationTargetManifest, designatedSubjects } from ${JSON.stringify(path.resolve("src/server/clinical-core/qualification-target-manifest.ts"))};
const manifest = loadQualificationTargetManifest(process.argv[2]);
console.log(JSON.stringify({ ok: true, account: manifest.awsAccountId, region: manifest.awsRegion, apiOrigin: manifest.apiOrigin,
  database: manifest.databaseName, exportBucket: manifest.exportBucket, recordingBucket: manifest.recordingBucket,
  sourceCommit: manifest.sourceCommit, migrationReleaseHash: manifest.migrationReleaseHash,
  designatedSubjects: designatedSubjects(manifest.identitySubjects).length, stacks: Object.keys(manifest.stacks).length,
  refuses: manifest.refused }));
`);
const bundle = path.join(out, "check.cjs");
execFileSync("npx", ["esbuild", entry, "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`, "--log-level=error"], { stdio: ["ignore", "ignore", "inherit"] });

let printed;
try { printed = execFileSync("node", [bundle, path.resolve(file)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
catch (error) {
  const message = String(error.stderr ?? error.message ?? "");
  const category = message.match(/target_[a-z_]+/)?.[0] ?? "target_manifest_invalid";
  const field = message.match(/QualificationTargetManifestError[\s\S]*?field:\s*'([a-zA-Z]+)'/)?.[1];
  if (expectExample && category === "target_placeholder") {
    console.log(JSON.stringify({ ok: true, example: file, refusedAsRunTarget: "target_placeholder", note: "the committed example is a valid shape and is refused as a run target until it is filled" }));
    process.exit(0);
  }
  console.error(JSON.stringify({ ok: false, error: category, ...(field ? { field } : {}), file }));
  process.exit(1);
}
if (expectExample) { console.error(JSON.stringify({ ok: false, error: "example_must_stay_unfilled", file })); process.exit(1); }
process.stdout.write(printed);
