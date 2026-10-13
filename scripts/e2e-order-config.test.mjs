import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  SEPARATELY_CONFIGURED_SPECS, compareOrders, fixturePostureFromProbe, orderBatteryEnvironment, selectOrderBattery, summarizeReport,
} from './e2e-order-config.mjs';

const options = { stubBase: 'http://127.0.0.1:3999', port: 3114 };

test('the battery is the live- set, every other spec is excluded by name with its own CI job, and an unclassified spec is an error', () => {
  const specs = readdirSync('e2e').filter(file => file.endsWith('.spec.ts'));
  const { run, excluded, unclassified } = selectOrderBattery(specs);
  assert.deepEqual(unclassified, []);
  assert.ok(run.length >= 25 && run.every(file => file.startsWith('live-')));
  assert.equal(run.length + excluded.length, specs.length);
  for (const { spec, reason } of excluded) assert.equal(reason, SEPARATELY_CONFIGURED_SPECS[spec]);
  assert.deepEqual(selectOrderBattery([...specs, 'new-feature.spec.ts']).unclassified, ['new-feature.spec.ts']);
});

test('the environment runs the development server with the fixture, and refuses what would make the battery a different claim', () => {
  const result = orderBatteryEnvironment({}, options);
  assert.ok('env' in result);
  assert.equal(result.env.E2E_DEV_SERVER, '1');
  assert.equal(result.env.CLINICAL_CONTRACT_FIXTURE, '1');
  assert.equal(result.env.E2E_ORDER_OWNS_SERVER, '1');
  assert.equal(result.env.CLINICAL_SUPABASE_URL, 'http://127.0.0.1:3999');
  assert.equal(result.env.NODE_ENV, undefined);
  // An operator's explicit loopback values win.
  const explicit = orderBatteryEnvironment({ CLINICAL_ORG_ID: 'org-other', CLINICAL_SUPABASE_URL: 'http://localhost:3999' }, options);
  assert.equal(explicit.env.CLINICAL_ORG_ID, 'org-other');
  for (const [env, pattern] of [
    [{ NODE_ENV: 'production' }, /NODE_ENV=production/],
    [{ CLINICAL_CONTRACT_FIXTURE: '0' }, /CLINICAL_CONTRACT_FIXTURE/],
    [{ E2E_DEV_SERVER: '0' }, /E2E_DEV_SERVER/],
    [{ APP_EDITION: 'demo' }, /clinical edition/],
    [{ CLINICAL_SUPABASE_URL: 'https://urcjiehlxoehievobezf.supabase.co' }, /not a loopback/],
    [{ CLINICAL_SUPABASE_URL: 'http://10.0.0.5:3999' }, /not a loopback/],
  ]) {
    const refused = orderBatteryEnvironment(env, options);
    assert.ok('refusal' in refused, JSON.stringify(env));
    assert.match(refused.refusal, pattern);
  }
});

test('the fixture posture is observed from an existing response: a rendered page is allowed, a redirect to sign-in is refused', () => {
  assert.deepEqual(fixturePostureFromProbe({ status: 200, location: null }), { allowed: true });
  assert.equal(fixturePostureFromProbe({ status: 307, location: '/login?next=%2Ftoday' }).allowed, false);
  assert.match(fixturePostureFromProbe({ status: 307, location: '/login' }).detail, /refused the contract fixture/);
  assert.match(fixturePostureFromProbe({ status: 500, location: null }).detail, /could not be observed/);
});

// The shape Playwright's JSON reporter actually emits (captured from a throwaway run): a declared skip carries a
// `skip` annotation; a test that a failed beforeAll never ran is `skipped` with no annotation at all.
const report = (overrides = {}) => ({
  suites: [
    { title: 'live-a.spec.ts', file: 'live-a.spec.ts', specs: [], suites: [{ title: 'group', file: 'live-a.spec.ts', specs: [
      { title: 'passes', file: 'live-a.spec.ts', line: 3, tests: [{ status: 'expected', annotations: [], results: [{ status: 'passed', annotations: [] }] }] },
      { title: 'covered elsewhere', file: 'live-a.spec.ts', line: 5, tests: [{ status: 'skipped',
        annotations: [{ type: 'skip', description: 'covered by the default-env CI job' }], results: [{ status: 'skipped', annotations: [] }] }] },
    ] }] },
    { title: 'live-b.spec.ts', file: 'live-b.spec.ts', specs: [
      { title: 'first', file: 'live-b.spec.ts', line: 4, tests: [{ status: overrides.firstStatus ?? 'expected', annotations: [],
        results: [{ status: overrides.firstResult ?? 'passed', annotations: [], ...(overrides.firstResult === 'failed' ? { error: { message: '\u001b[31mError: backend refused\u001b[39m\nstack' } } : {}) }] }] },
      { title: 'second', file: 'live-b.spec.ts', line: 5, tests: [{ status: overrides.secondStatus ?? 'expected', annotations: [],
        results: [{ status: overrides.secondResult ?? 'passed', annotations: [] }] }] },
    ] },
  ],
  errors: overrides.errors ?? [],
});

