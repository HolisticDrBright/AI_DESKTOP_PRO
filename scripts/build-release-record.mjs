#!/usr/bin/env node
// Release record: one machine-readable statement of exactly which sources and built artifacts a deployment is made of.
// It records hashes of what exists on disk right now (source commit, production migration artifact, every built
// candidate template and bundle, the drafting prompt artifact, the Core launch scope, the catalog migrations) and says
// plainly which artifacts are not built. `--verify <record.json>` recomputes and reports every difference. It deploys
// nothing and reads no AWS state; the deployed versions (function code SHA-256, stack parameters, applied migrations
// from the operator's `inspect`) are recorded by the operator alongside this file, never inferred here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const fileSha = (relative) => existsSync(path.join(root, relative)) ? sha(readFileSync(path.join(root, relative))) : null;

export function buildReleaseRecord() {
  const sourceCommit = process.env.SOURCE_COMMIT?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  const migrationsDir = "dist/aws-clinical-core/production-migrations";
  let migrations = { built: false };
  if (existsSync(path.join(root, migrationsDir, "manifest.json"))) {
    const manifest = JSON.parse(readFileSync(path.join(root, migrationsDir, "manifest.json"), "utf8"));
    const entries = manifest.migrations.map((m) => ({ version: m.version, file: m.file, sha256: fileSha(`${migrationsDir}/${m.file}`) }));
    migrations = { built: true, count: entries.length, last: entries.at(-1)?.file ?? null,
      releaseHash: sha(entries.map((e) => `${e.version}:${e.sha256}`).join("\n")), manifestSha256: fileSha(`${migrationsDir}/manifest.json`) };
  }
  const candidates = {};
  const distRoot = path.join(root, "dist/aws-clinical-core");
  if (existsSync(distRoot)) {
    for (const name of readdirSync(distRoot).sort()) {
      const dir = path.join(distRoot, name);
      if (!statSync(dir).isDirectory() || name === "production-migrations") continue;
      const files = readdirSync(dir).filter((f) => /\.(js|json)$/.test(f)).sort();
      candidates[name] = Object.fromEntries(files.map((f) => [f, fileSha(`dist/aws-clinical-core/${name}/${f}`)]));
    }
  }
  const prompt = readFileSync(path.join(root, "src/server/clinical-core/recording-drafting-prompt.ts"), "utf8");
  const record = {
    schemaVersion: "release-record/1",
    generatedAt: new Date().toISOString(),
    sourceCommit, workingTreeDirty: dirty,
    productionMigrations: migrations,
    candidates: Object.keys(candidates).length ? candidates : { built: false },
    coreLaunchScopeSha256: fileSha("infra/aws-clinical-core/core-launch-scope.json"),
    catalogMigrationsSha256: existsSync(path.join(root, "infra/aws-clinical-core/catalog-migrations")) ? sha(readdirSync(path.join(root, "infra/aws-clinical-core/catalog-migrations")).sort().map((f) => `${f}:${fileSha(`infra/aws-clinical-core/catalog-migrations/${f}`)}`).join("\n")) : null,
    draftingPromptSourceSha256: sha(prompt),
    personalExportLifecycleSha256: fileSha("infra/aws-clinical-core/personal-export-bucket-lifecycle.json"),
    deployed: { note: "Filled in by the operator after deployment: stack name, parameters hash, each function's CodeSha256 and S3 object version, the operator inspect output (applied/missing versions), mobile build numbers. Never inferred from this machine." },
  };
  return record;
}
export function compareReleaseRecords(previous, current) {
  const differences = [];
  const walk = (a, b, prefix) => {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) {
      if (["generatedAt", "deployed", "workingTreeDirty"].includes(key) && !prefix) continue;
      const x = a?.[key], y = b?.[key], at = prefix ? `${prefix}.${key}` : key;
      if (x && y && typeof x === "object" && typeof y === "object") walk(x, y, at);
      else if (JSON.stringify(x) !== JSON.stringify(y)) differences.push({ at, previous: x ?? null, current: y ?? null });
    }
  };
  walk(previous, current, "");
  return differences;
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname.replace(/\\/g, "/") ) {
  const record = buildReleaseRecord();
  const verifyIndex = process.argv.indexOf("--verify");
  if (verifyIndex > 0) {
    const previous = JSON.parse(readFileSync(process.argv[verifyIndex + 1], "utf8"));
    const differences = compareReleaseRecords(previous, record);
    console.log(JSON.stringify({ ok: differences.length === 0, differences }, null, 2));
    if (differences.length) process.exitCode = 1;
  } else {
    mkdirSync(path.join(root, "dist/release"), { recursive: true });
    const out = path.join(root, "dist/release", `release-record-${record.sourceCommit.slice(0, 12)}.json`);
    writeFileSync(out, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ ok: true, record: out, sourceCommit: record.sourceCommit, workingTreeDirty: record.workingTreeDirty, productionMigrations: record.productionMigrations }));
  }
}
