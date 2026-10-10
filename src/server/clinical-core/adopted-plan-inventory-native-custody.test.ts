import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ADOPTED_INVENTORY_UPGRADE, type AdoptedInventoryUpgradeResult } from './adopted-plan-inventory-schema-upgrade';
import { createNativeInventoryCustody, openNativeInventoryRecovery } from './adopted-plan-inventory-native-custody';
import type { InventoryCustodyBinding } from './adopted-plan-inventory-custody-types';

// Real temporary files and stopped child processes; the clock and target are
// fictional. These tests do not certify Windows power-loss or hosted AWS locks.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const binding: InventoryCustodyBinding = { build: { sourceCommit: '1'.repeat(40), clean: true }, callerSha256: 'c'.repeat(64),
  configuration: { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false, activation: 'blocked',
    clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
    qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
    fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to } };
const observed = (command: AdoptedInventoryUpgradeResult['command'], successor = false): AdoptedInventoryUpgradeResult => ({
  contract: 'adopted-plan-inventory-schema-upgrade/1', command, execution: 'qualification', phiAllowed: false, activation: 'blocked',
  observedMigrationCount: successor ? 107 : 106, applied: command === 'upgrade', alreadyApplied: successor && command !== 'upgrade',
  rolledBack: command === 'rehearse', dataPreserved: true, historicalSchemaPreserved: true, tableCount: 209, rowCount: 3,
  dataSha256: 'a'.repeat(64), historicalSchemaSha256: 'b'.repeat(64), fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to });
