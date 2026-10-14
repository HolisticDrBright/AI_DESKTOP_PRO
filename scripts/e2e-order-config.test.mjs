import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync as write } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SEPARATELY_CONFIGURED_SPECS, compareOrders, fixturePostureFromProbe, memorySamples, orderBatteryEnvironment, selectOrderBattery,
  summarizeReport, testTimeline,
} from './e2e-order-config.mjs';

const options = { stubBase: 'http://127.0.0.1:3999', port: 3114 };

test('the battery runs every spec; the separately configured ones are named with their CI job, and an unclassified spec is an error', () => {
  const specs = readdirSync('e2e').filter(file => file.endsWith('.spec.ts'));
  const { run, separatelyConfigured, unclassified } = selectOrderBattery(specs);
  assert.deepEqual(unclassified, []);
  assert.deepEqual(run, [...specs].sort());
  assert.ok(separatelyConfigured.length > 0 && separatelyConfigured.every(({ spec }) => !spec.startsWith('live-')));
  for (const { spec, reason } of separatelyConfigured) assert.equal(reason, SEPARATELY_CONFIGURED_SPECS[spec]);
  assert.deepEqual(selectOrderBattery([...specs, 'new-feature.spec.ts']).unclassified, ['new-feature.spec.ts']);
});

