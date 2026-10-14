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
 *
 * The runtime is `next dev` with the contract fixture, as in CI's live-fixture
 * job; why, and which specs run, is in scripts/e2e-order-config.mjs. The
 * clinical production bundle is still built, with the fixture disabled, so the
 * battery also proves the bundle a deployment would ship builds. Each order
 * gets a FRESH dev server and a reset fixture backend, so both start from the
 * same state. Outcomes are read from Playwright's JSON report by test identity:
 * a declared skip is reported with its reason and never counted as a pass, a
 * test a failed hook never ran is a failure, and both orders must pass the
 * same tests, not merely the same number of them.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { devServerEnvironment } from "./e2e-dev-resources.mjs";
import {
  NEXT_BUILTIN_ENTRY_URLS,
  appEntryUrls,
  compareOrders,
  fixturePostureFromProbe,
  memorySamples,
  orderBatteryEnvironment,
  selectOrderBattery,
  summarizeReport,
  testTimeline,
  workerRestarts,
} from "./e2e-order-config.mjs";

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

const battery = selectOrderBattery(readdirSync("e2e"));
const specs = battery.run;

if (specs.length === 0) {
  console.error("[e2e-order] FAIL — no spec files found");
  process.exit(1);
}

const STUB_BASE = process.env.E2E_STUB_BASE ?? "http://127.0.0.1:3999";
const APP_PORT = Number(process.env.E2E_PORT ?? 3114);
/**
 * Evidence kept OUTSIDE test-results/, which Playwright empties at the start of every run: the development server's
 * whole log (with its memory samples), a latency canary, each order's JSON report and test timeline, and the summary.
 * Titles, timings, status codes and memory figures only — no request bodies, headers or credentials.
 */
const EVIDENCE = process.env.E2E_ORDER_EVIDENCE ?? join("e2e-order-evidence", new Date().toISOString().replace(/[:.]/g, "-"));
const SUMMARY = join(EVIDENCE, "summary.json");
let currentOrder = "startup";

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
 * An explicitly-set variable always wins, except where it would make the
 * battery a different claim (a production NODE_ENV, an opted-out fixture, a
 * backend that is not loopback): those refuse, naming the fix.
 */
function provisionEnv() {
  const result = orderBatteryEnvironment(process.env, { stubBase: STUB_BASE, port: APP_PORT });
  if ("refusal" in result) configFailure(result.refusal, result.fix);
  for (const [key, value] of Object.entries(result.env)) process.env[key] = value;
  if (battery.unclassified.length > 0) {
    configFailure(
      `${battery.unclassified.join(", ")} ${battery.unclassified.length === 1 ? "is" : "are"} neither a live- spec nor a separately configured one.`,
      "Name it live-*.spec.ts to join this battery, or add it to SEPARATELY_CONFIGURED_SPECS in scripts/e2e-order-config.mjs with the CI job that runs it.",
    );
  }
  return result.applied;
}

/**
 * The dev server's explicit heap budget, validated before anything boots. The
 * same rule the Playwright config applies (scripts/e2e-dev-resources.mjs).
 */
function provisionHeap() {
  try {
    return devServerEnvironment(process.env);
  } catch (error) {
    configFailure(error instanceof Error ? error.message : String(error),
      "Set E2E_DEV_HEAP_MB alone (2048-12288, with 4096 MiB to spare), or leave it unset to inherit NODE_OPTIONS.");
  }
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
  hash.update("e2e-production-build-with-fixture-disabled/1");
  return hash.digest("hex");
}

const STAMP = ".next/.e2e-provision.json";

/**
 * Build the clinical production bundle with the local fixture disabled, then
 * run the browser battery separately against a development server. A
 * production-mode server categorically refuses the contract fixture.
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
      // The fixture is off for this build. It gets the same explicit heap as the development server (which starts only
      // after it): with E2E_DEV_HEAP_MB set, NODE_OPTIONS carries no heap of its own, and Node's default is too small for
      // the type-check pass (observed: out of memory at about 2 GiB).
      env: {
        ...process.env, CLINICAL_CONTRACT_FIXTURE: "", E2E_DEV_SERVER: "0",
        ...(process.env.E2E_DEV_HEAP_MB ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${process.env.E2E_DEV_HEAP_MB}`.trim() } : {}),
      },
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
 * Playwright reuses whatever answers on the port (`reuseExistingServer`, and
 * E2E_ORDER_OWNED_SERVER=1 keeps that true under CI too), so a server left over
 * from another configuration would be silently reused and the battery would
 * report on a server nobody in this run started.
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

/**
 * Playwright runs as an ASYNCHRONOUS child. It must: this process owns the development server's stdout and stderr
 * pipes, and on Linux a server's write to a full pipe blocks it. A synchronous child (execFileSync, as this runner
 * used) froze this process's event loop for the whole order, so nothing drained the server's pipes; `next dev` logs
 * every request, and once about 64 KiB had accumulated the server stopped mid-write — navigations timed out, a
 * readback stayed "Loading", and the stall arrived only after enough suites had run.
 */
