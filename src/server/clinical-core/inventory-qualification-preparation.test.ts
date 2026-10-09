import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = vi.hoisted(() => ({ source: vi.fn(), build: vi.fn(), artifacts: vi.fn(), target: vi.fn() }));
vi.mock('../../../scripts/inventory-qualification-source.mjs', () => ({ inventorySourceIdentity: state.source }));
vi.mock('node:child_process', () => ({ execFileSync: state.build }));
vi.mock('./inventory-qualification-artifacts', async original => ({ ...await original<object>(), readInventoryQualificationArtifacts: state.artifacts }));
vi.mock('./inventory-qualification-target', () => ({ validateInventoryQualificationTarget: state.target }));
import { prepareInventoryQualificationConfiguration } from './inventory-qualification-configuration';
const source = { sourceClean: true, sourceCommit: 'a'.repeat(40), sourceInputSha256: 'b'.repeat(64) };
beforeEach(() => {
  vi.resetAllMocks(); state.source.mockReturnValue(source); state.artifacts.mockReturnValue({ source, candidates: [] });
  state.target.mockReturnValue({ contract: 'fictional-target' });
});
afterEach(() => { vi.clearAllMocks(); });

function withTarget(run: (file: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'alp-preparation-unit-')), file = join(root, 'target.json');
  writeFileSync(file, '{"fictional":true}');
  try { run(file); } finally { unlinkSync(file); rmdirSync(root); }
}
it('returns an owned build only after source, target and rebuilt artifacts are reobserved', () => {
  withTarget(file => {
    const p = prepareInventoryQualificationConfiguration(['--observe-fleet', `--target=${file}`], '--observe-fleet');
    try {
      expect(state.source).toHaveBeenCalledTimes(2); expect(state.artifacts).toHaveBeenCalledTimes(2);
      expect(state.target).toHaveBeenCalledWith({ fictional: true }, { source, candidates: [] });
      p.assertUnchanged(); expect(state.source).toHaveBeenCalledTimes(3); expect(state.artifacts).toHaveBeenCalledTimes(3);
    } finally { p.dispose(); }
    const buildArgs = state.build.mock.calls[0][1] as string[];
    expect(existsSync(buildArgs[1].slice(10))).toBe(false);
  });
});
for (const changed of [{ ...source, sourceClean: false }, { ...source, sourceCommit: 'c'.repeat(40) }, { ...source, sourceInputSha256: 'd'.repeat(64) }])
  it(`refuses source drift during build ${JSON.stringify(changed)}`, () => {
    withTarget(file => {
      state.source.mockReturnValueOnce(source).mockReturnValue(changed);
      expect(() => prepareInventoryQualificationConfiguration(['--observe-fleet', `--target=${file}`], '--observe-fleet')).toThrow('source_or_target_changed');
      const buildArgs = state.build.mock.calls[0][1] as string[]; expect(existsSync(buildArgs[1].slice(10))).toBe(false);
    });
  });
it('refuses target byte changes while live reads are in progress', () => {
  withTarget(file => {
    const p = prepareInventoryQualificationConfiguration(['--observe-fleet', `--target=${file}`], '--observe-fleet');
    try { writeFileSync(file, '{"fictional":false}'); expect(() => p.assertUnchanged()).toThrow('source_or_target_changed'); }
    finally { p.dispose(); }
  });
});
it('refuses fresh artifact readback that changes even with source and target unchanged', () => {
  withTarget(file => {
    const p = prepareInventoryQualificationConfiguration(['--observe-fleet', `--target=${file}`], '--observe-fleet');
    try { state.artifacts.mockReturnValue({ source, candidates: ['changed'] }); expect(() => p.assertUnchanged()).toThrow('artifact_observation_changed'); }
    finally { p.dispose(); }
  });
});
it('refuses source changes after preparation instead of adopting a successor commit', () => {
  withTarget(file => {
    const p = prepareInventoryQualificationConfiguration(['--observe-fleet', `--target=${file}`], '--observe-fleet');
    try { state.source.mockReturnValue({ ...source, sourceCommit: 'e'.repeat(40) }); expect(() => p.assertUnchanged()).toThrow('source_or_target_changed'); }
    finally { p.dispose(); }
  });
});
it('unknown or mismatched modes refuse before source inspection or rebuilding', () => {
  expect(() => prepareInventoryQualificationConfiguration(['--activate', '--target=x.json'], '--activate' as '--observe-fleet')).toThrow('argument_refused');
  expect(() => prepareInventoryQualificationConfiguration(['--check-configuration', '--target=x.json'], '--observe-fleet')).toThrow('argument_refused');
  expect(state.source).not.toHaveBeenCalled(); expect(state.build).not.toHaveBeenCalled();
});
