/**
 * What the order-independence battery runs, under which runtime, and how its result is counted.
 *
 * Pure functions only, so each rule is tested on its own (scripts/e2e-order-config.test.mjs) and the driver
 * (scripts/check-e2e-order-independence.mjs) stays a sequence of steps.
 *
 * WHY THE BATTERY RUNS `next dev`. `next start` forces NODE_ENV=production, which the deployed-runtime detector reads
 * as a deployment signal, categorically. The contract-fixture boundary (src/server/runtime/contractFixture.ts) then
 * refuses the loopback fixture, so a battery driven against `next start` measures that refusal 45 times and nothing
 * else. The refusal is right and is not touched here: the battery moves to the runtime where the fixture is
 * legitimately allowed, exactly as CI's "Browser suite (live mode vs contract fixture)" job does.
 */

/**
 * The battery is EVERY spec, in one process per order, as the one-process proof has always been: nothing is dropped to
 * lighten the load the battery is meant to measure. The specs below need a server posture of their own (and have their
 * own CI job), so under this configuration their tests skip by their own declaration; they are listed so that a skip is
 * expected, reported with its reason, and never counted as a pass. A new spec that is neither `live-` nor listed is a
 * configuration error, so no spec's outcome goes unclassified.
 */
export const SEPARATELY_CONFIGURED_SPECS = Object.freeze({
  'aws-recording-capture.spec.ts': 'needs E2E_RECORDING_AWS=1 (CI: "Recording and care messages browser suites")',
  'aws-recording-cleanup-execution.spec.ts': 'needs E2E_RECORDING_AWS=1 (CI: "Recording and care messages browser suites")',
  'aws-recording-cleanup-review.spec.ts': 'needs E2E_RECORDING_AWS=1 (CI: "Recording and care messages browser suites")',
  'aws-recording-consent.spec.ts': 'needs E2E_RECORDING_AWS=1 (CI: "Recording and care messages browser suites")',
  'aws-recording-transcription.spec.ts': 'needs E2E_RECORDING_AWS=1 (CI: "Recording and care messages browser suites")',
  'care-messages.spec.ts': 'needs E2E_CARE_MESSAGES=1 (CI: "Recording and care messages browser suites")',
  'clinical-edition.spec.ts': 'needs a DOWN backend, E2E_CLINICAL_DOWN=1 (CI: e2e-clinical-down)',
  'commerce-journey.spec.ts': 'needs COMMERCE_JOURNEY_FIXTURE=1 on top of the fixture (CI: e2e-live-fixture, shard 1)',
  'framework-release-boundary.spec.ts': 'needs a production build without the fixture (CI: framework release boundary)',
  'zoom-sdk-bootstrap.spec.ts': 'needs E2E_ZOOM_SDK=1 and the real pinned CDN (CI: e2e-live-fixture, shard 1)',
});