function playwright(files, reportFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_ENTRY, "test", "--reporter=list,json", ...files.map((f) => `e2e/${f}`)], {
      stdio: ["ignore", "pipe", "pipe"],
      // Only this runner's own children may reuse the server it started (scripts/e2e-dev-resources.mjs).
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, E2E_ORDER_OWNED_SERVER: "1" },
    });
    // Echoed as it arrives so a long order's progress (and the moment a test fails) is visible in the runner's own log,
    // and kept for the failure path below.
    const chunks = [];
    child.stdout.on("data", (b) => { chunks.push(b); process.stdout.write(b); });
    child.stderr.on("data", (b) => { chunks.push(b); process.stderr.write(b); });
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function run(label, files) {
  console.log(`\n[e2e-order] ${label} (${files.length} specs)`);
  const reportFile = join(tmpdir(), `e2e-order-${label.replace(/\W+/g, "-")}-${process.pid}.json`);
  rmSync(reportFile, { force: true });
  const out = await playwright(files, reportFile);
  let report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    console.error(`[e2e-order] FAIL — ${label}: Playwright wrote no JSON report. Its last output:`);
    console.error(out.slice(-6000));
    process.exit(1);
  }
  const result = summarizeReport(report);
  const slug = label.replace(/\W+/g, "-");
  writeFileSync(join(EVIDENCE, `${slug}.report.json`), JSON.stringify(report));
  writeFileSync(join(EVIDENCE, `${slug}.timeline.jsonl`), testTimeline(report).map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(
    `[e2e-order] ${label}: ${result.passed.length} passed, ${result.failed.length} failed or did not run, ` +
      `${result.skipped.length} skipped by declaration (not counted as passes)`,
  );
  for (const failure of result.failed) console.error(`    ✘ [${failure.status}] ${failure.id}\n        ${failure.message}`);
  for (const error of result.errors) console.error(`    ✘ [outside any test] ${error}`);
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
/**
 * Compile the whole app once, before any spec: every entry (scripts/e2e-order-config.mjs, appEntryUrls) requested 24 at
 * a time, so `next dev` batches them into a handful of compilations. The harness's server keeps routes compiled
 * (next.config.ts), so after this no test waits on a compile. Status codes do not matter here — an API route asked
 * with GET answers 405 after it has compiled. A bounded step: past its cap the battery stops, loudly.
 */
const PRECOMPILE_CONCURRENCY = 24;
const PRECOMPILE_CAP_MS = 15 * 60_000;

async function precompileApp(compilations) {
  const urls = [...appEntryUrls(readdirSync("src/app", { recursive: true }).map(String)), ...NEXT_BUILTIN_ENTRY_URLS];
  const before = compilations();
  const t0 = Date.now();
  const statuses = {};
  let next = 0;
  let slowestMs = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const started = Date.now();
      let status = "error";
      try {
        const res = await fetch(`http://localhost:${APP_PORT}${url}`, { redirect: "manual", signal: AbortSignal.timeout(PRECOMPILE_CAP_MS) });
        await res.arrayBuffer().catch(() => null);
        status = String(res.status);
      } catch { /* counted as an error below */ }
      statuses[status] = (statuses[status] ?? 0) + 1;
      slowestMs = Math.max(slowestMs, Date.now() - started);
    }
  };
  await Promise.all(Array.from({ length: PRECOMPILE_CONCURRENCY }, worker));
  const result = { entries: urls.length, ms: Date.now() - t0, slowestMs, compilations: compilations() - before, statuses };
  writeFileSync(join(EVIDENCE, "precompile.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`[e2e-order] compiled ${result.entries} app entries in ${result.ms} ms (${result.compilations} compilations; statuses ${JSON.stringify(statuses)})`);
  if (result.ms > PRECOMPILE_CAP_MS || statuses.error) {
    console.error(`[e2e-order] FAIL — the app did not compile within ${PRECOMPILE_CAP_MS} ms, or a request got no answer. No spec ran.`);
    process.exit(1);
  }
  return result;
}

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

async function withApp(heap, run) {
  const owned = spawn(
    process.execPath, [NEXT_ENTRY, "dev", "-p", String(APP_PORT)],
    // Its own process group: `next dev` runs the server in a worker process, and killing only the CLI orphans that
    // worker on the port, so the next run refuses ("something is already listening") for a reason it did not cause.
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...heap }, detached: true },
  );
  const appLog = [];
  let compiled = 0;
  const serverLog = createWriteStream(join(EVIDENCE, "dev-server.log"), { flags: "a" });
  const push = (buf) => {
    const text = String(buf);
    appLog.push(text); if (appLog.length > 200) appLog.shift();
    compiled += (text.match(/ Compiled /g) ?? []).length;
    // Every line is kept, stamped, for the whole battery: a stall is diagnosed from what the server said at the time.
    const stamp = new Date().toISOString();
    serverLog.write(text.split("\n").filter((line) => line.length > 0).map((line) => `[${stamp}] [${currentOrder}] ${line}`).join("\n") + "\n");
  };
  owned.stdout.on("data", push);
  owned.stderr.on("data", push);
  let died = null;
  owned.on("exit", (code, signal) => { if (died === null) died = { code, signal }; });

  const killOwned = () => {
    try { process.kill(-owned.pid, "SIGKILL"); } catch { try { owned.kill("SIGKILL"); } catch { /* already gone */ } }
  };
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
      console.error(`[e2e-order] FAIL — next dev never became ready on ${APP_PORT}. Its last output:`);
      console.error(appLog.join(""));
      process.exit(1);
    }
    // Observe the fixture posture before any spec runs. Forty-five suites failing in beforeAll is what a refused
    // fixture used to look like; one precise line is what it looks like now.
    const probe = await fetch(`http://localhost:${APP_PORT}/today`, { redirect: "manual", signal: AbortSignal.timeout(120_000) })
      .then(async (r) => { await r.text().catch(() => ""); return { status: r.status, location: r.headers.get("location") }; })
      .catch((e) => ({ status: -1, location: String(e) }));
    const posture = fixturePostureFromProbe(probe);
    if (!posture.allowed) {
      console.error(`\n[e2e-order] FAIL — ${posture.detail} No spec ran. The refusal is correct for a deployed runtime ` +
        "and is not weakened here; check that this server is `next dev` with CLINICAL_CONTRACT_FIXTURE=1 and a loopback backend.");
      console.error(appLog.join("").slice(-4000));
      process.exit(1);
    }
    console.log("[e2e-order] contract fixture allowed by this server (observed: a signed-out page rendered)");
    await precompileApp(() => compiled);
    await warmApp();
    const canary = startCanary();
    try {
      return await run();
    } finally {
      await canary.stop();
    }
  } finally {
    killOwned();
    for (let i = 0; i < 40 && died === null; i += 1) await sleep(250);
    serverLog.end();
  }
}

