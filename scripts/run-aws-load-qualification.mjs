import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

/** Refusal-path load qualification runner.
 *
 * Dry run (default) validates the plan and prints the schedule without any
 * network call. `--execute` sends the plan's unauthenticated requests to an
 * origin observed against a reviewed qualification target (or 127.0.0.1 with
 * `--allow-local` for the self-test) and requires
 * LOAD_QUALIFICATION_CONFIRM_SYNTHETIC=1. Any 2xx response, any status outside
 * the scenario's expected refusals, or an SLO breach fails the run. */
export function validatePlan(plan) {
  const errors = [];
  if (plan?.schemaVersion !== "load-qualification-plan/1") errors.push("schemaVersion must be load-qualification-plan/1");
  if (plan?.target !== "synthetic-staging") errors.push("target must be synthetic-staging");
  if (typeof plan?.originPattern !== "string") errors.push("originPattern is required");
  if (!Array.isArray(plan?.scenarios) || plan.scenarios.length === 0 || plan.scenarios.length > 20) errors.push("scenarios must be a non-empty array with at most 20 entries");
  const ids = new Set();
  for (const s of Array.isArray(plan?.scenarios) ? plan.scenarios : []) {
    if (!s || typeof s.id !== "string" || ids.has(s.id)) errors.push("every scenario needs a unique id"); ids.add(s?.id);
    if (!["GET", "POST"].includes(s?.method)) errors.push(`${s?.id}: method must be GET or POST`);
    if (typeof s?.path !== "string" || !/^\/(?!\/)[^\\\s#]*$/.test(s.path) || /%(?:0[ad]|2f|5c)/i.test(s.path)) errors.push(`${s?.id}: path must be a same-origin absolute path`);
    if (!Number.isInteger(s?.concurrency) || s.concurrency < 1 || s.concurrency > 50) errors.push(`${s?.id}: concurrency must be 1..50`);
    if (!Number.isInteger(s?.requests) || s.requests < 1 || s.requests > 5000) errors.push(`${s?.id}: requests must be 1..5000`);
    if (!Array.isArray(s?.expectedStatuses) || !s.expectedStatuses.length || s.expectedStatuses.some(v => !Number.isInteger(v) || v < 400 || v > 599)) errors.push(`${s?.id}: expectedStatuses must all be refusals (400-599)`);
    if (!Number.isFinite(s?.slo?.p95Ms) || s.slo.p95Ms < 1 || !Number.isFinite(s?.slo?.maxErrorRate) || s.slo.maxErrorRate < 0 || s.slo.maxErrorRate > 0.05) errors.push(`${s?.id}: slo needs p95Ms and maxErrorRate <= 0.05`);
    if (s?.bodyBytes !== undefined && (!Number.isInteger(s.bodyBytes) || s.bodyBytes < 0 || s.bodyBytes > 1_000_000)) errors.push(`${s?.id}: bodyBytes must be 0..1000000`);
  }
  return errors;
}
const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

export async function executePlan(plan, origin, options = {}) {
  if (validatePlan(plan).length) throw new Error("load_plan_invalid");
  const fetchImpl = options.fetch ?? fetch;
  const results = [];
  for (const scenario of plan.scenarios) {
    const latencies = []; let unexpected = 0; let failures = 0; let successes = 0; const statuses = {};
    const body = scenario.method === "POST" ? JSON.stringify({ filler: "x".repeat(scenario.bodyBytes ?? 1024) }) : undefined;
    let next = 0;
    const worker = async () => {
      while (next < scenario.requests) {
        next += 1; const started = performance.now();
        try {
          const response = await fetchImpl(`${origin}${scenario.path}`, { method: scenario.method, redirect: "manual", signal: AbortSignal.timeout(15_000),
            headers: body ? { "content-type": "application/json" } : {}, body });
          // We need status and timing only. Release connections without reading
          // or retaining provider response content during a refusal-path test.
          await response.body?.cancel();
          latencies.push(performance.now() - started);
          statuses[response.status] = (statuses[response.status] ?? 0) + 1;
          if (response.status >= 200 && response.status < 300) successes += 1;
          else if (!scenario.expectedStatuses.includes(response.status)) unexpected += 1;
        } catch { failures += 1; latencies.push(performance.now() - started); }
      }
    };
    await Promise.all(Array.from({ length: scenario.concurrency }, worker));
    const errorRate = (unexpected + failures + successes) / scenario.requests;
    const p95Ms = percentile(latencies, 0.95);
    const passed = successes === 0 && errorRate <= scenario.slo.maxErrorRate && p95Ms !== null && p95Ms <= scenario.slo.p95Ms;
    results.push({ id: scenario.id, requests: scenario.requests, concurrency: scenario.concurrency, statuses, successes, unexpected, failures, errorRate,
      p50Ms: Math.round(percentile(latencies, 0.5)), p95Ms: Math.round(p95Ms), maxMs: Math.round(Math.max(...latencies)), slo: scenario.slo, passed });
  }
  const report = { contractVersion: "load-qualification-report/1", target: plan.target, origin,
    targetEvidence: options.targetEvidence ?? { kind: "unverified_transport_test", activationEvidence: false },
    ranAt: new Date().toISOString(), passed: results.every(r => r.passed), scenarios: results };
  return { ...report, evidenceSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") };
}

// Reuse the actual TypeScript target validator and live observer, not an environment
// assertion or copied subset of their checks. No load request occurs in this step.
export function inspectHostedLoadTarget(targetPath, origin) {
  if (!targetPath) throw new Error("load_target_manifest_required");
  const directory = mkdtempSync(resolve(tmpdir(), "alp-load-target-"));
  const bundle = resolve(directory, "inspect.cjs");
  const require = createRequire(import.meta.url);
  try {
    buildSync({ entryPoints: [fileURLToPath(new URL("../src/server/clinical-core/load-qualification-target.ts", import.meta.url))],
      bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
    return require(bundle).inspectLoadQualificationTarget(targetPath, origin);
  } finally {
    delete require.cache[bundle];
    rmSync(directory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = name => args.includes(name);
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const plan = JSON.parse(readFileSync(resolve(value("--plan") ?? "infra/aws-clinical-core/load-qualification-plan.json"), "utf8"));
  const errors = validatePlan(plan);
  if (errors.length) { for (const e of errors) console.error(`Load qualification plan invalid: ${e}`); process.exit(1); }
  if (!flag("--execute")) {
    console.log(JSON.stringify({ mode: "dry-run", target: plan.target, scenarios: plan.scenarios.map(s => ({ id: s.id, requests: s.requests, concurrency: s.concurrency, slo: s.slo })) }, null, 2));
    console.log("Load qualification plan validated; no request was sent.");
  } else {
    const origin = value("--origin") ?? "";
    const local = flag("--allow-local") && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
    if (process.env.LOAD_QUALIFICATION_CONFIRM_SYNTHETIC !== "1") { console.error("Refusing: set LOAD_QUALIFICATION_CONFIRM_SYNTHETIC=1 to confirm a synthetic target."); process.exit(1); }
    if (!local && !/^https:\/\/[a-z0-9]{10}\.execute-api\.us-east-2\.amazonaws\.com$/.test(origin)) { console.error("Refusing: origin is not the synthetic staging pattern."); process.exit(1); }
    let targetEvidence;
    try {
      targetEvidence = local ? { kind: "local_transport_test", activationEvidence: false }
        : inspectHostedLoadTarget(value("--target"), origin);
    } catch (error) {
      const code = /^(?:load|target)_[a-z_]+$/.test(error?.message ?? "") ? error.message : "load_target_inspection_failed";
      console.error(`Refusing: ${code}. No load request was sent.`); process.exit(1);
    }
    const report = await executePlan(plan, origin, { targetEvidence });
    const output = resolve(value("--output") ?? "dist/qualification/load-qualification.json");
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, evidenceSha256: report.evidenceSha256, scenarios: report.scenarios.map(s => ({ id: s.id, p95Ms: s.p95Ms, errorRate: s.errorRate, passed: s.passed })) }));
    if (!report.passed) process.exitCode = 2;
  }
}
