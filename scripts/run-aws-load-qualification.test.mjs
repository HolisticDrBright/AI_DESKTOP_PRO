import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { executePlan, validatePlan } from "./run-aws-load-qualification.mjs";

const script = new URL("./run-aws-load-qualification.mjs", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const plan = JSON.parse(readFileSync("infra/aws-clinical-core/load-qualification-plan.json", "utf8"));
assert.deepEqual(validatePlan(plan), []);
assert.ok(validatePlan({ ...plan, scenarios: [{ ...plan.scenarios[0], expectedStatuses: [200] }] }).some(e => e.includes("refusals")));
assert.ok(validatePlan({ ...plan, target: "production-clinical" }).some(e => e.includes("synthetic-staging")));

const dry = spawnSync(process.execPath, [script], { encoding: "utf8" });
assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /no request was sent/);
const unconfirmed = spawnSync(process.execPath, [script, "--execute", "--origin", "https://abcdefghij.execute-api.us-east-2.amazonaws.com"], { encoding: "utf8" });
assert.equal(unconfirmed.status, 1); assert.match(unconfirmed.stderr, /confirm a synthetic target/);
const forbidden = spawnSync(process.execPath, [script, "--execute", "--origin", "https://api.ailongevitypro.app"], { encoding: "utf8", env: { ...process.env, LOAD_QUALIFICATION_CONFIRM_SYNTHETIC: "1" } });
assert.equal(forbidden.status, 1); assert.match(forbidden.stderr, /not the synthetic staging pattern/);

const small = { ...plan, scenarios: plan.scenarios.map(s => ({ ...s, requests: 12, concurrency: 4 })) };
let status = 401;
const server = createServer((_request, response) => { setTimeout(() => { response.statusCode = status; response.end("{}"); }, 5); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const refusing = await executePlan(small, origin);
  assert.equal(refusing.passed, true, JSON.stringify(refusing.scenarios));
  assert.ok(refusing.scenarios.every(s => s.p95Ms >= 5 && s.successes === 0));
  assert.match(refusing.evidenceSha256, /^[a-f0-9]{64}$/);
  status = 200;
  const accepting = await executePlan(small, origin);
  assert.equal(accepting.passed, false);
  assert.ok(accepting.scenarios.every(s => s.successes === 12));
  status = 500;
  const unexpected = await executePlan(small, origin);
  assert.equal(unexpected.passed, false);
  assert.ok(unexpected.scenarios.every(s => s.unexpected === 12));
} finally { server.close(); }
console.log("run-aws-load-qualification tests passed");