test('only an expected pass counts; a declared skip keeps its reason and is not a pass; a test a failed hook never ran is a failure', () => {
  const clean = summarizeReport(report());
  assert.deepEqual(clean.passed, ['live-a.spec.ts:3 › group › passes', 'live-b.spec.ts:4 › first', 'live-b.spec.ts:5 › second']);
  assert.deepEqual(clean.skipped, [{ id: 'live-a.spec.ts:5 › group › covered elsewhere', reason: 'covered by the default-env CI job' }]);
  assert.deepEqual(clean.failed, []);
  const hookFailed = summarizeReport(report({ firstStatus: 'unexpected', firstResult: 'failed', secondStatus: 'skipped', secondResult: 'skipped' }));
  assert.deepEqual(hookFailed.passed, ['live-a.spec.ts:3 › group › passes']);
  assert.deepEqual(hookFailed.failed.map(f => [f.id, f.status]), [['live-b.spec.ts:4 › first', 'failed'], ['live-b.spec.ts:5 › second', 'did_not_run']]);
  assert.equal(hookFailed.failed[0].message, 'Error: backend refused stack');
  const flaky = summarizeReport(report({ firstStatus: 'flaky' }));
  assert.equal(flaky.failed.length, 1);
});

test('the verdict compares identities, not totals, and refuses an unexercised or erroring run', () => {
  const clean = summarizeReport(report());
  assert.deepEqual(compareOrders(clean, clean), { ok: true, problems: [], forwardOnly: [], reverseOnly: [] });
  // Same number passing, different tests passing: a leak.
  const swapped = { ...clean, passed: [...clean.passed.slice(0, 2), 'live-c.spec.ts:1 › other'] };
  const leak = compareOrders(clean, swapped);
  assert.equal(leak.ok, false);
  assert.match(leak.problems.join('\n'), /different tests passed in each order \(1 only forward, 1 only reverse\)/);
  const failing = summarizeReport(report({ firstStatus: 'unexpected', firstResult: 'failed', secondStatus: 'skipped', secondResult: 'skipped' }));
  assert.match(compareOrders(failing, clean).problems.join('\n'), /forward order: 2 failed/);
  const empty = { passed: [], failed: [], skipped: [], errors: [] };
  assert.match(compareOrders(empty, empty).problems.join('\n'), /no test passed/);
  const errored = summarizeReport(report({ errors: [{ message: 'Error: Timed out waiting 180000ms from config.webServer.' }] }));
  assert.match(compareOrders(errored, clean).problems.join('\n'), /error\(s\) outside any test: Error: Timed out/);
  const skipDiffers = { ...clean, skipped: [] };
  assert.match(compareOrders(clean, skipDiffers).problems.join('\n'), /different tests were skipped/);
});

test('the driver runs the development server it configured, never `next start`, and the fixture boundary still refuses a deployed runtime', () => {
  const driver = readFileSync('scripts/check-e2e-order-independence.mjs', 'utf8');
  assert.match(driver, /\[NEXT_ENTRY, "dev", "-p", String\(APP_PORT\)\]/);
  assert.doesNotMatch(driver, /NEXT_ENTRY, "start"/);
  assert.doesNotMatch(driver, /NODE_ENV\s*[:=]/);
  assert.match(driver, /orderBatteryEnvironment\(/);
  assert.match(driver, /fixturePostureFromProbe\(/);
  assert.match(driver, /summarizeReport\(/);
  assert.match(driver, /compareOrders\(/);
  const boundary = readFileSync('src/server/runtime/contractFixture.ts', 'utf8');
  assert.match(boundary, /const posture = detectDeploymentPosture\(\);\n  if \(posture\.isDeployed\) \{/);
  assert.match(boundary, /refusal: "deployed_runtime"/);
  const config = readFileSync('playwright.config.ts', 'utf8');
  assert.match(config, /reuseExistingServer: !process\.env\.CI \|\| process\.env\.E2E_ORDER_OWNS_SERVER === "1"/);
});
