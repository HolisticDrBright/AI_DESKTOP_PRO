import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ whole: vi.fn(), reads: [] as Array<{ allocation: number; requested: number }>,
  beforeRead: undefined as undefined | (() => void), shortReads: false }));
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  return { ...real,
    readFileSync: (...args: unknown[]) => {
      state.whole(); const hook = state.beforeRead; state.beforeRead = undefined; hook?.();
      const result = Reflect.apply(real.readFileSync, undefined, args);
      if (result instanceof Uint8Array) state.reads.push({ allocation: result.byteLength, requested: result.byteLength });
      return result;
    },
    readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
      state.reads.push({ allocation: buffer.byteLength, requested: length });
      const hook = state.beforeRead; state.beforeRead = undefined; hook?.();
      return real.readSync(fd, buffer, offset, state.shortReads ? Math.min(length, 3) : length, position);
    },
  };
});
import { appendFileSync, existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { createNativeInventoryCustody } from './adopted-plan-inventory-native-custody';
import { ADOPTED_INVENTORY_UPGRADE, type AdoptedInventoryUpgradeResult } from './adopted-plan-inventory-schema-upgrade';
import type { InventoryCustodyBinding } from './adopted-plan-inventory-custody-types';

// Actual files/descriptors with instrumented read lengths. No AWS calls,
// actual shared namespace, database writes or hosted-recovery claim.
const roots: string[] = [];
beforeEach(() => { state.whole.mockClear(); state.reads = []; state.beforeRead = undefined; state.shortReads = false; });
afterEach(() => {
  state.beforeRead = undefined;
  for (const root of roots.splice(0)) {
    expect(dirname(realpathSync(root))).toBe(realpathSync(tmpdir()));
    expect(basename(root)).toMatch(/^alp-custody-read-/); expect(lstatSync(root).isSymbolicLink()).toBe(false);
    rmSync(root, { recursive: true, force: false });
  }
});
const binding: InventoryCustodyBinding = { build: { sourceCommit: '1'.repeat(40), clean: true }, callerSha256: 'c'.repeat(64),
  configuration: { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false, activation: 'blocked',
    clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
    qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
    fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to } };
const baseline: AdoptedInventoryUpgradeResult = { contract: 'adopted-plan-inventory-schema-upgrade/1', command: 'inspect-settled',
  execution: 'qualification', phiAllowed: false, activation: 'blocked', observedMigrationCount: 106, applied: false, alreadyApplied: false,
  rolledBack: false, dataPreserved: true, historicalSchemaPreserved: true, tableCount: 209, rowCount: 3,
  dataSha256: 'a'.repeat(64), historicalSchemaSha256: 'b'.repeat(64), fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alp-custody-read-')); roots.push(root);
  const operatorFile = join(root, 'operator.cjs'), original = '// fictional operator\n'; writeFileSync(operatorFile, original);
  const options = { root, operatorFile, runtime: { pid: process.pid, host: hostname(), now: () => Date.parse('2026-10-09T15:00:00Z') } };
  return { root, operatorFile, original, create: () => createNativeInventoryCustody(options, binding, baseline, { verify: async () => {} }) };
}

it('never uses an unbounded whole-file read for custody or the original operator', async () => {
  const f = fixture(), custody = await f.create(); await custody.verify();
  expect(state.whole).not.toHaveBeenCalled(); expect(state.reads.length).toBeGreaterThan(0);
});
it('refuses a growing file after reading no more than the originally observed length plus one', async () => {
  const f = fixture(); state.beforeRead = () => appendFileSync(f.operatorFile, 'x'.repeat(1024 * 1024));
  await expect(f.create()).rejects.toMatchObject({ category: 'custody_refused', stage: 'file_changed' });
  expect(state.reads.length).toBeGreaterThan(0);
  expect(state.reads.every(r => r.allocation <= Buffer.byteLength(f.original) + 1 && r.requested <= r.allocation)).toBe(true);
  expect(existsSync(join(f.root, 'operator.lock'))).toBe(false); expect(state.whole).not.toHaveBeenCalled();
});
it('refuses truncation rather than archiving a partial operator', async () => {
  const f = fixture(); state.beforeRead = () => writeFileSync(f.operatorFile, 'x');
  await expect(f.create()).rejects.toMatchObject({ stage: 'file_changed' });
  expect(existsSync(join(f.root, 'operator.lock'))).toBe(false); expect(state.whole).not.toHaveBeenCalled();
});
it('refuses a replaced named file even when the opened descriptor still contains the original bytes', async () => {
  const f = fixture(); state.beforeRead = () => { renameSync(f.operatorFile, f.operatorFile + '.old'); writeFileSync(f.operatorFile, f.original); };
  await expect(f.create()).rejects.toMatchObject({ stage: 'file_changed' });
  expect(existsSync(join(f.root, 'operator.lock'))).toBe(false); expect(state.whole).not.toHaveBeenCalled();
});
it('handles short descriptor reads without confusing them with EOF or skipping bytes', async () => {
  const f = fixture(); state.shortReads = true; const custody = await f.create(); await custody.verify();
  expect(state.reads.length).toBeGreaterThan(10); expect(state.whole).not.toHaveBeenCalled();
});
