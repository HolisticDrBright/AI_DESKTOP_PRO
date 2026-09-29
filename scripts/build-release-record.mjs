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
import { fileURLToPath } from "node:url";

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function buildReleaseRecord({ root = process.cwd() } = {}) {
  const fileSha = (relative) => existsSync(path.join(root, relative)) ? sha(readFileSync(path.join(root, relative))) : null;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  // An environment label is an assertion to check, never observed provenance.
  if (process.env.SOURCE_COMMIT?.trim() && process.env.SOURCE_COMMIT.trim() !== sourceCommit)
    throw new Error("release_source_mismatch");
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  const migrationsDir = "dist/aws-clinical-core/production-migrations";
  let migrations = { built: false };
  if (existsSync(path.join(root, migrationsDir, "manifest.json"))) {
    const manifest = JSON.parse(readFileSync(path.join(root, migrationsDir, "manifest.json"), "utf8"));
    if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) throw new Error("release_migrations_invalid");
    const versions = new Set();
    const entries = manifest.migrations.map((m) => {
      if (!m || typeof m.version !== "string" || !/^\d{14}$/.test(m.version) || typeof m.file !== "string"
        || !new RegExp(`^${m.version}_[a-z0-9_]+\\.sql$`).test(m.file) || versions.has(m.version))
        throw new Error("release_migrations_invalid");
      versions.add(m.version);
      const digest = fileSha(`${migrationsDir}/${m.file}`);
      if (digest === null) throw new Error("release_migration_missing");
      return { version: m.version, file: m.file, sha256: digest };
    });
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
      if (["generatedAt", "deployed"].includes(key) && !prefix) continue;
      const x = a?.[key], y = b?.[key], at = prefix ? `${prefix}.${key}` : key;
      if (x && y && typeof x === "object" && typeof y === "object") walk(x, y, at);
      else if (JSON.stringify(x) !== JSON.stringify(y)) differences.push({ at, previous: x ?? null, current: y ?? null });
    }
  };
  walk(previous, current, "");
  return differences;
}
export function runReleaseRecord(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--verify", "--output"].includes(key) || key in options || !value || value.startsWith("--"))
      throw new Error("release_arguments_invalid");
    options[key] = value;
  }
  if (options["--verify"] && options["--output"]) throw new Error("release_arguments_invalid");
  const record = buildReleaseRecord();
  if (options["--verify"]) {
    const previous = JSON.parse(readFileSync(options["--verify"], "utf8"));
    const differences = compareReleaseRecords(previous, record);
    const refusals = [];
    if (previous?.schemaVersion !== "release-record/1") refusals.push("release_record_invalid");
    if (previous?.workingTreeDirty !== false || record.workingTreeDirty) refusals.push("release_worktree_dirty");
    const ok = differences.length === 0 && refusals.length === 0;
    console.log(JSON.stringify({ ok, differences, refusals }, null, 2));
    return ok ? 0 : 1;
  } else {
    const out = path.resolve(options["--output"] ?? `dist/release/release-record-${record.sourceCommit.slice(0, 12)}.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(record, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ ok: true, record: out, sourceCommit: record.sourceCommit, workingTreeDirty: record.workingTreeDirty, productionMigrations: record.productionMigrations }));
    return 0;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runReleaseRecord(); }
  catch (error) {
    const code = /^release_[a-z_]+$/.test(error?.message ?? "") ? error.message
      : error?.code === "EEXIST" ? "release_output_exists" : "release_record_unavailable";
    console.error(JSON.stringify({ ok: false, error: code }));
    process.exitCode = 1;
  }
}
