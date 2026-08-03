#!/usr/bin/env node
/**
 * Order-independence proof for the E2E battery.
 *
 * Runs the canonical one-process battery TWICE — once in Playwright's default
 * order, once with the spec list reversed — and requires both to report the
 * same passing total with zero failures.
 *
 * Why reversed rather than random: a shuffled run that passes once proves
 * nothing repeatable, and a failure would be hard to reproduce. Reversal is
 * deterministic, is the maximally different ordering, and puts every suite
 * both before and after every other suite across the two runs. If any pair of
 * suites leaks state in either direction, one of the two runs sees it.
 *
 * This exists because "run each spec separately" is not a fix. A battery that
 * only passes in one sequence has stopped testing sequence, and the leak it is
 * hiding will surface later as a product bug that is not one.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Where to find the `next` and `playwright` JS entry points.
 *
 * Reasoning we did not use the `node_modules/.bin` shims: on Windows those
 * are `.cmd` files that need `cmd.exe` to interpret them, and adding
 * `shell: true` around a spawn call triggers Node 24's DEP0190 arg-escape
 * deprecation. Locating the raw JS entry and handing it to `process.execPath`
 * is cross-platform, avoids the shell entirely, and pins the tool to the
 * same Node that ran this driver.
 */
const NEXT_ENTRY = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const PLAYWRIGHT_ENTRY = join(
  process.cwd(), "node_modules", "@playwright", "test", "cli.js",
);

const specs = readdirSync("e2e")
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

if (specs.length === 0) {
  console.error("[e2e-order] FAIL — no spec files found");
  process.exit(1);
}

const STUB_BASE = process.env.E2E_STUB_BASE ?? "http://127.0.0.1:3999";
const APP_PORT = Number(process.env.E2E_PORT ?? 3114);

/**
 * ONE precise configuration error, and then stop.
 *
 * The failure mode this replaces: the battery reported `0 passed, 216 skipped`
 * and exited non-zero, which reads as "the tests are broken" when the truth was
 * "you did not set E2E_LIVE". A proof whose setup is a recipe held somewhere
 * else is a proof that silently stops running.
 */
function configFailure(what, fix) {
  console.error(`\n[e2e-order] CONFIGURATION ERROR — ${what}\n\n  ${fix}\n`);
  process.exit(2);
}

/* ------------------------------------------------------------ provisioning */

/**
 * Everything the battery needs, set here rather than expected from the shell.
 *
 * An explicitly-set variable always wins: an operator pointing the suite at a
 * real backend must not have it silently redirected to the fixture.
 */
function provisionEnv() {
  const defaults = {
    APP_EDITION: "clinical",
    E2E_LIVE: "1",
    NEXT_PUBLIC_USE_LIVE_API: "true",
    TRPC_BASE_URL: `${STUB_BASE}/api/trpc`,
    CLINICAL_SUPABASE_URL: STUB_BASE,
    CLINICAL_SUPABASE_ANON_KEY: "stub",
    CLINICAL_DEMO_EMAIL: "demo@local",
    CLINICAL_DEMO_PASSWORD: "demo",
    CLINICAL_ORG_ID: "org-fixture",
    E2E_PORT: String(APP_PORT),
  };
  const applied = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      applied.push(key);
    }
  }
  if (process.env.APP_EDITION !== "clinical") {
    configFailure(
      `APP_EDITION is "${process.env.APP_EDITION}", but this battery only runs against the clinical edition.`,
      "Unset APP_EDITION and re-run, or set APP_EDITION=clinical.",
    );
  }
  return applied;
}

/**
 * Find a Chromium that already exists. Never download one.
 *
 * A proof that reaches the network to install a browser fails differently on a
 * machine with no network, which is exactly the machine where a clear message
 * matters most.
 */
function provisionBrowser() {
  if (process.env.PW_CHROMIUM_PATH) {
    if (!existsSync(process.env.PW_CHROMIUM_PATH)) {
      configFailure(
        `PW_CHROMIUM_PATH points at ${process.env.PW_CHROMIUM_PATH}, which does not exist.`,
        "Unset it to use the default Playwright browser, or point it at a real Chromium binary.",
      );
    }
    return process.env.PW_CHROMIUM_PATH;
  }
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH
      ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium")
      : null,
    "/opt/pw-browsers/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.env.PW_CHROMIUM_PATH = candidate;
      return candidate;
    }
  }
  // Fall through to Playwright's own resolution; it fails with its own clear
  // "install" message if no browser is present.
  return null;
}

