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
 * The battery is the `live-` set: the specs that run together under one live-fixture configuration. Every other
 * spec needs a server posture of its own and has its own CI job; running it here could only skip it, and a skip is
 * not a pass. A new spec that is neither `live-` nor listed below is a configuration error, so nothing silently
 * falls out of every battery.
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
  const run = sorted.filter(file => file.startsWith('live-'));
  const excluded = [];
  const unclassified = [];
  for (const file of sorted) {
    if (file.startsWith('live-')) continue;
    if (Object.hasOwn(SEPARATELY_CONFIGURED_SPECS, file)) excluded.push({ spec: file, reason: SEPARATELY_CONFIGURED_SPECS[file] });
    else unclassified.push(file);
  }
  return { run, excluded, unclassified };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The environment for the battery's own dev server and for its Playwright children. An explicitly set value wins,
 * except where the battery cannot be what it claims to be: a production NODE_ENV (the fixture is refused there by
 * design), an opted-out fixture flag, or a backend that is not loopback. Each of those is a refusal naming its fix.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ stubBase: string, port: number }} options
 * @returns {{ env: Record<string, string>, applied: string[] } | { refusal: string, fix: string }}
 */
export function orderBatteryEnvironment(env, { stubBase, port }) {
  if (env.NODE_ENV === 'production') {
    return {
      refusal: 'NODE_ENV=production is set. A production-mode server is a deployed runtime, and the contract fixture is refused there by design.',
      fix: 'Unset NODE_ENV for this battery. Do not weaken the refusal: the battery runs `next dev`, where the fixture is allowed.',
    };
  }
  if (env.CLINICAL_CONTRACT_FIXTURE !== undefined && env.CLINICAL_CONTRACT_FIXTURE !== '' && env.CLINICAL_CONTRACT_FIXTURE !== '1') {
    return { refusal: `CLINICAL_CONTRACT_FIXTURE is "${env.CLINICAL_CONTRACT_FIXTURE}".`, fix: 'Unset it; this battery sets it to 1 for its own server only.' };
  }
  if (env.E2E_DEV_SERVER !== undefined && env.E2E_DEV_SERVER !== '' && env.E2E_DEV_SERVER !== '1') {
    return { refusal: `E2E_DEV_SERVER is "${env.E2E_DEV_SERVER}".`, fix: 'Unset it; this battery always runs the development server.' };
  }
  const defaults = {
    APP_EDITION: 'clinical',
    E2E_LIVE: '1',
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
    return { refusal: `APP_EDITION is "${out.APP_EDITION}", but this battery only runs against the clinical edition.`, fix: 'Unset APP_EDITION or set APP_EDITION=clinical.' };
  }
  let host = '';
  try { host = new URL(out.CLINICAL_SUPABASE_URL).hostname.toLowerCase(); } catch { host = ''; }
  if (!LOOPBACK.has(host)) {
    return { refusal: `CLINICAL_SUPABASE_URL (${out.CLINICAL_SUPABASE_URL}) is not a loopback fixture backend.`, fix: `Unset it; the battery owns its fixture backend at ${stubBase}.` };
  }
  // Always set for the battery's own processes, never exported beyond them.
  for (const [key, value] of [['E2E_DEV_SERVER', '1'], ['CLINICAL_CONTRACT_FIXTURE', '1'], ['E2E_ORDER_OWNS_SERVER', '1']]) {
    if (out[key] !== value) { out[key] = value; applied.push(key); }
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