test('the environment runs the development server with the fixture, pins the fictional targets and credentials, and refuses anything else', () => {
  const result = orderBatteryEnvironment({}, options);
  assert.ok('env' in result);
  assert.equal(result.env.E2E_DEV_SERVER, '1');
  assert.equal(result.env.CLINICAL_CONTRACT_FIXTURE, '1');
  assert.equal(result.env.E2E_DEV_HEAP_MB, '10240');
  assert.equal(result.env.CLINICAL_SUPABASE_URL, 'http://127.0.0.1:3999');
  assert.equal(result.env.CLINICAL_SUPABASE_ANON_KEY, 'stub');
  assert.equal(result.env.NODE_ENV, undefined);
  // An explicit value is never silently redirected: a non-fictional one is refused, the documented one accepted.
  assert.ok('env' in orderBatteryEnvironment({ CLINICAL_ORG_ID: 'org-fixture', CLINICAL_SUPABASE_ANON_KEY: 'stub' }, options));
  for (const [env, pattern] of [
    [{ NODE_ENV: 'production' }, /development browser server/],
    [{ CLINICAL_CONTRACT_FIXTURE: '0' }, /development browser server/],
    [{ E2E_DEV_SERVER: '0' }, /development browser server/],
    [{ E2E_LIVE: '0' }, /development browser server/],
    [{ APP_EDITION: 'demo' }, /clinical edition/],
    [{ CLINICAL_SUPABASE_URL: 'https://urcjiehlxoehievobezf.supabase.co' }, /CLINICAL_SUPABASE_URL/],
    [{ CLINICAL_SUPABASE_URL: 'http://10.0.0.5:3999' }, /CLINICAL_SUPABASE_URL/],
    [{ CLINICAL_SUPABASE_URL: 'http://localhost:3999' }, /CLINICAL_SUPABASE_URL/],
    [{ CLINICAL_SUPABASE_ANON_KEY: 'a'.repeat(46) }, /CLINICAL_SUPABASE_ANON_KEY/],
    [{ CLINICAL_ORG_ID: 'org-other' }, /CLINICAL_ORG_ID/],
    [{ TRPC_BASE_URL: 'https://example.com/api/trpc' }, /TRPC_BASE_URL/],
  ]) {
    const refused = orderBatteryEnvironment(env, options);
    assert.ok('refusal' in refused, JSON.stringify(env));
    assert.match(refused.refusal, pattern);
  }
  for (const stubBase of ['https://example.com', 'http://user:pass@127.0.0.1:3999', 'http://127.0.0.1:3999/path', 'not a url']) {
    const refused = orderBatteryEnvironment({}, { ...options, stubBase });
    assert.ok('refusal' in refused, stubBase);
    assert.match(refused.refusal, /loopback HTTP fixture origin/);
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
  // Playwright is never a synchronous child (it would stop this process draining the server's pipes), and one
  // development server carries both orders.
  assert.match(driver, /spawn\(process\.execPath, \[PLAYWRIGHT_ENTRY, "test"/);
  assert.doesNotMatch(driver, /execFileSync\(\s*process\.execPath,\s*\[PLAYWRIGHT_ENTRY/);
  assert.match(driver, /withStub\(async \(\) => withApp\(heap, async \(\) => \{/);
  assert.doesNotMatch(driver, /NEXT_ENTRY, "start"/);
  assert.doesNotMatch(driver, /NODE_ENV\s*[:=]/);
  assert.match(driver, /orderBatteryEnvironment\(/);
  assert.match(driver, /fixturePostureFromProbe\(/);
  assert.match(driver, /summarizeReport\(/);
  assert.match(driver, /compareOrders\(/);
  const boundary = readFileSync('src/server/runtime/contractFixture.ts', 'utf8');
  assert.match(boundary, /const posture = detectDeploymentPosture\(\);\n  if \(posture\.isDeployed\) \{/);
  assert.match(boundary, /refusal: "deployed_runtime"/);
  // The production bundle is still built, with the fixture disabled.
  assert.match(driver, /CLINICAL_CONTRACT_FIXTURE: "", E2E_DEV_SERVER: "0"/);
  const config = readFileSync('playwright.config.ts', 'utf8');
  assert.match(config, /reuseExistingServer: reuseExistingE2EServer\(\)/);
  assert.match(driver, /E2E_ORDER_OWNED_SERVER: "1"/);
});

test('the timeline and memory samples are read from the report and the retained server log', () => {
  assert.deepEqual(testTimeline({ suites: [{ title: 'live-a.spec.ts', specs: [
    { title: 'later', file: 'live-a.spec.ts', line: 9, tests: [{ status: 'expected', results: [{ status: 'passed', startTime: '2026-10-14T00:00:05.000Z', duration: 1200 }] }] },
    { title: 'earlier', file: 'live-a.spec.ts', line: 3, tests: [{ status: 'skipped', results: [] }] },
  ] }] }), [
    { id: 'live-a.spec.ts:9 › later', status: 'passed', startTime: '2026-10-14T00:00:05.000Z', durationMs: 1200 },
    { id: 'live-a.spec.ts:3 › earlier', status: 'did_not_run', startTime: null, durationMs: null },
  ].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))));
  const log = [
    '[2026-10-14T00:00:01.000Z] [forward order] ○ Compiling /login ...',
    '[2026-10-14T00:00:31.000Z] [forward order] {"check":"e2e_next_dev_memory","event":"sample","pid":7,"heapUsedBytes":1048576000,"heapLimitBytes":9663676416,"rssBytes":2097152000}',
    '[2026-10-14T00:00:32.000Z] [forward order] {"check":"e2e_next_dev_memory","event":"sample"',
  ].join('\n');
  assert.deepEqual(memorySamples(log), [{ at: '2026-10-14T00:00:31.000Z] [forward order', event: 'sample', pid: 7, heapUsedMiB: 1000, heapLimitMiB: 9216, rssMiB: 2000 }]);
});

// The mechanism the repair removes, reproduced without Next: a server that logs every request to a pipe its parent
// owns, with its stdout in BLOCKING mode — exactly what Next does when it loads its SWC bindings
// (node_modules/next/dist/build/swc/index.js sets process.stdout/stderr._handle.setBlocking(true)). While the parent
// waits in a SYNCHRONOUS child, nothing drains the pipe and the server stops mid-write; with an asynchronous child the
// parent keeps draining and every request is answered.
test('a synchronous child stalls a chatty piped server; an asynchronous one does not (the order runner stall)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-order-pipe-'));
  write(join(dir, 'server.mjs'), `import { createServer } from 'node:http';
process.stdout._handle?.setBlocking?.(true);
const line = 'x'.repeat(2048);
createServer((q, r) => { process.stdout.write('GET ' + q.url + ' ' + line + '\\n'); r.end('ok'); }).listen(0, '127.0.0.1', function () { process.stderr.write('PORT ' + this.address().port + '\\n'); });`);
  write(join(dir, 'client.mjs'), `const port = process.argv[2]; let answered = 0;
for (let i = 0; i < 400; i += 1) { try { await (await fetch('http://127.0.0.1:' + port + '/' + i, { signal: AbortSignal.timeout(2000) })).text(); answered += 1; } catch { break; } }
console.log(answered);`);
  const attempt = async (synchronous) => {
    const server = spawn(process.execPath, [join(dir, 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    const port = await new Promise((resolve) => server.stderr.on('data', (b) => { const m = /PORT (\d+)/.exec(String(b)); if (m) resolve(m[1]); }));
    try {
      if (synchronous) return Number(execFileSync(process.execPath, [join(dir, 'client.mjs'), port], { encoding: 'utf8' }).trim());
      return await new Promise((resolve) => { const c = spawn(process.execPath, [join(dir, 'client.mjs'), port]); let o = '';
        c.stdout.on('data', (b) => { o += b; }); c.on('close', () => resolve(Number(o.trim()))); });
    } finally { server.kill('SIGKILL'); }
  };
  const stalled = await attempt(true);
  const drained = await attempt(false);
  assert.ok(stalled < 400, `synchronous child: the server answered all ${stalled} requests`);
  assert.equal(drained, 400);
});