function fixture(live = false) {
  const root = mkdtempSync(join(tmpdir(), 'alp-inventory-custody-')); roots.push(root);
  const operatorFile = join(root, 'operator.cjs'); writeFileSync(operatorFile, '// fictional frozen operator\n');
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.status).toBe(0); expect(child.pid).toBeGreaterThan(0);
  let now = Date.parse('2026-10-09T12:00:00Z');
  const options = { root, operatorFile, runtime: { pid: live ? process.pid : child.pid, host: hostname(), now: () => now } };
  const fence = { verify: vi.fn(async () => {}) };
  return { root, options, fence, advance: () => { now += 61000; },
    recoveryOptions: { ...options, runtime: { ...options.runtime, pid: process.pid } },
    journal: () => join(root, readdirSync(root).find(f => f.endsWith('.events.jsonl'))!) };
}
describe('native inventory custody: actual files, fictional clock, no AWS claims', () => {
  it('publishes complete archives before the shared lock and refuses a second writer', async () => {
    const f = fixture(); const c = await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
    const h = JSON.parse(readFileSync(join(f.root, 'operator.lock'), 'utf8'));
    expect(readFileSync(join(f.root, h.runId + '.inventory-header.json'))).toEqual(readFileSync(join(f.root, 'operator.lock')));
    expect(existsSync(join(f.root, h.runId + '.inventory.operator.cjs'))).toBe(true);
    await c.verify();
    await expect(createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence)).rejects.toMatchObject({ category: 'custody_refused', stage: 'operator_active' });
  });
  it('never replaces a foreign operator or an orphan reconciliation guard', async () => {
    for (const name of ['operator.lock', 'inventory-upgrade-reconciliation.lock']) {
      const f = fixture(); writeFileSync(join(f.root, name), 'foreign');
      await expect(createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence)).rejects.toThrow('custody_refused');
      expect(readFileSync(join(f.root, name), 'utf8')).toBe('foreign');
    }
  });
  it('retains custody when source, journal or lock bytes change or the database fence fails', async () => {
    for (const kind of ['source', 'journal', 'lock', 'fence']) {
      const f = fixture(); const c = await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
      if (kind === 'fence') f.fence.verify.mockRejectedValue(Error('fence lost'));
      else appendFileSync(kind === 'source' ? f.options.operatorFile : kind === 'journal' ? f.journal() : join(f.root, 'operator.lock'), 'changed');
      await expect(c.verify()).rejects.toThrow(); expect(existsSync(join(f.root, 'operator.lock'))).toBe(true);
    }
  });
  it('requires every durable stage and exact preservation before archiving and retirement', async () => {
    const f = fixture(); const c = await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
    await expect(c.record('write_admitted', observed('rehearse'))).rejects.toMatchObject({ stage: 'journal_order' });
    await expect(c.settle(observed('upgrade', true))).rejects.toMatchObject({ stage: 'settlement' });
    for (const stage of ['rehearsal', 'write_admitted'] as const) await c.record(stage, observed('rehearse'));
    await c.record('write_reply', observed('upgrade', true));
    for (const stage of ['readback_one', 'readback_two'] as const) await c.record(stage, observed('inspect-settled', true));
    const receipt = await c.settle(observed('upgrade', true));
    expect(receipt.custodySettled).toBe(true); expect(existsSync(join(f.root, 'operator.lock'))).toBe(false);
    expect(existsSync(join(f.root, receipt.runId + '.inventory.settled.json'))).toBe(true);
    expect(existsSync(join(f.root, receipt.runId + '.inventory.settled-lock.json'))).toBe(true);
  });
  it('refuses live writers and insufficient settlement time without touching original custody', async () => {
    for (const live of [false, true]) {
      const f = fixture(live); await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
      if (live) f.advance();
      await expect(openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence)).rejects.toMatchObject({ stage: live ? 'writer_identity' : 'writer_settlement' });
      expect(existsSync(join(f.root, 'operator.lock'))).toBe(true);
    }
  });
  it.each([0, 1, 2, 3, 4, 5])('recovers interruption after %i stages without re-admitting a write', async n => {
    const f = fixture(); const c = await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
    const stages = ['rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two'] as const;
    for (const stage of stages.slice(0, n)) await c.record(stage, observed(stage.startsWith('readback') ? 'inspect-settled' : stage === 'write_reply' ? 'upgrade' : 'rehearse', stages.indexOf(stage) >= 2));
    f.advance(); const recovery = await openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence);
    expect(recovery.writeAdmitted).toBe(n >= 2);
    const receipt = await recovery.settle(observed('inspect-settled', n >= 2));
    expect(receipt.originalWriteOutcome).toBe('unknown');
    expect(existsSync(join(f.root, 'operator.lock'))).toBe(false);
    expect(existsSync(join(f.root, 'inventory-upgrade-reconciliation.lock'))).toBe(false);
    const saved = readdirSync(f.root).find(s => s.endsWith('.inventory.reconciled.json'))!;
    expect(JSON.parse(readFileSync(join(f.root, saved), 'utf8'))).toMatchObject({ retryPerformed: false, databaseMutationPerformed: false, phiAllowed: false });
  });
  it('preserves a torn journal tail, which never grants successor authority', async () => {
    const f = fixture(); await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
    appendFileSync(f.journal(), '{"stage":"write_admitted"'); const original = readFileSync(f.journal()); f.advance();
    const r = await openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence);
    await expect(r.settle(observed('inspect-settled', true))).rejects.toMatchObject({ stage: 'unadmitted_successor' });
    await r.settle(observed('inspect-settled'));
    expect(readFileSync(f.journal())).toEqual(original);
  });
  it('archives a finding without replaying the uncertain write', async () => {
    const f = fixture(); const c = await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence);
    await c.record('rehearsal', observed('rehearse')); await c.record('write_admitted', observed('rehearse')); await c.finding();
    await expect(c.record('write_reply', observed('upgrade', true))).rejects.toMatchObject({ stage: 'journal_terminal' });
    f.advance(); const r = await openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence);
    expect(r.writeAdmitted).toBe(true); await r.settle(observed('inspect-settled', true));
    expect(readFileSync(f.journal(), 'utf8')).toContain('"stage":"finding"');
  });
  it('refuses a live recovery guard and retires only an exact stopped guard with its archive', async () => {
    const f = fixture(); await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence); f.advance();
    await openNativeInventoryRecovery(f.options, binding, f.fence);
    const old = readFileSync(join(f.root, 'inventory-upgrade-reconciliation.lock')); const h = JSON.parse(old.toString());
    f.advance(); const r = await openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence);
    expect(readFileSync(join(f.root, h.id + '.inventory.abandoned-reconciliation-guard.json'))).toEqual(old);
    f.advance();
    await expect(openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence)).rejects.toMatchObject({ stage: 'writer_identity' });
    await r.settle(observed('inspect-settled'));
  });
  it.each(['source', 'configuration', 'journal', 'guard'])('refuses changed recovery %s while retaining custody', async kind => {
    const f = fixture(); await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence); f.advance();
    if (kind === 'source') appendFileSync(f.options.operatorFile, 'changed');
    if (kind === 'journal') appendFileSync(f.journal(), '{}\n');
    if (kind === 'guard') writeFileSync(join(f.root, 'inventory-upgrade-reconciliation.lock'), '{}\n');
    const changed = kind === 'configuration' ? { ...binding, configuration: { ...binding.configuration, clusterArn: binding.configuration.clusterArn + '-other' } } : binding;
    await expect(openNativeInventoryRecovery(f.recoveryOptions, changed, f.fence)).rejects.toThrow();
    expect(existsSync(join(f.root, 'operator.lock'))).toBe(true);
  });
  it('keeps the original lock recoverable if the fence fails after subsidiary guard retirement', async () => {
    const f = fixture(); await createNativeInventoryCustody(f.options, binding, observed('inspect-settled'), f.fence); f.advance();
    const r = await openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence);
    f.fence.verify.mockImplementation(async () => {
      if (!existsSync(join(f.root, 'inventory-upgrade-reconciliation.lock'))) throw Error('fence lost after guard retirement');
    });
    await expect(r.settle(observed('inspect-settled'))).rejects.toThrow('fence lost');
    expect(existsSync(join(f.root, 'operator.lock'))).toBe(true);
    expect(existsSync(join(f.root, 'inventory-upgrade-reconciliation.lock'))).toBe(false);
    f.fence.verify.mockImplementation(async () => {});
    const retry = await openNativeInventoryRecovery(f.recoveryOptions, binding, f.fence);
    await retry.settle(observed('inspect-settled'));
    expect(existsSync(join(f.root, 'operator.lock'))).toBe(false);
  });
});
