import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {fileURLToPath} from 'node:url';
import { executePlan, validatePlan } from "./run-aws-load-qualification.mjs";

const script = fileURLToPath(new URL("./run-aws-load-qualification.mjs", import.meta.url));
const plan = JSON.parse(readFileSync("infra/aws-clinical-core/load-qualification-plan.json", "utf8"));
assert.deepEqual(validatePlan(plan), []);
assert.ok(validatePlan({ ...plan, scenarios: [{ ...plan.scenarios[0], expectedStatuses: [200] }] }).some(e => e.includes("refusals")));
assert.ok(validatePlan({ ...plan, target: "production-clinical" }).some(e => e.includes("synthetic-staging")));
assert.ok(validatePlan({...plan,scenarios:[{...plan.scenarios[0],bodyBytes:-1}]}).some(e=>e.includes('bodyBytes')));

const dry = spawnSync(process.execPath, [script], { encoding: "utf8" });
assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /no request was sent/);
const unconfirmed = spawnSync(process.execPath, [script, "--execute", "--origin", "https://abcdefghij.execute-api.us-east-2.amazonaws.com"], { encoding: "utf8" });
assert.equal(unconfirmed.status, 1); assert.match(unconfirmed.stderr, /confirm a synthetic target/);
const forbidden = spawnSync(process.execPath, [script, "--execute", "--origin", "https://api.ailongevitypro.app"], { encoding: "utf8", env: { ...process.env, LOAD_QUALIFICATION_CONFIRM_SYNTHETIC: "1" } });
assert.equal(forbidden.status, 1); assert.match(forbidden.stderr, /not the synthetic staging pattern/);
const missingTarget = spawnSync(process.execPath, [script, "--execute", "--origin", "https://abcdefghij.execute-api.us-east-2.amazonaws.com"],
  { encoding: "utf8", env: { ...process.env, LOAD_QUALIFICATION_CONFIRM_SYNTHETIC: "1" } });
assert.equal(missingTarget.status, 1); assert.match(missingTarget.stderr, /load_target_manifest_required/);
const exampleTarget = spawnSync(process.execPath, [script, "--execute", "--origin", "https://6zt8e9qz04.execute-api.us-east-2.amazonaws.com", "--target", "infra/aws-clinical-core/qualification-target.example.json"],
  { encoding: "utf8", env: { ...process.env, LOAD_QUALIFICATION_CONFIRM_SYNTHETIC: "1" } });
assert.equal(exampleTarget.status, 1); assert.match(exampleTarget.stderr, /target_placeholder/);
for (const scenarios of [[], {}, null]) assert.ok(validatePlan({ ...plan, scenarios }).length);
for (const invalidPath of ["//external.invalid", "/\\external", "/encoded%2fhost", "/path#fragment", "/path with spaces"])
  assert.ok(validatePlan({ ...plan, scenarios: [{ ...plan.scenarios[0], path: invalidPath }] }).length);
await assert.rejects(executePlan({ ...plan, scenarios: [] }, "http://127.0.0.1:1"), /load_plan_invalid/);

// An unexpected 2xx is a safety failure even when disposing of its body fails.
// One error in twenty fits the permitted transport budget but must never hide it.
const tolerant = { ...plan, scenarios: [{ ...plan.scenarios[0], requests: 20, concurrency: 1,
  slo: { p95Ms: 1000, maxErrorRate: 0.05 } }] };
let disposalCalls = 0;
const disposalFailure = await executePlan(tolerant, "http://127.0.0.1:1", { fetch: async () => {
  const first = disposalCalls++ === 0;
  return { status: first ? 200 : 401, body: { cancel: async () => { if (first) throw new Error("cancel_failed"); } } };
} });
assert.equal(disposalFailure.passed, false, "body cancellation must not hide an observed successful response");
assert.equal(disposalFailure.scenarios[0].successes, 1);
assert.equal(disposalFailure.scenarios[0].statuses[200], 1);
assert.equal(disposalFailure.scenarios[0].failures, 1);
assert.equal(disposalFailure.scenarios[0].errorRate, 0.05, "each failed request is counted only once");
const allDisposalFailures = await executePlan(tolerant, "http://127.0.0.1:1", { fetch: async () =>
  ({ status: 200, body: { cancel: async () => { throw new Error("cancel_failed"); } } }) });
assert.equal(allDisposalFailures.passed, false);
assert.equal(allDisposalFailures.scenarios[0].successes, 20);
assert.equal(allDisposalFailures.scenarios[0].failures, 20);
assert.equal(allDisposalFailures.scenarios[0].errorRate, 1, "overlapping failure observations are not extra requests");
let refusalDisposalCalls = 0;
const refusalDisposalFailure = await executePlan(tolerant, "http://127.0.0.1:1", { fetch: async () => {
  const first = refusalDisposalCalls++ === 0;
  return { status: 401, body: { cancel: async () => { if (first) throw new Error("cancel_failed"); } } };
} });
assert.equal(refusalDisposalFailure.passed, true, "the explicitly declared transport error allowance is preserved");
assert.equal(refusalDisposalFailure.scenarios[0].statuses[401], 20);
assert.equal(refusalDisposalFailure.scenarios[0].failures, 1);
assert.equal(refusalDisposalFailure.scenarios[0].errorRate, 0.05);

const small = { ...plan, scenarios: plan.scenarios.map(s => ({ ...s, requests: 12, concurrency: 4 })) };
let status = 401;
const server = createServer((_request, response) => { setTimeout(() => { response.statusCode = status; response.end("{}"); }, 5); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const refusing = await executePlan(small, origin);
  assert.equal(refusing.passed, true, JSON.stringify(refusing.scenarios));
  assert.equal(refusing.targetEvidence.kind, "unverified_transport_test");
  assert.equal(refusing.targetEvidence.activationEvidence, false);
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
