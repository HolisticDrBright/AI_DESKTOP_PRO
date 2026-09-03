#!/usr/bin/env node
/**
 * Forensic E2E runner. Same shape as check-e2e-order-independence.mjs, but
 * built for reproducing an intermittent forward-order failure with enough
 * evidence to diagnose it:
 *
 *   - Runs the WHOLE battery in ONE Playwright invocation per run (not per
 *     spec). Anything else doesn't reproduce state-leak flakes — the leak
 *     lives across suites in the same process.
 *   - Passes `--trace retain-on-failure --screenshot only-on-failure
 *     --video retain-on-failure` so a failing test leaves a
 *     trace/screenshot/video the reviewer can open.
 *   - Wraps the run with periodic PowerShell process snapshots into a
 *     side log — chrome & node counts, memory. If numbers climb across
 *     the run, that's a leak signal even without a failure.
 *   - Runs the battery N times so a repeatable pattern shows itself.
 *
 * Output lands under `.forensic/e2e/<start>/run-<i>/` per run.
 *
 * DEBUG tool. Does not replace check-e2e-order-independence.mjs.
 */

import { execFileSync, spawn } from "node:child_process";
import { openSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PLAYWRIGHT_ENTRY = join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");

const specs = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts")).sort();
if (!specs.length) { console.error("[forensic] no specs"); process.exit(1); }

const STUB_BASE = process.env.E2E_STUB_BASE ?? "http://127.0.0.1:3999";
const APP_PORT = Number(process.env.E2E_PORT ?? 3115);
const RUNS = Number(process.env.FORENSIC_RUNS ?? 3);
const DIR = join(".forensic", "e2e", new Date().toISOString().replace(/[:.]/g, "-"));
const ORDER = (process.env.FORENSIC_ORDER ?? "forward").toLowerCase();
mkdirSync(DIR, { recursive: true });

function provisionEnv() {
  const defaults = {
    APP_EDITION: "clinical", E2E_LIVE: "1", NEXT_PUBLIC_USE_LIVE_API: "true",
    TRPC_BASE_URL: `${STUB_BASE}/api/trpc`,
    CLINICAL_SUPABASE_URL: STUB_BASE, CLINICAL_SUPABASE_ANON_KEY: "stub",
    CLINICAL_DEMO_EMAIL: "demo@local", CLINICAL_DEMO_PASSWORD: "demo",
    CLINICAL_ORG_ID: "org-fixture", E2E_PORT: String(APP_PORT),
  };
  for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
}

async function assertAppPortFree() {
  const reachable = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
    .then(() => true).catch(() => false);
  if (reachable) {
    console.error(`[forensic] port ${APP_PORT} in use — stop it or set E2E_PORT`);
    process.exit(2);
  }
}

async function withStub(run) {
  const strays = await fetch(`${STUB_BASE}/__control/reset-all`, { method: "POST" })
    .then((r) => r.ok).catch(() => false);
  if (strays) { console.error("[forensic] existing stub on 3999 — kill it first"); process.exit(1); }

  const log = openSync(join(DIR, "stub.log"), "w");
  const stub = spawn("node", ["scripts/live-stub-server.mjs"], {
    stdio: ["ignore", log, log], detached: false,
  });
  const killStub = () => { try { stub.kill("SIGKILL"); } catch { /* already gone */ } };
  // A Ctrl+C to the diagnostic runner must not leave an orphan stub on 3999.
  const onSignal = (sig) => { killStub(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(250);
    ready = await fetch(`${STUB_BASE}/__control/reset-all`, { method: "POST" })
      .then((r) => r.ok).catch(() => false);
  }
  if (!ready) { killStub(); process.exit(1); }
  try { return await run(); }
  finally { killStub(); }
}

function procSnapshot() {
  try {
    const raw = execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
        "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in 'node','chrome' } | " +
        "Group-Object ProcessName | ForEach-Object { \"$($_.Name)=$($_.Count)\" } | Out-String"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const parts = raw.split(/\r?\n/).filter(Boolean);
    const out = {};
    for (const p of parts) { const [k, v] = p.split("="); out[k] = Number(v) || 0; }
    return { ...out, mem_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) };
  } catch { return { err: "powershell fail", mem_mb: Math.round(process.memoryUsage().rss / 1024 / 1024) }; }
}

function runOneBattery(runIdx, orderedSpecs) {
  const runDir = join(DIR, `run-${runIdx}`);
  mkdirSync(runDir, { recursive: true });
  const listArgs = orderedSpecs.map((f) => `e2e/${f}`);
  let out = "";
  let exitOk = true;
  try {
    out = execFileSync(
      process.execPath,
      [
        PLAYWRIGHT_ENTRY, "test", ...listArgs,
        "--reporter=list",
        "--trace", "on",
        `--output=${runDir}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (e) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; exitOk = false; }
  writeFileSync(join(runDir, "list.txt"), out);
  const passed = /(\d+) passed/.exec(out); const failed = /(\d+) failed/.exec(out); const skipped = /(\d+) skipped/.exec(out);
  const failList = out.split("\n").filter((l) => /(✘|^\s*\d+\)\s)/.test(l)).slice(0, 20);
  return {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0,
    exitOk, dir: runDir, failList,
  };
}

provisionEnv();
await assertAppPortFree();

const summary = { runs: [] };
await withStub(async () => {
  for (let r = 1; r <= RUNS; r += 1) {
    console.log(`\n[forensic] === RUN ${r}/${RUNS} — ${ORDER} order (${specs.length} specs, ONE playwright invocation) ===`);
    const ordered = ORDER === "reverse" ? [...specs].reverse() : specs;
    const preSnap = procSnapshot();
    console.log(`  before: chrome=${preSnap.chrome ?? 0} node=${preSnap.node ?? 0} mem=${preSnap.mem_mb}MB`);
    const t0 = Date.now();
    const result = runOneBattery(r, ordered);
    const dt = Math.round((Date.now() - t0) / 1000);
    const postSnap = procSnapshot();
    console.log(`  after:  chrome=${postSnap.chrome ?? 0} node=${postSnap.node ?? 0} mem=${postSnap.mem_mb}MB`);
    console.log(`  battery: passed=${result.passed} failed=${result.failed} skipped=${result.skipped}  duration=${dt}s`);
    for (const line of result.failList) console.log(`    ${line}`);
    summary.runs.push({ run: r, order: ORDER, passed: result.passed, failed: result.failed,
      skipped: result.skipped, duration_s: dt, before: preSnap, after: postSnap, failList: result.failList });
    writeFileSync(join(DIR, "summary.json"), JSON.stringify(summary, null, 2));
  }
});

const totalFailed = summary.runs.reduce((n, r) => n + r.failed, 0);
console.log(`\n[forensic] runs complete — ${totalFailed} total failures across ${RUNS} ${ORDER}-order batteries`);
console.log(`[forensic] artifacts under ${DIR}`);
