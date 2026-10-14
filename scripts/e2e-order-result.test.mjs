import assert from "node:assert/strict";
import test from "node:test";
import { orderResultProblems, summarizePlaywrightResult } from "./e2e-order-result.mjs";

test("a crash after a passing summary cannot pass the order gate", () => {
  const output = "  307 passed (28m)\n  19 skipped\n";
  const forward = summarizePlaywrightResult(output, false);
  const reverse = summarizePlaywrightResult(output, true);
  assert.equal(forward.passed, 307);
  assert.deepEqual(orderResultProblems(forward, reverse), [
    "forward Playwright process exited non-zero",
  ]);
});

test("a nonzero child without a test summary is identified as a process failure", () => {
  const forward = summarizePlaywrightResult("node: out of memory", false);
  const reverse = summarizePlaywrightResult("node: out of memory", false);
  assert.deepEqual(orderResultProblems(forward, reverse), [
    "forward Playwright process exited non-zero",
    "reverse Playwright process exited non-zero",
    "no tests ran; the battery is not actually being exercised",
  ]);
});

test("count and skip drift remain failures even when both processes exit zero", () => {
  const forward = summarizePlaywrightResult("  304 passed\n  19 skipped", true);
  const reverse = summarizePlaywrightResult("  303 passed\n  20 skipped", true);
  assert.match(orderResultProblems(forward, reverse).join("\n"), /passing totals differ/);
  assert.match(orderResultProblems(forward, reverse).join("\n"), /skipped totals differ/);
});

test("a complete symmetric result passes", () => {
  const result = summarizePlaywrightResult("  307 passed\n  19 skipped", true);
  assert.deepEqual(orderResultProblems(result, result), []);
});