/** @param {string[]} files every `*.spec.ts` in e2e/ */
export function selectOrderBattery(files) {
  const sorted = [...files].filter(file => file.endsWith('.spec.ts')).sort();
  const run = sorted;
  const excluded = [];
  const unclassified = [];
  for (const file of sorted) {
    if (file.startsWith('live-')) continue;
    if (Object.hasOwn(SEPARATELY_CONFIGURED_SPECS, file)) excluded.push({ spec: file, reason: SEPARATELY_CONFIGURED_SPECS[file] });
    else unclassified.push(file);
  }
  return { run, separatelyConfigured: excluded, unclassified };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const POSTURE_REFUSAL = 'the local contract fixture requires a development browser server and cannot run in a production posture.';

/**
 * The environment for the battery's own processes. Unset values are provisioned; the fixture's targets and
 * credentials are then PINNED to the fictional local values, and anything else is refused before any network request
 * or process starts — an operator's value is never silently redirected, and the runner is never pointed at a live
 * service or handed a real credential (Codex 34330b2c). Each refusal names its fix.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ stubBase: string, port: number }} options
 * @returns {{ env: Record<string, string>, applied: string[] } | { refusal: string, fix: string }}
 */
export function orderBatteryEnvironment(env, { stubBase, port }) {
  const defaults = {
    APP_EDITION: 'clinical',
    E2E_LIVE: '1',
    E2E_DEV_SERVER: '1',
    CLINICAL_CONTRACT_FIXTURE: '1',
    // The whole battery retains many compiled routes on one development server. The resource helper refuses this
    // budget without a separate 4 GiB reserve, and it never applies to a production process.
    E2E_DEV_HEAP_MB: '10240',
    NEXT_PUBLIC_USE_LIVE_API: 'true',
    TRPC_BASE_URL: `${stubBase}/api/trpc`,
    CLINICAL_SUPABASE_URL: stubBase,
    CLINICAL_SUPABASE_ANON_KEY: 'stub',
    CLINICAL_DEMO_EMAIL: 'demo@local',
    CLINICAL_DEMO_PASSWORD: 'demo',
    CLINICAL_ORG_ID: 'org-fixture',
    E2E_PORT: String(port),
  };
  const out = { ...env };
  const applied = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined || out[key] === '') { out[key] = value; applied.push(key); }
  }
  if (out.APP_EDITION !== 'clinical') {
    return { refusal: `APP_EDITION is "${out.APP_EDITION}", but this battery only runs against the clinical edition.`, fix: 'Unset APP_EDITION and re-run, or set APP_EDITION=clinical.' };
  }
  if (out.E2E_LIVE !== '1' || out.E2E_DEV_SERVER !== '1' || out.CLINICAL_CONTRACT_FIXTURE !== '1' || out.NODE_ENV === 'production') {
    return { refusal: POSTURE_REFUSAL, fix: 'Unset NODE_ENV=production and set E2E_LIVE=1, E2E_DEV_SERVER=1 and CLINICAL_CONTRACT_FIXTURE=1. Do not weaken the refusal: a production-mode server must keep refusing the fixture.' };
  }
  let stub = null;
  try { stub = new URL(stubBase); } catch { stub = null; }
  if (!stub || stub.protocol !== 'http:' || !LOOPBACK.has(stub.hostname) || stub.username || stub.password
    || stub.pathname !== '/' || stub.search || stub.hash) {
    return { refusal: 'E2E_STUB_BASE is not a loopback HTTP fixture origin.', fix: 'Use a loopback HTTP fixture origin without credentials or a path.' };
  }
  const pinned = {
    NEXT_PUBLIC_USE_LIVE_API: 'true',
    TRPC_BASE_URL: `${stubBase}/api/trpc`,
    CLINICAL_SUPABASE_URL: stubBase,
    CLINICAL_SUPABASE_ANON_KEY: 'stub',
    CLINICAL_DEMO_EMAIL: 'demo@local',
    CLINICAL_DEMO_PASSWORD: 'demo',
    CLINICAL_ORG_ID: 'org-fixture',
  };
  for (const [key, expected] of Object.entries(pinned)) {
    if (out[key] !== expected) {
      return { refusal: `${key} does not match this runner's fictional local fixture.`,
        fix: `Unset ${key} or set it to the documented local fixture value; do not point this runner at a live service.` };
    }
  }
  return { env: out, applied };
}

/**
 * Whether the running server allowed the fixture. Observed, not assumed: with the fixture allowed and the demo
 * fallback configured, the middleware renders a signed-out page; with it refused, the same request is redirected to
 * /login. This reads an existing response and adds no endpoint that could disclose posture.
 *
 * @param {{ status: number, location: string | null }} response the reply to GET /today with redirects not followed
 */
