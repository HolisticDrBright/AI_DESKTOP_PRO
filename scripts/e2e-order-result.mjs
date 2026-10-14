/**
 * Keep the child-process outcome separate from Playwright's human summary.
 * A runner that crashes after printing `N passed` has not passed the gate.
 */
export function summarizePlaywrightResult(output, exitOk) {
  const count = (label) => {
    const matches = [...output.matchAll(new RegExp(`(\\d+) ${label}\\b`, "g"))];
    return matches.length ? Number(matches.at(-1)[1]) : 0;
  };
  return {
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    exitOk,
  };
}

export function failedTestTitles(output) {
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("✘") || /^\d+\)\s/.test(line));
}

export function orderResultProblems(forward, reverse) {
  const problems = [];
  if (!forward.exitOk) problems.push("forward Playwright process exited non-zero");
  if (!reverse.exitOk) problems.push("reverse Playwright process exited non-zero");
  if (forward.failed > 0) problems.push(`${forward.failed} failed in forward order`);
  if (reverse.failed > 0) problems.push(`${reverse.failed} failed in reverse order`);
  if (forward.passed !== reverse.passed) {
    problems.push(`passing totals differ (${forward.passed} forward vs ${reverse.passed} reverse) — a suite behaves differently depending on what ran before it`);
  }
  if (forward.skipped !== reverse.skipped) {
    problems.push(`skipped totals differ (${forward.skipped} forward vs ${reverse.skipped} reverse)`);
  }
  if (forward.passed === 0) problems.push("no tests ran; the battery is not actually being exercised");
  return problems;
}
