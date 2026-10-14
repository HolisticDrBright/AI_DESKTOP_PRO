import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { devServerEnvironment, reuseExistingE2EServer } from '../../../scripts/e2e-dev-resources.mjs';

const GiB = 1024 ** 3;
const memory = { totalBytes: 16 * GiB, constrainedBytes: 0 };
const env = { E2E_DEV_SERVER: '1', E2E_DEV_HEAP_MB: '10240', NODE_ENV: 'development' } as const;

describe('browser-only development resource budget', () => {
  it('reuses only a runner-owned server when CI requires port ownership', () => {
    expect(reuseExistingE2EServer({ CI: 'true', E2E_ORDER_OWNED_SERVER: '1' })).toBe(true);
    expect(reuseExistingE2EServer({ CI: 'true' })).toBe(false);
    expect(reuseExistingE2EServer({})).toBe(true);
  });
  it('leaves ordinary development and production unchanged without explicit opt-in', () => {
    expect(devServerEnvironment({}, memory)).toEqual({});
    expect(devServerEnvironment({ NODE_ENV: 'production' }, memory)).toEqual({});
  });
  it('provisions a bounded heap with a separate OS/browser/native-memory reserve', () => {
    const result = devServerEnvironment(env, memory);
    expect(result.NODE_OPTIONS).toContain('--max-old-space-size=10240');
    expect(result.NODE_OPTIONS).toContain('e2e-dev-preload.mjs');
    expect(result.NODE_OPTIONS.match(/--import=/g)).toHaveLength(1);
    expect(result.E2E_DEV_MEMORY_PROBE).toBe('1');
  });
  it.each(['', '-1', '1.5', 'Infinity', '2047', '12289', '99999999999999999', '2048 --inspect'])('rejects invalid budget %s', (value) => {
    expect(() => devServerEnvironment({ ...env, E2E_DEV_HEAP_MB: value }, memory)).toThrow();
  });
  it('respects constrained container memory instead of trusting host RAM', () => {
    expect(() => devServerEnvironment(env, { totalBytes: 32 * GiB, constrainedBytes: 8 * GiB })).toThrow(/Insufficient/);
    expect(() => devServerEnvironment(env, { totalBytes: 8 * GiB, constrainedBytes: 32 * GiB })).toThrow(/Insufficient/);
    expect(() => devServerEnvironment(env, { totalBytes: 0, constrainedBytes: 0 })).toThrow(/Insufficient/);
  });
  it('does not apply in production or outside the dev harness', () => {
    expect(() => devServerEnvironment({ ...env, NODE_ENV: 'production' }, memory)).toThrow(/only valid/);
    expect(() => devServerEnvironment({ ...env, E2E_DEV_SERVER: '0' }, memory)).toThrow(/only valid/);
  });
  it.each(['--max-old-space-size=4096', '--max_old_space_size 4096', '--max-old-space-size-percentage=70'])('refuses competing operator budget %s', (NODE_OPTIONS) => {
    expect(() => devServerEnvironment({ ...env, NODE_OPTIONS }, memory)).toThrow(/already contains/);
  });
  it('preserves other Node options and loads the probe from paths containing spaces', () => {
    const extra = devServerEnvironment({ ...env, NODE_OPTIONS: '--no-warnings' }, memory);
    expect(extra.NODE_OPTIONS).toContain('--no-warnings');
    const output = execFileSync(process.execPath, ['-e', 'process.stdout.write("ready")'], {
      env: { ...process.env, ...env, ...extra, NEXT_PRIVATE_WORKER: '0' }, encoding: 'utf8',
    });
    expect(output).toBe('ready');
  });
  it('reports real worker exit and memory only, including a restart exit code', () => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('scripts/e2e-dev-memory-probe.mjs')).href, '-e', 'process.exit(77)'], {
      env: { ...process.env, ...env, E2E_DEV_MEMORY_PROBE: '1', NEXT_PRIVATE_WORKER: '1', TEST_SECRET: 'never-log-me' }, encoding: 'utf8',
    });
    expect(result.status).toBe(77);
    const rows = result.stderr.trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((row) => row.event)).toEqual(['start', 'exit']);
    expect(rows[1].exitCode).toBe(77);
    expect(rows[0].heapLimitBytes).toBeGreaterThan(0);
    expect(result.stderr).not.toContain('never-log-me');
    expect(Object.keys(rows[0]).sort()).toEqual(['check', 'event', 'pid', 'heapUsedBytes', 'heapLimitBytes', 'rssBytes', 'totalMemoryBytes', 'constrainedMemoryBytes'].sort());
  });
  it('never emits diagnostics in a production process', () => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('scripts/e2e-dev-memory-probe.mjs')).href, '-e', 'process.exit(0)'], {
      env: { ...process.env, ...env, NODE_ENV: 'production', E2E_DEV_MEMORY_PROBE: '1', NEXT_PRIVATE_WORKER: '1' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

/**
 * The browser harness's development server keeps every route compiled once (next.config.ts), and the order runner
 * compiles every entry before any spec. Nothing else is affected: the setting is absent unless E2E_DEV_SERVER=1, and
 * `next build` / `next start` never read it.
 */
describe('E2E development server keeps compiled routes', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const load = async (flag: string | undefined) => {
    vi.resetModules();
    vi.stubEnv('APP_EDITION', 'clinical');
    vi.stubEnv('E2E_DEV_SERVER', flag);
    return (await import('../../../next.config')).default;
  };
  it('pins compiled routes only for the E2E development server', async () => {
    expect((await load('1')).onDemandEntries).toEqual({ maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 10_000 });
  });
  it('leaves ordinary development and production builds on Next defaults', async () => {
    expect((await load(undefined)).onDemandEntries).toBeUndefined();
    expect((await load('0')).onDemandEntries).toBeUndefined();
  });
});

/**
 * React's development server renderer (bundled by Next 15.5) records every promise created during a render through an
 * async_hooks hook; across the battery that retained memory until Next restarted its own worker. The harness preload
 * leaves only that hook disabled. Fictional modules stand in for the renderer and for an unrelated library: both create
 * a hook of the same shape, and only the one created from the renderer's path is switched off.
 */
describe('React development async-debug hook in the harness server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-react-async-'));
  const rendererDir = join(dir, 'node_modules', 'next', 'dist', 'compiled', 'next-server');
  mkdirSync(rendererDir, { recursive: true });
  const hookModule = `const hooks = require('node:async_hooks'); let count = 0;
module.exports = () => count;
hooks.createHook({ init() { count += 1; }, promiseResolve() {}, destroy() {} }).enable();`;
  writeFileSync(join(rendererDir, 'app-page.runtime.dev.js'), hookModule);
  writeFileSync(join(dir, 'other-library.js'), hookModule);
  writeFileSync(join(dir, 'main.js'), `const renderer = require(${JSON.stringify(join(rendererDir, 'app-page.runtime.dev.js'))});
const other = require(${JSON.stringify(join(dir, 'other-library.js'))});
(async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  process.stdout.write(JSON.stringify({ renderer: renderer(), other: other() })); })();`);
  const preload = pathToFileURL(resolve('scripts/e2e-dev-preload.mjs')).href;
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, ['--import', preload, join(dir, 'main.js')], {
    env: { ...process.env, ...env, NEXT_PRIVATE_WORKER: '1', ...extra }, encoding: 'utf8',
  });
  it('disables only the hook created from the bundled development renderer, and says so once', () => {
    const result = run({});
    expect(result.status).toBe(0);
    const counts = JSON.parse(result.stdout);
    expect(counts.renderer).toBe(0);
    expect(counts.other).toBeGreaterThan(0);
    const notes = result.stderr.split('\n').filter((line) => line.includes('e2e_next_dev_react_async_debug'));
    expect(notes).toHaveLength(1);
    expect(Object.keys(JSON.parse(notes[0])).sort()).toEqual(['check', 'event', 'pid']);
  });
  it('changes nothing outside the harness development server', () => {
    const outside: Record<string, string>[] = [{ NODE_ENV: 'production' }, { E2E_DEV_SERVER: '0' }, { NEXT_PRIVATE_WORKER: '0' }];
    for (const extra of outside) {
      const result = run(extra);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).renderer).toBeGreaterThan(0);
      expect(result.stderr).not.toContain('e2e_next_dev_react_async_debug');
    }
  });
});
