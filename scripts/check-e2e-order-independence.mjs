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

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const specs = readdirSync("e2e")
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

if (specs.length === 0) {
  console.error("[e2e-order] FAIL — no spec files found");
  process.exit(1);
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

const forward = run("forward order", specs);
const reverse = run("reverse order", [...specs].reverse());

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
