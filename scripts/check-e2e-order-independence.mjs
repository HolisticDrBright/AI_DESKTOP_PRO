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
import { openSync, readFileSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const specs = readdirSync("e2e")
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

if (specs.length === 0) {
  console.error("[e2e-order] FAIL — no spec files found");
  process.exit(1);
}

const STUB_BASE = process.env.E2E_STUB_BASE ?? "http://127.0.0.1:3999";

/**
 * This script owns the fixture backend's lifecycle.
 *
 * It has to: the whole point is that BOTH runs see an identical starting
 * backend, and a stub left running from some earlier session would carry state
 * into the first run and quietly invalidate the comparison. Starting it here
 * also makes the proof a single reproducible command rather than a recipe
 * someone has to assemble correctly.
 */
const STUB_LOG = "/tmp/e2e-order-stub.log";

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
    owned.kill("SIGKILL");
  }
}

function run(label, files) {
  console.log(`\n[e2e-order] ${label} (${files.length} specs)`);
  let out = "";
  try {
    out = execFileSync(
      "npx",
      ["playwright", "test", ...files.map((f) => `e2e/${f}`)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
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

const { forward, reverse } = await withStub(async () => ({
  forward: run("forward order", specs),
  reverse: run("reverse order", [...specs].reverse()),
}));

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