/**
 * A build signature over the sources the running server is made of.
 *
 * Path + size + mtime rather than content: this runs on every invocation, and
 * hashing the whole tree would cost more than it saves. It catches every edit
 * that matters and errs towards rebuilding.
 */
function sourceSignature() {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = statSync(full);
        hash.update(`${full}:${st.size}:${Math.floor(st.mtimeMs)}`);
      }
    }
  };
  walk("src");
  for (const file of ["next.config.ts", "package.json", "postcss.config.mjs"]) {
    if (existsSync(file)) {
      const st = statSync(file);
      hash.update(`${file}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  }
  hash.update(`edition=${process.env.APP_EDITION}`);
  hash.update(`live=${process.env.NEXT_PUBLIC_USE_LIVE_API}`);
  return hash.digest("hex");
}

const STAMP = ".next/.e2e-provision.json";

/**
 * Build if there is no build, or if the build does not match these sources.
 *
 * `E2E_REUSE_BUILD=1` skips the check for an operator who knows their build is
 * current and does not want to wait. Nothing else skips it: a battery that
 * silently tests a stale bundle is worse than one that takes two minutes.
 */
function provisionBuild() {
  const signature = sourceSignature();
  const built = existsSync(".next/BUILD_ID");
  let stamped = null;
  try {
    stamped = JSON.parse(readFileSync(STAMP, "utf8")).signature;
  } catch {
    stamped = null;
  }

  if (process.env.E2E_REUSE_BUILD === "1") {
    if (!built) {
      configFailure(
        "E2E_REUSE_BUILD=1 was set, but there is no build in .next to reuse.",
        "Unset E2E_REUSE_BUILD so this script builds, or run the build yourself first.",
      );
    }
    console.log("[e2e-order] reusing the existing build (E2E_REUSE_BUILD=1)");
    return;
  }

  if (built && stamped === signature) {
    console.log("[e2e-order] the existing build matches these sources");
    return;
  }

  console.log(
    `[e2e-order] building the clinical live bundle (${built ? "sources changed" : "no build present"})`,
  );
  try {
    execFileSync(process.execPath, [NEXT_ENTRY, "build"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
  } catch {
    configFailure(
      "the clinical live build failed.",
      "Fix the build error above, then re-run. The battery cannot prove anything about a bundle that does not exist.",
    );
  }
  writeFileSync(STAMP, JSON.stringify({ signature, builtAt: new Date().toISOString() }, null, 2));
}

/**
 * The app port must be ours, for the same reason the stub must be.
 *
 * `playwright.config.ts` sets `reuseExistingServer: true`, so a server left
 * over from a demo-edition build would be silently reused and the battery
 * would report on a bundle nobody in this run produced.
 */
async function assertAppPortFree() {
  const reachable = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
    .then(() => true)
    .catch(() => false);
  if (reachable) {
    configFailure(
      `something is already listening on port ${APP_PORT}, and Playwright would reuse it.`,
      `Stop it and re-run, or set E2E_PORT to a free port.`,
    );
  }
}

/**
 * This script owns the fixture backend's lifecycle.
 *
 * It has to: the whole point is that BOTH runs see an identical starting
 * backend, and a stub left running from some earlier session would carry state
 * into the first run and quietly invalidate the comparison. Starting it here
 * also makes the proof a single reproducible command rather than a recipe
 * someone has to assemble correctly.
 */
const STUB_LOG = join(tmpdir(), "e2e-order-stub.log");

async function withStub(run) {
  // Always start our own, even if something is already listening. A stub left
  // over from an earlier run has an unknown history, and "the proof passed
  // against a backend I did not start" is not a proof.
  const strays = await fetch(`${STUB_BASE}/__control/reset-all`, { method: "POST" })
    .then((r) => r.ok)
    .catch(() => false);
  if (strays) {
    console.error(
      `[e2e-order] FAIL — something is already listening on ${STUB_BASE}. ` +
        `This proof must own the fixture backend end to end; a stray one ` +
        `carries state this script cannot account for. Stop it and re-run.`,
    );
    process.exit(1);
  }

  console.log(`[e2e-order] starting the fixture backend on ${STUB_BASE}`);
  const log = openSync(STUB_LOG, "w");
  const owned = spawn("node", ["scripts/live-stub-server.mjs"], {
    stdio: ["ignore", log, log],
    detached: false,
  });

  // A crashed fixture backend used to look like a dozen unrelated suites
  // failing in `beforeAll`. Name it at the moment it happens instead.
  let died = null;
  owned.on("exit", (code, signal) => {
    if (died === null) died = { code, signal };
  });

  let ready = false;
  for (let i = 0; i < 40 && !ready && died === null; i += 1) {
    await sleep(250);
    ready = await fetch(`${STUB_BASE}/__control/reset-all`, { method: "POST" })
      .then((r) => r.ok)
      .catch(() => false);
  }
  if (!ready) {
    owned.kill("SIGKILL");
    console.error(
      `[e2e-order] FAIL — the fixture backend never became ready on ` +
        `${STUB_BASE}. Its output is in ${STUB_LOG}:`,
    );
    console.error(readFileSync(STUB_LOG, "utf8").slice(-4000));
    process.exit(1);
  }

  // SIGINT/SIGTERM to the runner must also take the stub down — otherwise a
  // Ctrl+C leaves an orphan stub on 3999 and the next invocation trips the
  // "something is already listening" guard for a reason that has nothing to
  // do with what the operator is doing now.
  const killOwned = () => {
    try { owned.kill("SIGKILL"); } catch { /* already gone */ }
  };
  const onSignal = (sig) => {
    killOwned();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    return await run();
  } finally {
    if (died !== null) {
      console.error(
        `\n[e2e-order] the fixture backend DIED mid-run (code=${died.code} ` +
          `signal=${died.signal}). Every suite after that point failed in ` +
          `beforeAll for that reason and not their own. Its last output:`,
      );
      console.error(readFileSync(STUB_LOG, "utf8").slice(-4000));
    }
    killOwned();
  }
}

function run(label, files) {
  console.log(`\n[e2e-order] ${label} (${files.length} specs)`);
  let out = "";
  try {
    out = execFileSync(
      process.execPath,
      [PLAYWRIGHT_ENTRY, "test", ...files.map((f) => `e2e/${f}`)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const passed = /(\d+) passed/.exec(out);
  const failed = /(\d+) failed/.exec(out);
  const skipped = /(\d+) skipped/.exec(out);
  const result = {
    passed: passed ? Number(passed[1]) : 0,
    failed: failed ? Number(failed[1]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0,
  };
  console.log(
    `[e2e-order] ${label}: ${result.passed} passed, ${result.failed} failed, ` +
      `${result.skipped} skipped`,
  );
  if (result.failed > 0) {
    // Print the failing test titles so the diagnosis does not require a re-run.
    for (const line of out.split("\n")) {
      if (line.includes("✘") || line.trimStart().startsWith("1)")) {
        console.error(`    ${line.trim()}`);
      }
    }
  }
  return result;
}

/**
 * Every top-level route the specs navigate to. Warmed up via HTTP once per
 * battery, BEFORE the first Playwright spec runs, so that Windows first-hit
 * `next start` latency is paid on the runner's clock instead of on an
 * unlucky spec's 30s test timeout. Runner-side (not Playwright globalSetup)
 * so that:
 *   - it happens exactly once, not once per forward/reverse invocation
 *   - it does not participate in Playwright's own webServer/globalSetup
 *     state machine (an earlier globalSetup variant helped forward-order
 *     but broke reverse-order — the same warmup fired twice, once per
 *     invocation, and interacted with the second Playwright's fixture
 *     reset in a way that surfaced a real order-dependent inbox flake)
 *   - a route that exceeds the hard cap aborts the whole battery loudly,
 *     which IS the regression signal for the underlying first-hit cost.
 *
 * Not a retry, not a per-test-timeout inflation, not a skip, not an order
 * pin, not a weakened assertion.
 */
const WARMUP_ROUTES = [
  "/api/health",
  "/",
  "/today", "/calendar", "/patients", "/tasks", "/inbox",
  "/programs", "/billing", "/reports", "/integrations",
  "/settings", "/settings/imports", "/settings/knowledge",
  "/settings/plans", "/settings/governance",
  "/team", "/templates", "/wearables",
  "/login", "/reset",
];
const WARMUP_HARD_CAP_MS = 55_000;
const WARMUP_SOFT_CAP_MS = 8_000;

async function warmApp() {
  console.log(`[warmup] priming ${WARMUP_ROUTES.length} routes at http://localhost:${APP_PORT}`);
  const battery0 = Date.now();
  for (const route of WARMUP_ROUTES) {
    const t0 = Date.now();
    let status = -1;
    let err = "";
    try {
      const res = await fetch(`http://localhost:${APP_PORT}${route}`, {
        signal: AbortSignal.timeout(60_000),
        redirect: "manual",
      });
      status = res.status;
      // Read and discard the body so the connection can be reused / closed cleanly.
      await res.text().catch(() => "");
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - t0;
    const tag =
      err ? "ERR " :
      status >= 500 ? "5xx " :
      ms > WARMUP_SOFT_CAP_MS ? "SLOW" :
      "ok  ";
    console.log(
      `[warmup] ${tag} ${route.padEnd(28)} ${String(ms).padStart(5)}ms  status=${status}${err ? "  " + err.split("\n")[0] : ""}`,
    );
    if (ms > WARMUP_HARD_CAP_MS) {
      throw new Error(
        `Route ${route} took ${ms}ms during warmup (> ${WARMUP_HARD_CAP_MS}ms hard cap). ` +
          `The 30s test-timeout on any spec that navigates here will trip. ` +
          `Investigate before the battery runs — do not paper this over with a longer timeout.`,
      );
    }
  }
  console.log(`[warmup] complete in ${Date.now() - battery0}ms`);
}

async function withApp(run) {
  const owned = spawn(
    process.execPath, [NEXT_ENTRY, "start", "-p", String(APP_PORT)],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  const appLog = [];
  const push = (buf) => { appLog.push(String(buf)); if (appLog.length > 200) appLog.shift(); };
  owned.stdout.on("data", push);
  owned.stderr.on("data", push);
  let died = null;
  owned.on("exit", (code, signal) => { if (died === null) died = { code, signal }; });

  const killOwned = () => { try { owned.kill("SIGKILL"); } catch { /* already gone */ } };
  const onSignal = (sig) => { killOwned(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready && died === null; i += 1) {
      await sleep(500);
      ready = await fetch(`http://localhost:${APP_PORT}/api/health`)
        .then((r) => r.ok).catch(() => false);
    }
    if (!ready) {
      console.error(`[e2e-order] FAIL — next start never became ready on ${APP_PORT}. Its last output:`);
      console.error(appLog.join(""));
      process.exit(1);
    }
    await warmApp();
    return await run();
  } finally {
    killOwned();
  }
}

/* ------------------------------------------------------------------ run */

const appliedDefaults = provisionEnv();
const chromium = provisionBrowser();
console.log(
  `[e2e-order] configuration: edition=${process.env.APP_EDITION} live=1 ` +
    `stub=${STUB_BASE} port=${APP_PORT}` +
    (chromium ? ` chromium=${chromium}` : " chromium=playwright default"),
);
if (appliedDefaults.length > 0) {
  console.log(`[e2e-order] provisioned by this script: ${appliedDefaults.join(", ")}`);
}
await assertAppPortFree();
provisionBuild();

const { forward, reverse } = await withStub(async () =>
  withApp(async () => ({
    forward: run("forward order", specs),
    reverse: run("reverse order", [...specs].reverse()),
  })),
);

const problems = [];
if (forward.failed > 0) problems.push(`${forward.failed} failed in forward order`);
if (reverse.failed > 0) problems.push(`${reverse.failed} failed in reverse order`);
if (forward.passed !== reverse.passed) {
  problems.push(
    `passing totals differ (${forward.passed} forward vs ${reverse.passed} ` +
      `reverse) — a suite behaves differently depending on what ran before it`,
  );
}
if (forward.passed === 0) {
  // Zero-passed-zero-failed is what a misconfigured run looks like, and it
  // would otherwise be reported as success.
  problems.push("no tests ran; the battery is not actually being exercised");
}

if (problems.length) {
  console.error(`\n[e2e-order] FAIL`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `\n[e2e-order] PASS — ${forward.passed} passed in both orders, 0 failed. ` +
    `The battery does not depend on spec order.`,
);
