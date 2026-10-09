import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { ADOPTED_INVENTORY_UPGRADE, type AdoptedInventoryUpgradeResult, type runAdoptedInventorySchemaUpgrade } from './adopted-plan-inventory-schema-upgrade';
import { executeAdoptedInventoryUpgradeCommand } from './adopted-plan-inventory-upgrade-command';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
const migrations: ClinicalCoreMigration[] = a.manifest.migrations.map((m: { version: string; file: string }) => ({
  version: m.version, name: m.file.slice(15, -4), sql: a.files[m.file], sha256: sha(a.files[m.file]),
}));
const caller = { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/FictionalOperator/session' };
const outputs = { PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled', DatabaseName: 'clinical_core_qualification',
  DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' };
const foundation = { StackStatus: 'CREATE_COMPLETE', StackId: 'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/fictional',
  Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
const build = { sourceCommit: '1'.repeat(40), clean: true }, confirm = '--confirm-fictional-adopted-inventory-upgrade';
const result = (command: 'inspect' | 'rehearse' | 'upgrade'): AdoptedInventoryUpgradeResult => ({
  contract: 'adopted-plan-inventory-schema-upgrade/1', command, execution: 'qualification', phiAllowed: false, activation: 'blocked',
  observedMigrationCount: command === 'upgrade' ? 107 : 106, applied: command === 'upgrade', alreadyApplied: false, rolledBack: command === 'rehearse',
  dataPreserved: true, historicalSchemaPreserved: true, tableCount: 209, rowCount: 3, dataSha256: 'a'.repeat(64), historicalSchemaSha256: 'b'.repeat(64),
  fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to,
});
function fixture() {
  const database: ClinicalCoreDatabase = { transaction: async () => { throw Error('fictional transport is not hosted SQL evidence'); } };
  return {
    observeCaller: vi.fn(() => caller), observeFoundation: vi.fn(() => ({ Stacks: [foundation] })),
    loadMigrations: vi.fn(() => migrations.map(m => ({ ...m }))), createDatabase: vi.fn(() => database),
    run: vi.fn<typeof runAdoptedInventorySchemaUpgrade>(async (_db, _m, _c, command) => result(command)),
  };
}
describe('fixed synthetic inventory operator admission, fictional observations only', () => {
  it('refuses overrides, missing confirmation and dirty writes before any AWS observation', async () => {
    for (const args of [[], ['apply'], ['inspect', confirm], ['upgrade'], ['rehearse'], ['upgrade', confirm, '--skip-rehearsal'],
      ['inspect', '--profile=other'], ['upgrade', '--yes'], ['inspect', '--database=clinical_core']]) {
      const d = fixture(); await expect(executeAdoptedInventoryUpgradeCommand(args, build, d)).rejects.toThrow('boundary_refused');
      expect(d.observeCaller).not.toHaveBeenCalled();
    }
    const d = fixture(); await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], { ...build, clean: false }, d)).rejects.toThrow();
    expect(d.observeCaller).not.toHaveBeenCalled();
  });
  it('allows labeled dirty read-only inspection, not a clean-release claim', async () => {
    const d = fixture();
    expect(await executeAdoptedInventoryUpgradeCommand(['inspect'], { ...build, clean: false }, d)).toMatchObject({ operatorSource: { clean: false }, rehearsal: null });
    expect(d.run).toHaveBeenCalledTimes(1);
  });
  it('rejects root, production, staging, incomplete stack and cross-account secrets before creating a data client', async () => {
    for (const bad of [{ ...caller, Account: '173535830222' }, { ...caller, Arn: 'arn:aws:iam::588966314750:root' }]) {
      const d = fixture(); d.observeCaller.mockReturnValue(bad);
      await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow(); expect(d.createDatabase).not.toHaveBeenCalled();
    }
    for (const bad of [{ ...foundation, StackStatus: 'UPDATE_IN_PROGRESS' },
      ...[['DatabaseName', 'clinical_core'], ['PhiAllowed', 'true'], ['Activation', 'approved'],
        ['DatabaseSecretArn', 'arn:aws:secretsmanager:us-east-2:173535830222:secret:production']].map(([key, value]) => ({
          ...foundation, Outputs: foundation.Outputs.map(o => o.OutputKey === key ? { ...o, OutputValue: value } : o),
        }))]) {
      const d = fixture(); d.observeFoundation.mockReturnValue({ Stacks: [bad] });
      await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow(); expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('refuses a rehashed mutated parent or extension before opening a data client', async () => {
    for (const bad of [migrations.slice(0, 106), migrations.map((m, i) => i === 0 || i === 106
      ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m)]) {
      const d = fixture(); d.loadMigrations.mockReturnValue(bad);
      await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('artifact_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('rehearses and reobserves before passing the exact prestate admission to one upgrade attempt', async () => {
    const d = fixture(); const receipt = await executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d);
    expect(d.observeCaller).toHaveBeenCalledTimes(2); expect(d.observeFoundation).toHaveBeenCalledTimes(2);
    expect(d.run.mock.calls.map(c => c[3])).toEqual(['rehearse', 'upgrade']);
    expect(d.run.mock.calls[1][4]).toEqual({ observedMigrationCount: 106, rowCount: 3, dataSha256: 'a'.repeat(64), historicalSchemaSha256: 'b'.repeat(64) });
    expect(receipt).toMatchObject({ applied: true, rehearsal: { rolledBack: true }, phiAllowed: false, operatorScope: 'prepared_qualification_only' });
    expect(JSON.stringify(receipt)).not.toContain('DatabaseSecretArn');
  });
  it('refuses a changed principal or foundation after rehearsal without admitting a write', async () => {
    for (const changed of ['principal', 'cluster']) {
      const d = fixture();
      if (changed === 'principal') d.observeCaller.mockReturnValueOnce(caller).mockReturnValue({ ...caller, Arn: caller.Arn + '-other' });
      else d.observeFoundation.mockReturnValueOnce({ Stacks: [foundation] }).mockReturnValue({ Stacks: [{ ...foundation,
        Outputs: foundation.Outputs.map(o => o.OutputKey === 'DatabaseClusterArn' ? { ...o, OutputValue: o.OutputValue + '-other' } : o) }] });
      await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('boundary_refused');
      expect(d.run.mock.calls.map(c => c[3])).toEqual(['rehearse']);
    }
  });
  it('refuses a false preservation or rollback report before admitting a write', async () => {
    for (const change of [{ rolledBack: false }, { historicalSchemaPreserved: false }, { dataPreserved: false }, { phiAllowed: true },
      { observedMigrationCount: 105 }, { observedMigrationCount: 107 }, { alreadyApplied: true },
      { tableCount: 208 }, { historicalSchemaSha256: 'invalid' }]) {
      const d = fixture(); d.run.mockImplementation(async (_db, _m, _c, command) => ({ ...result(command), ...change }) as AdoptedInventoryUpgradeResult);
      await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('verification_failed');
      expect(d.run.mock.calls.map(c => c[3])).toEqual(['rehearse']);
    }
  });
  it('rejects a syntactically valid successor report that contradicts the actual rehearsal', async () => {
    for (const change of [{ rowCount: 4 }, { dataSha256: 'c'.repeat(64) },
      { historicalSchemaSha256: 'd'.repeat(64) }, { alreadyApplied: true, applied: false }]) {
      const d = fixture(); d.run.mockImplementation(async (_db, _m, _c, command) =>
        ({ ...result(command), ...(command === 'upgrade' ? change : {}) }) as AdoptedInventoryUpgradeResult);
      await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('verification_failed');
      expect(d.run.mock.calls.map(c => c[3])).toEqual(['rehearse', 'upgrade']);
    }
  });
  it('accepts a validated already-applied inspection and rehearsed no-write replay', async () => {
    const d = fixture(); d.run.mockImplementation(async (_db, _m, _c, command) => ({
      ...result(command), observedMigrationCount: 107, alreadyApplied: true, applied: false,
    }));
    expect(await executeAdoptedInventoryUpgradeCommand(['inspect'], build, d)).toMatchObject({ alreadyApplied: true, applied: false });
    expect(await executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).toMatchObject({ alreadyApplied: true, applied: false });
  });
  it('never retries a write after an uncertain provider response', async () => {
    const d = fixture(); d.run.mockImplementation(async (_db, _m, _c, command) => {
      if (command === 'upgrade') throw Error('fictional lost commit response');
      return result(command);
    });
    await expect(executeAdoptedInventoryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('fictional lost commit response');
    expect(d.run.mock.calls.map(c => c[3])).toEqual(['rehearse', 'upgrade']);
  });
});
