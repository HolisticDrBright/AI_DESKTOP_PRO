import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseRecord, compareReleaseRecords } from "./build-release-record.mjs";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-release-record.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "alp release fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => {
    const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  put(".gitignore", "dist/\n");
  put("scripts/release record.mjs", readFileSync(script));
  put("src/server/clinical-core/recording-drafting-prompt.ts", "// fictional reviewed prompt\n");
  put("infra/aws-clinical-core/core-launch-scope.json", "{}\n");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git(["init"]); git(["add", "."]);
  git(["-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "fictional test source"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  const run = (args = [], env = {}) => spawnSync(process.execPath, [path.join(root, "scripts/release record.mjs"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, SOURCE_COMMIT: "", ...env },
  });
  return { root, put, run, head };
}

test("the release record names the source commit, every built artifact by hash, and what is not built", () => {
  const record = buildReleaseRecord();
  assert.equal(record.schemaVersion, "release-record/1");
  assert.match(record.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(record.coreLaunchScopeSha256, /^[a-f0-9]{64}$/);
  assert.match(record.draftingPromptSourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(record.productionMigrations.built === false || (record.productionMigrations.count >= 97 && /^[a-f0-9]{64}$/.test(record.productionMigrations.releaseHash)));
  assert.ok(record.deployed.note.includes("Never inferred"));
  assert.ok(!JSON.stringify(record).match(/AKIA|secret|token/i));
});
test("verification reports every hash that changed and ignores timestamps", () => {
  const record = buildReleaseRecord();
  assert.deepEqual(compareReleaseRecords(record, { ...record, generatedAt: "2000-01-01T00:00:00Z" }), []);
  const changed = compareReleaseRecords(record, { ...record, coreLaunchScopeSha256: "0".repeat(64), productionMigrations: { ...record.productionMigrations, built: !record.productionMigrations.built } });
  assert.deepEqual(changed.map((d) => d.at).sort(), ["coreLaunchScopeSha256", "productionMigrations.built"]);
  assert.deepEqual(compareReleaseRecords({ ...record, workingTreeDirty: false }, { ...record, workingTreeDirty: true })
    .map(d => d.at), ["workingTreeDirty"]);
});

test("actual CLI creates and verifies a record on paths with spaces; missing records fail", t => {
  const f = fixture(t);
  const built = f.run(); assert.equal(built.status, 0, built.stderr);
  assert.ok(built.stdout.trim(), "The actual command must not silently do nothing (Windows regression)");
  const receipt = JSON.parse(built.stdout);
  assert.equal(receipt.sourceCommit, f.head); assert.equal(receipt.workingTreeDirty, false);
  const verification = f.run(["--verify", receipt.record]);
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).ok, true);
  const missing = f.run(["--verify", "nonexistent.json"]);
  assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stderr).error, "release_record_unavailable");
});

test("an environment-supplied source label cannot replace observed HEAD", t => {
  const f = fixture(t);
  for (const value of ["0".repeat(40), "not-a-commit"]) {
    const result = f.run([], { SOURCE_COMMIT: value });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).error, "release_source_mismatch");
  }
  assert.equal(f.run([], { SOURCE_COMMIT: f.head }).status, 0);
});

test("refuses an overwrite and malformed, unknown or duplicate arguments", t => {
  const f = fixture(t);
  const first = f.run(); const recordPath = JSON.parse(first.stdout).record;
  const original = readFileSync(recordPath);
  const again = f.run(); assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stderr).error, "release_output_exists");
  assert.deepEqual(readFileSync(recordPath), original);
  for (const args of [["--verify"], ["--unknown", "x"], ["--output", "a", "--output", "b"],
    ["--verify", "a", "--output", "b"], ["--verify", "--output"]]) {
    const result = f.run(args); assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, "release_arguments_invalid");
  }
});

test("dirty source cannot verify even against an equally dirty snapshot", t => {
  const f = fixture(t);
  const clean = JSON.parse(f.run().stdout).record;
  f.put("src/server/clinical-core/recording-drafting-prompt.ts", "// changed fictional source\n");
  const failed = f.run(["--verify", clean]);
  assert.equal(failed.status, 1); assert.ok(JSON.parse(failed.stdout).refusals.includes("release_worktree_dirty"));
  const dirty = f.run(["--output", "dist/dirty.json"]); assert.equal(dirty.status, 0);
  const stillDirty = f.run(["--verify", JSON.parse(dirty.stdout).record]);
  assert.equal(stillDirty.status, 1);
  assert.ok(JSON.parse(stillDirty.stdout).refusals.includes("release_worktree_dirty"));
});

test("missing, duplicate or escaping migration entries cannot be hashed as a release", t => {
  const f = fixture(t);
  const migration = { version: "20260928010000", file: "20260928010000_fictional.sql" };
  const putManifest = migrations => f.put("dist/aws-clinical-core/production-migrations/manifest.json", JSON.stringify({ migrations }));
  putManifest([migration]);
  let result = f.run(); assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "release_migration_missing");
  f.put(`dist/aws-clinical-core/production-migrations/${migration.file}`, "select 1;\n");
  for (const entries of [[], [migration, migration], [{ ...migration, file: "../../outside.sql" }], [{ ...migration, version: 20260928010000 }]]) {
    putManifest(entries); result = f.run(); assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, "release_migrations_invalid");
  }
  putManifest([migration]); result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).productionMigrations.count, 1);
});