export function fixturePostureFromProbe(response) {
  if (response.status === 200) return { allowed: true };
  if (response.status >= 300 && response.status < 400 && /\/login(?:[?#]|$)/.test(response.location ?? '')) {
    return { allowed: false, detail: 'GET /today was redirected to /login: this server refused the contract fixture.' };
  }
  return { allowed: false, detail: `GET /today answered ${response.status}; the fixture posture could not be observed.` };
}

/**
 * Every test's outcome from Playwright's JSON report, by stable identity (file, title path, line). Only a `passed`
 * result of an `expected` test is a pass. A skip counts as a skip only when the spec DECLARED it (a `skip` or `fixme`
 * annotation, which carries the reason); it is never counted as a pass. Playwright also reports `skipped`, with no
 * annotation, for every test a failed `beforeAll` never ran — that is a test that did not run, and it is a failure,
 * as are interrupted, timed-out and flaky ones.
 *
 * @param {any} report the parsed JSON reporter output
 */
export function summarizeReport(report) {
  const passed = [], failed = [], skipped = [];
  const visit = (suite, titles) => {
    const path = suite.title && !suite.title.endsWith('.spec.ts') ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const id = `${spec.file}:${spec.line} › ${[...path, spec.title].join(' › ')}`;
        const results = test.results ?? [];
        const last = results[results.length - 1];
        const declared = [...(test.annotations ?? []), ...(last?.annotations ?? [])].find(a => a.type === 'skip' || a.type === 'fixme');
        const status = last?.status ?? 'did_not_run';
        if (status === 'passed' && test.status === 'expected') passed.push(id);
        else if (status === 'skipped' && declared) skipped.push({ id, reason: declared.description || `${declared.type} without a stated reason` });
        else if (status === 'skipped') failed.push({ id, status: 'did_not_run', message: 'did not run (an earlier hook in its file failed)' });
        else {
          const message = String(last?.error?.message ?? last?.errors?.[0]?.message ?? status).replace(/\u001b\[[0-9;]*m/g, '');
          failed.push({ id, status, message: message.split('\n').slice(0, 3).join(' ').slice(0, 400) });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, path);
  };
  for (const suite of report?.suites ?? []) visit(suite, []);
  const errors = (report?.errors ?? []).map(e => String(e.message ?? e).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0]);
  return { passed: passed.sort(), failed, skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)), errors };
}

/**
 * The verdict. Both orders must fail nothing, pass the SAME tests (by identity, not by count), skip the same tests
 * for declared reasons, and actually exercise the battery. A count that matches while different tests pass is a
 * leak, not a pass.
 */
export function compareOrders(forward, reverse) {
  const problems = [];
  for (const [label, run] of [['forward', forward], ['reverse', reverse]]) {
    if (run.errors.length) problems.push(`${label} order: Playwright reported ${run.errors.length} error(s) outside any test: ${run.errors[0]}`);
    if (run.failed.length) problems.push(`${label} order: ${run.failed.length} failed`);
    if (run.passed.length === 0) problems.push(`${label} order: no test passed; the battery was not exercised`);
  }
  const onlyIn = (a, b) => a.filter(id => !b.includes(id));
  const forwardOnly = onlyIn(forward.passed, reverse.passed), reverseOnly = onlyIn(reverse.passed, forward.passed);
  if (forwardOnly.length || reverseOnly.length) {
    problems.push(`different tests passed in each order (${forwardOnly.length} only forward, ${reverseOnly.length} only reverse): a suite depends on what ran before it`);
  }
  const skippedIds = run => run.skipped.map(s => s.id);
  if (onlyIn(skippedIds(forward), skippedIds(reverse)).length || onlyIn(skippedIds(reverse), skippedIds(forward)).length) {
    problems.push('different tests were skipped in each order');
  }
  return { ok: problems.length === 0, problems, forwardOnly, reverseOnly };
}

/**
 * When each test ran and for how long, from the same JSON report, so a stall can be laid beside the server's memory
 * and latency samples taken at the same time. Titles and timings only; no request data.
 *
 * @param {any} report
 */
