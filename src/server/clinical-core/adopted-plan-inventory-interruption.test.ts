import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ClinicalCoreDatabase } from './database';
import type { AdoptedInventoryUpgradeDependencies } from './adopted-plan-inventory-upgrade-command';
import { ADOPTED_INVENTORY_UPGRADE, type AdoptedInventoryUpgradeResult, type runAdoptedInventorySchemaUpgrade } from './adopted-plan-inventory-schema-upgrade';
import { runInventoryInterruptionWorker, INVENTORY_INTERRUPTION_CONFIRMATION as confirm } from './adopted-plan-inventory-interruption';
const build = { sourceCommit: '1'.repeat(40), clean: true };
const observation = (mode: 'inspect-settled' | 'upgrade'): AdoptedInventoryUpgradeResult => ({
  contract: 'adopted-plan-inventory-schema-upgrade/1', command: mode, execution: 'qualification', phiAllowed: false, activation: 'blocked',
  observedMigrationCount: mode === 'upgrade' ? 107 : 106, applied: mode === 'upgrade', alreadyApplied: false, rolledBack: false,
  dataPreserved: true, historicalSchemaPreserved: true, tableCount: 209, rowCount: 46, dataSha256: 'a'.repeat(64), historicalSchemaSha256: 'b'.repeat(64),
  fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to,
});
function fixture() {
  let committed = false;
  const database: ClinicalCoreDatabase = { transaction: async work => { const result = await work({ query: async () => { throw Error('not a SQL test'); } }); committed = true; return result; } };
  const run = vi.fn<typeof runAdoptedInventorySchemaUpgrade>(async (db, _m, _c, mode) => mode === 'upgrade'
    ? db.transaction(async () => observation('upgrade')) : observation('inspect-settled'));
  const execute = vi.fn(async (_args, _build, d: AdoptedInventoryUpgradeDependencies) =>
    d.run!(database, [], {} as never, 'upgrade')) as unknown as typeof import('./adopted-plan-inventory-upgrade-command').executeAdoptedInventoryUpgradeCommand;
  const checkpoint = vi.fn(async () => { throw Error('test checkpoint reached'); }) as unknown as (packet: unknown) => Promise<never>;
  return { run, execute, checkpoint, connected: () => true, committed: () => committed };
}
it('before-write reaches only an actual locked inspection, never migration SQL', async () => {
  const ports = fixture();
  await expect(runInventoryInterruptionWorker(['before-write', confirm], build, {} as never, ports)).rejects.toThrow('test checkpoint reached');
  expect(ports.run.mock.calls.map(c => c[3])).toEqual(['inspect-settled']);
  expect(ports.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ mode: 'before-write', observedMigrationCount: 106, transactionCommitAdmitted: false, phiAllowed: false }));
  expect(ports.committed()).toBe(false);
});
it('precommit callback cannot return to the adapter commit after the actual upgrade checks', async () => {
  const ports = fixture();
  await expect(runInventoryInterruptionWorker(['precommit', confirm], build, {} as never, ports)).rejects.toThrow('test checkpoint reached');
  expect(ports.run.mock.calls.map(c => c[3])).toEqual(['upgrade']);
  expect(ports.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ mode: 'precommit', observedMigrationCount: 107, transactionCommitAdmitted: false }));
  expect(ports.committed()).toBe(false);
});
it('refuses an invalid upgrade observation before producing the precommit checkpoint', async () => {
  const ports = fixture(); ports.run.mockImplementation(async db => db.transaction(async () =>
    ({ ...observation('upgrade'), dataPreserved: false }) as unknown as AdoptedInventoryUpgradeResult));
  await expect(runInventoryInterruptionWorker(['precommit', confirm], build, {} as never, ports)).rejects.toThrow('verification_failed');
  expect(ports.checkpoint).not.toHaveBeenCalled(); expect(ports.committed()).toBe(false);
});
it('reconciliation forwards only the existing read-only recovery command', async () => {
  const ports = fixture(); const execute = vi.fn(async () => ({ qualificationOnly: true })) as never;
  await runInventoryInterruptionWorker(['reconcile', confirm], build, {} as never, { ...ports, execute });
  expect(execute).toHaveBeenCalledWith(['reconcile', '--reconcile-fictional-adopted-inventory-upgrade'], build, expect.any(Object));
  expect(ports.run).not.toHaveBeenCalled(); expect(ports.checkpoint).not.toHaveBeenCalled();
});
it('refuses missing confirmations, overrides, dirty builds and non-IPC invocation before AWS or SQL', async () => {
  for (const args of [[], ['upgrade', confirm], ['precommit'], ['precommit', confirm, '--database=clinical_core'], ['before-write', '--yes']]) {
    const ports = fixture(); await expect(runInventoryInterruptionWorker(args, build, {} as never, ports)).rejects.toThrow('boundary_refused');
    expect(ports.execute).not.toHaveBeenCalled();
  }
  for (const changed of [{ build: { ...build, clean: false }, connected: true }, { build, connected: false }]) {
    const ports = fixture(); await expect(runInventoryInterruptionWorker(['precommit', confirm], changed.build, {} as never,
      { ...ports, connected: () => changed.connected })).rejects.toThrow('boundary_refused'); expect(ports.execute).not.toHaveBeenCalled();
  }
});
it('runner refuses invalid arguments before touching local artifacts or AWS', () => {
  for (const args of [[], ['precommit'], ['precommit', confirm, '--root=other']]) {
    expect(() => execFileSync(process.execPath, ['scripts/qualify-adopted-plan-inventory-interruption.mjs', ...args],
      { timeout: 10000, stdio: 'pipe' })).toThrow();
  }
  const source = readFileSync('scripts/qualify-adopted-plan-inventory-interruption.mjs', 'utf8');
  expect(source).toContain('work/DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing');
  expect(source).toContain('writer.child.kill()'); expect(source).toContain('await writer.first');
  expect(source).toContain('postCommitReceiptLossQualified: false');
  expect(source).toContain('result.journalSha256 === sha(journalBytes)');
});
