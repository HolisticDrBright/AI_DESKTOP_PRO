import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devServerEnvironment } from '../../../scripts/e2e-dev-resources.mjs';

const GiB = 1024 ** 3;
const memory = { totalBytes: 16 * GiB, constrainedBytes: 0 };
const env = { E2E_DEV_SERVER: '1', E2E_DEV_HEAP_MB: '10240', NODE_ENV: 'development' } as const;

describe('browser-only development resource budget', () => {
  it('leaves ordinary development and production unchanged without explicit opt-in', () => {
    expect(devServerEnvironment({}, memory)).toEqual({});
    expect(devServerEnvironment({ NODE_ENV: 'production' }, memory)).toEqual({});
  });
  it('provisions a bounded heap with a separate OS/browser/native-memory reserve', () => {
    const result = devServerEnvironment(env, memory);
    expect(result.NODE_OPTIONS).toContain('--max-old-space-size=10240');
    expect(result.NODE_OPTIONS).toContain('e2e-dev-memory-probe.mjs');
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