export function testTimeline(report) {
  const rows = [];
  const visit = (suite, titles) => {
    const path = suite.title && !suite.title.endsWith('.spec.ts') ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const last = (test.results ?? []).at(-1);
      rows.push({ id: `${spec.file}:${spec.line} › ${[...path, spec.title].join(' › ')}`, status: last?.status ?? 'did_not_run',
        startTime: last?.startTime ?? null, durationMs: last?.duration ?? null });
    }
    for (const child of suite.suites ?? []) visit(child, path);
  };
  for (const suite of report?.suites ?? []) visit(suite, []);
  return rows.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
}

/**
 * Every app entry as one URL to request before any spec runs: each `page` or `route` file under src/app, with route
 * groups, parallel slots and private folders removed and each dynamic segment filled with a placeholder. Requested a
 * few at a time, they let `next dev` compile the whole app in a handful of batched compilations (measured: 293 entries
 * in 16 compilations) instead of one compilation per route in the middle of whichever test first visits it — a compile
 * that, with every route kept, carries every entry already compiled (8.8 s for one route, observed mid-battery).
 * @param {string[]} files paths relative to src/app
 */
export function appEntryUrls(files) {
  const urls = new Set();
  for (const file of files) {
    const match = /^(?:(.*)\/)?(?:page|route)\.(?:tsx|ts|jsx|js)$/.exec(String(file).replaceAll('\\', '/'));
    if (!match) continue;
    const segments = (match[1] ?? '').split('/').filter(Boolean);
    if (segments.some((segment) => segment.startsWith('_'))) continue;
    const kept = segments.filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith('@'));
    urls.add('/' + kept.map((segment) => (segment.startsWith('[') ? 'warmup' : segment)).join('/'));
  }
  return [...urls].sort();
}

/**
 * Next's own entries a battery reaches without any file under src/app: the not-found page (compiled on the first
 * missing URL) and the pages-router error page (compiled when a request fails or is aborted). Observed compiling
 * mid-battery at 11–16 s each, with a 28 s readback beside the second; requested with the rest so neither happens.
 */
export const NEXT_BUILTIN_ENTRY_URLS = Object.freeze(['/__e2e-order-precompile-not-found', '/_error']);

/** Worker restarts Next reported itself (its 80 % heap threshold), from the retained server log. */
export function workerRestarts(log) {
  return String(log).split('\n').filter((line) => line.includes('Server is approaching the used memory threshold')).length;
}

/**
 * The development server's own memory samples (scripts/e2e-dev-memory-probe.mjs) from its retained log. A window's
 * event-loop delay and major-collection pauses are carried when the probe reported them; `heapAfterMajorGcMiB`
 * approximates the retained heap, which `heapUsedMiB` alone cannot separate from uncollected garbage.
 */
export function memorySamples(log) {
  const out = [];
  const mib = (bytes) => (typeof bytes === 'number' ? Math.round(bytes / 1048576) : null);
  for (const line of String(log).split('\n')) {
    const at = line.indexOf('{"check":"e2e_next_dev_memory"');
    if (at < 0) continue;
    const stamp = /^\[([^\]]+)\]/.exec(line.slice(0, at).trim())?.[1] ?? null;
    try {
      const sample = JSON.parse(line.slice(at));
      out.push({
        at: stamp, event: sample.event, pid: sample.pid, heapUsedMiB: mib(sample.heapUsedBytes),
        heapLimitMiB: mib(sample.heapLimitBytes), rssMiB: mib(sample.rssBytes),
        ...(typeof sample.loopDelayMaxMs === 'number' && typeof sample.gcMajorCount === 'number' ? {
          eventLoopDelayMaxMs: Math.round(sample.loopDelayMaxMs), gcMajorCount: sample.gcMajorCount,
          gcMajorPauseMaxMs: sample.gcMajorPauseMaxMs, heapAfterMajorGcMiB: mib(sample.heapAfterMajorGcBytes),
        } : {}),
      });
    } catch { /* a truncated line is not a sample */ }
  }
  return out;
}