/**
 * A latency canary beside the battery: every 15 s, sequentially (never more than one request in flight), the sign-in
 * page, the health route and the lens evaluation readback the specs exercise. It measures the server under exactly the
 * accumulated load the battery puts on it; it changes no state and asserts nothing.
 */
const CANARY_PATHS = [
  "/login",
  "/api/health",
  "/api/live/lens/evaluation?encounterId=eeeeeeee-2222-3333-4444-444444444777&paradigm=western_conventional",
];
function startCanary() {
  let stopped = false;
  const file = join(EVIDENCE, "canary.jsonl");
  const loop = (async () => {
    while (!stopped) {
      for (const path of CANARY_PATHS) {
        if (stopped) break;
        const t0 = Date.now();
        let status = -1, error = null;
        try {
          const res = await fetch(`http://localhost:${APP_PORT}${path}`, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
          status = res.status;
          await res.text().catch(() => "");
        } catch (e) {
          error = e instanceof Error ? e.name : "error";
        }
        appendFileSync(file, JSON.stringify({ at: new Date(t0).toISOString(), order: currentOrder,
          path: path.split("?")[0], status, ms: Date.now() - t0, ...(error ? { error } : {}) }) + "\n");
      }
      for (let i = 0; i < 15 && !stopped; i += 1) await sleep(1000);
    }
  })();
  return { stop: async () => { stopped = true; await loop; } };
}

/* ------------------------------------------------------------------ run */

const appliedDefaults = provisionEnv();
const heap = provisionHeap();
const chromium = provisionBrowser();
console.log(
  `[e2e-order] configuration: edition=${process.env.APP_EDITION} live=1 server=next dev fixture=1 ` +
    `stub=${STUB_BASE} port=${APP_PORT}` +
    (heap.NODE_OPTIONS ? ` heap=${process.env.E2E_DEV_HEAP_MB}MiB` : ` heap=inherited(${process.env.NODE_OPTIONS ?? "node default"})`) +
    (chromium ? ` chromium=${chromium}` : " chromium=playwright default"),
);
if (appliedDefaults.length > 0) {
  console.log(`[e2e-order] provisioned by this script: ${appliedDefaults.join(", ")}`);
}
console.log(`[e2e-order] battery: all ${specs.length} specs in one development server for both orders; ` +
  `${battery.separatelyConfigured.length} need a posture of their own, so their tests skip by declaration and are not counted:`);
for (const { spec, reason } of battery.separatelyConfigured) console.log(`    - ${spec}: ${reason}`);
mkdirSync(EVIDENCE, { recursive: true });
console.log(`[e2e-order] evidence: ${EVIDENCE}`);
await assertAppPortFree();
provisionBuild();

const orders = [["forward order", specs], ["reverse order", [...specs].reverse()]];
// ONE development server carries both orders: the battery measures what accumulated load does to it, so it is never
// restarted between suites or orders. Only the fixture backend is reset before each order.
const results = await withStub(async () => withApp(heap, async () => {
  const out = {};
  for (const [label, files] of orders) {
    currentOrder = label;
    await fetch(`${STUB_BASE}/__control/reset-all`, { method: "POST" });
    out[label] = await run(label, files);
  }
  currentOrder = "shutdown";
  return out;
}));
const forward = results["forward order"], reverse = results["reverse order"];
const verdict = compareOrders(forward, reverse);

const serverLogText = readFileSync(join(EVIDENCE, "dev-server.log"), "utf8");
const memory = memorySamples(serverLogText);
const windows = memory.filter((m) => typeof m.eventLoopDelayMaxMs === "number");
const restarts = workerRestarts(serverLogText);
const precompile = existsSync(join(EVIDENCE, "precompile.json")) ? JSON.parse(readFileSync(join(EVIDENCE, "precompile.json"), "utf8")) : null;
const canary = readFileSync(join(EVIDENCE, "canary.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const slowest = [...canary].sort((a, b) => b.ms - a.ms).slice(0, 5);
writeFileSync(SUMMARY, JSON.stringify({
  contract: "e2e-order-summary/2",
  runtime: { server: "next dev (one process, both orders)", contractFixture: true, stub: STUB_BASE, heapMiB: process.env.E2E_DEV_HEAP_MB ?? null },
  battery: specs, separatelyConfigured: battery.separatelyConfigured,
  forward, reverse, verdict,
  memory: {
    samples: memory.length, maxHeapUsedMiB: Math.max(0, ...memory.map((m) => m.heapUsedMiB)), maxRssMiB: Math.max(0, ...memory.map((m) => m.rssMiB)),
    maxHeapAfterMajorGcMiB: Math.max(0, ...windows.map((m) => m.heapAfterMajorGcMiB ?? 0)), maxEventLoopDelayMs: Math.max(0, ...windows.map((m) => m.eventLoopDelayMaxMs)),
    workerRestarts: restarts,
  },
  precompile,
  canary: { requests: canary.length, failures: canary.filter((c) => c.status < 0 || c.status >= 500).length, slowest },
}, null, 2) + "\n");
console.log(`[e2e-order] memory: ${memory.length} samples, max heap used ${Math.max(0, ...memory.map((m) => m.heapUsedMiB))} MiB, max RSS ${Math.max(0, ...memory.map((m) => m.rssMiB))} MiB, ` +
  `max retained ${Math.max(0, ...windows.map((m) => m.heapAfterMajorGcMiB ?? 0))} MiB, longest event-loop delay ${Math.max(0, ...windows.map((m) => m.eventLoopDelayMaxMs))} ms, worker restarts ${restarts}`);
console.log(`[e2e-order] canary: ${canary.length} requests; slowest ${slowest.map((c) => `${c.path} ${c.ms}ms (${c.order}${c.error ? ", " + c.error : ""})`).join("; ")}`);

if (forward.skipped.length > 0) {
  console.log(`\n[e2e-order] ${forward.skipped.length} skipped by declaration in each order (not passes):`);
  const reasons = new Map();
  for (const { reason } of forward.skipped) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  for (const [reason, count] of reasons) console.log(`    - ${count} × ${reason}`);
}

if (!verdict.ok || restarts > 0) {
  console.error(`\n[e2e-order] FAIL (details in ${SUMMARY})`);
  for (const p of verdict.problems) console.error(`  - ${p}`);
  // A restart drops whatever was in flight; a battery that survived one has not shown the server holds up.
  if (restarts > 0) console.error(`  - the development server restarted its own worker ${restarts} time(s) at its heap threshold`);
  for (const id of verdict.forwardOnly.slice(0, 20)) console.error(`    passed only forward: ${id}`);
  for (const id of verdict.reverseOnly.slice(0, 20)) console.error(`    passed only reverse: ${id}`);
  process.exit(1);
}

console.log(
  `\n[e2e-order] PASS — the same ${forward.passed.length} tests passed in both orders, 0 failed, ` +
    `${forward.skipped.length} skipped by declaration and not counted. The battery does not depend on spec order. ` +
    `Summary: ${SUMMARY}`,
);
