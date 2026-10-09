import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ source: vi.fn(), build: vi.fn() }));
vi.mock('../../../scripts/inventory-qualification-source.mjs', () => ({ inventorySourceIdentity: state.source }));
vi.mock('node:child_process', () => ({ execFileSync: state.build }));
import { checkInventoryQualificationConfiguration } from './inventory-qualification-configuration';
afterEach(() => { vi.clearAllMocks(); });

for (const args of [[], ['--activate'], ['--check-configuration'], ['--check-configuration', '--target='],
  ['--check-configuration', '--target=test.json', '--deploy'], ['--deploy', '--target=test.json']]) {
  it(`refuses unsupported command ${JSON.stringify(args)} before inspection or building`, () => {
    expect(() => checkInventoryQualificationConfiguration(args)).toThrow('argument_refused');
    expect(state.source).not.toHaveBeenCalled(); expect(state.build).not.toHaveBeenCalled();
  });
}
it('actual dirty-source observation refuses before reading caller configuration or building', () => {
  state.source.mockReturnValue({ sourceCommit: 'a'.repeat(40), sourceInputSha256: 'b'.repeat(64), sourceClean: false });
  expect(() => checkInventoryQualificationConfiguration(['--check-configuration', '--target=nonexistent.json'])).toThrow('dirty_source_refused');
  expect(state.build).not.toHaveBeenCalled();
});
it('a missing target cannot be replaced with a builder default', () => {
  state.source.mockReturnValue({ sourceCommit: 'a'.repeat(40), sourceInputSha256: 'b'.repeat(64), sourceClean: true });
  const directory = mkdtempSync(join(tmpdir(), 'alp-config-unit-'));
  try { expect(() => checkInventoryQualificationConfiguration(['--check-configuration', `--target=${join(directory, 'missing.json')}`])).toThrow(); }
  finally { rmdirSync(directory); }
  expect(state.build).not.toHaveBeenCalled();
});
it('build failure is not a successful configuration report and cleans its own created directory', () => {
  state.source.mockReturnValue({ sourceCommit: 'a'.repeat(40), sourceInputSha256: 'b'.repeat(64), sourceClean: true });
  state.build.mockImplementation(() => { throw Error('fictional_builder_failure'); });
  const directory = mkdtempSync(join(tmpdir(), 'alp-config-unit-'));
  try {
    const file = join(directory, 'target.json'); writeFileSync(file, '{}');
    expect(() => checkInventoryQualificationConfiguration(['--check-configuration', `--target=${file}`])).toThrow('fictional_builder_failure');
    const args = state.build.mock.calls[0][1] as string[];
    expect(args[0]).toBe('scripts/build-inventory-qualification-fleet.mjs');
    expect(args[1]).toMatch(/^--out-dir=/);
    expect(existsSync(args[1].slice(10))).toBe(false);
  } finally { unlinkSync(join(directory, 'target.json')); rmdirSync(directory); }
});
