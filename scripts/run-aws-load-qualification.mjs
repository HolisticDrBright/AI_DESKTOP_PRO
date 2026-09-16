import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

/** Refusal-path load qualification runner.
 *
 * Dry run (default) validates the plan and prints the schedule without any
 * network call. `--execute` sends the plan's unauthenticated requests to an
 * origin that must match the synthetic pattern (or 127.0.0.1 with
 * `--allow-local` for the self-test) and requires
 * LOAD_QUALIFICATION_CONFIRM_SYNTHETIC=1. Any 2xx response, any status outside
 * the scenario's expected refusals, or an SLO breach fails the run. */
export function validatePlan(plan) {
  const errors = [];
  if (plan?.schemaVersion !== "load-qualification-plan/1") errors.push("schemaVersion must be load-qualification-plan/1");
  if (plan?.target !== "synthetic-staging") errors.push("target must be synthetic-staging");
  if (typeof plan?.originPattern !== "string") errors.push("originPattern is required");
  if (!Array.isArray(plan?.scenarios) || plan.scenarios.length === 0) errors.push("scenarios must be a non-empty array");
  const ids = new Set();
  for (const s of plan?.scenarios ?? []) {
    if (!s || typeof s.id !== "string" || ids.has(s.id)) errors.push("every scenario needs a unique id"); ids.add(s?.id);
    if (!["GET", "POST"].includes(s?.method)) errors.push(`${s?.id}: method must be GET or POST`);
    if (typeof s?.path !== "string" || !s.path.startsWith("/")) errors.push(`${s?.id}: path must start with /`);
    if (!Number.isInteger(s?.concurrency) || s.concurrency < 1 || s.concurrency > 50) errors.push(`${s?.id}: concurrency must be 1..50`);
    if (!Number.isInteger(s?.requests) || s.requests < 1 || s.requests > 5000) errors.push(`${s?.id}: requests must be 1..5000`);
    if (!Array.isArray(s?.expectedStatuses) || s.expectedStatuses.some(v => !Number.isInteger(v) || v < 400 || v > 599)) errors.push(`${s?.id}: expectedStatuses must all be refusals (400-599)`);
    if (!Number.isFinite(s?.slo?.p95Ms) || s.slo.p95Ms < 1 || !Number.isFinite(s?.slo?.maxErrorRate) || s.slo.maxErrorRate < 0 || s.slo.maxErrorRate > 0.05) errors.push(`${s?.id}: slo needs p95Ms and maxErrorRate <= 0.05`);
    if (s?.bodyBytes !== undefined && (!Number.isInteger(s.bodyBytes) || s.bodyBytes > 1_000_000)) errors.push(`${s?.id}: bodyBytes must be <= 1000000`);
  }
  return errors;
}
const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

export async function executePlan(plan, origin, options = {}) {
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
  const report = { contractVersion: "load-qualification-report/1", target: plan.target, origin, ranAt: new Date().toISOString(), passed: results.every(r => r.passed), scenarios: results };
  return { ...report, evidenceSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1");
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
    if (!local && (!new RegExp(plan.originPattern).test(origin) || plan.forbiddenOriginMarkers.some(m => origin.includes(m)))) { console.error("Refusing: origin is not the synthetic staging pattern."); process.exit(1); }
    const report = await executePlan(plan, origin);
    const output = resolve(value("--output") ?? "dist/qualification/load-qualification.json");
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, evidenceSha256: report.evidenceSha256, scenarios: report.scenarios.map(s => ({ id: s.id, p95Ms: s.p95Ms, errorRate: s.errorRate, passed: s.passed })) }));
    if (!report.passed) process.exitCode = 2;
  }
}
