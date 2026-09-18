import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./check-aws-provider-configuration.mjs", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
function fixture(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "provider-configuration-"));
  mkdirSync(join(directory, "infra/aws-clinical-core"), { recursive: true });
  mkdirSync(join(directory, "src/server/clinical-core"), { recursive: true });
  for (const file of ["telehealth-requests-extension.json", "fullscript-connector-extension.json", "consumer-account-extension.json", "external-provider-readiness.json"])
    cpSync(join("infra/aws-clinical-core", file), join(directory, "infra/aws-clinical-core", file));
  for (const file of ["aws-telehealth-requests-lambda.ts", "aws-telehealth-requests.ts"]) cpSync(join("src/server/clinical-core", file), join(directory, "src/server/clinical-core", file));
  mutate(directory);
  return spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
}
const edit = (directory, file, change) => {
  const path = join(directory, file); const value = JSON.parse(readFileSync(path, "utf8")); change(value); writeFileSync(path, JSON.stringify(value));
};
const clean = fixture();
assert.equal(clean.status, 0, clean.stderr);
assert.match(clean.stdout, /check passed/);

const zoom = fixture((d) => edit(d, "infra/aws-clinical-core/telehealth-requests-extension.json", (t) => { t.Parameters.ZoomEnabled.Default = "true"; }));
assert.equal(zoom.status, 1); assert.match(zoom.stderr, /ZoomEnabled must default to false/);

const drift = fixture((d) => edit(d, "infra/aws-clinical-core/telehealth-requests-extension.json", (t) => { delete t.Resources.TelehealthFunction.Properties.Environment.Variables.ZOOM_BAA_VERIFIED; }));
assert.equal(drift.status, 1); assert.match(drift.stderr, /must set ZOOM_BAA_VERIFIED/);

const enabled = fixture((d) => edit(d, "infra/aws-clinical-core/external-provider-readiness.json", (t) => { t.providers.transactional_email.enabled = true; }));
assert.equal(enabled.status, 1); assert.match(enabled.stderr, /transactional_email must be recorded as disabled/);

const secret = fixture((d) => edit(d, "infra/aws-clinical-core/fullscript-connector-extension.json", (t) => { t.Parameters.FullscriptClientSecret.Default = "sk_test_ABCDEFGHIJKLMNOP"; }));
assert.equal(secret.status, 1); assert.match(secret.stderr, /must not contain credential material/);
console.log("check-aws-provider-configuration tests passed");
