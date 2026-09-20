import test from "node:test";
import assert from "node:assert/strict";
import { buildReleaseRecord, compareReleaseRecords } from "./build-release-record.mjs";

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
});
