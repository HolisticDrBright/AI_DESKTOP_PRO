// Validates a filled qualification target manifest offline, before anything is deployed or run: shape, posture, account,
// region, the staging refusals, placeholders, the designated identities and every candidate stack name. With no argument
// it checks the committed example, which must stay a valid shape and must stay refused as a run target (its placeholders).
// No AWS call, no credential, no network. `npm run check:aws-qualification-target -- path/to/qualification-target.json`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { buildSync } from "esbuild";
import { tmpdir } from "node:os";
import path from "node:path";

const checkExamples=process.argv[2]==='--examples';
const expectExample = process.argv.length < 3 || checkExamples;
const files=checkExamples?['qualification-target.example.json','qualification-target-messaging.example.json',
  'qualification-target-connections.example.json','qualification-target-credentials.example.json'].map(f=>`infra/aws-clinical-core/${f}`)
  :[process.argv[2] ?? "infra/aws-clinical-core/qualification-target.example.json"];
for(const file of files)if (!existsSync(file)) { console.error(JSON.stringify({ ok: false, error: "target_manifest_missing", file })); process.exit(2); }

// The validator is the same module the runners and CLIs use; it is bundled here so this check cannot drift from them.
const out = mkdtempSync(path.join(tmpdir(), "qualification-target-check-"));
try {
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
buildSync({entryPoints:[entry],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error"});

const results=[];
for(const file of files){
let printed;
try { printed = execFileSync(process.execPath, [bundle, path.resolve(file)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide:true,timeout:30_000 }); }
catch (error) {
  const message = String(error.stderr ?? error.message ?? "");
  const category = message.match(/target_[a-z_]+/)?.[0] ?? "target_manifest_invalid";
  const field = message.match(/QualificationTargetManifestError[\s\S]*?field:\s*'([a-zA-Z]+)'/)?.[1];
  if (expectExample && category === "target_placeholder") {
    results.push({ ok: true, example: file, refusedAsRunTarget: "target_placeholder", note: "the committed example is a valid shape and is refused as a run target until it is filled" });
  } else {
    results.push({ ok: false, error: category, ...(field ? { field } : {}), file });
  }
}
if (printed !== undefined) {
  if (expectExample) results.push({ ok: false, error: "example_must_stay_unfilled", file });
  else results.push(JSON.parse(printed));
}
}
const ok=results.every(result=>result.ok);
const result=checkExamples?{ok,examples:results}:results[0];
(ok?process.stdout:process.stderr).write(JSON.stringify(result)+'\n');
process.exitCode=ok?0:1;
} finally {
  // Only the uniquely created temporary directory is removed, including on refusals.
  rmSync(out,{recursive:true,force:true});
}
