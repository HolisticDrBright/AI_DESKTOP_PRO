import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { CARE_CLAIM_RECOVERY_UPGRADE, runCareClaimRecoverySchemaUpgrade } from './care-claim-recovery-schema-upgrade';
import { executeCareClaimRecoveryUpgradeCommand } from './care-claim-recovery-upgrade-command';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
const migrations: ClinicalCoreMigration[] = artifact.manifest.migrations.map((m: { version: string; file: string }) => ({
  version: m.version, name: m.file.slice(15, -4), sql: artifact.files[m.file], sha256: sha(artifact.files[m.file]),
}));
const sql = readFileSync('infra/aws-clinical-core/production-candidates/care-claim-recovery.sql', 'utf8').replace(/\r\n?/g, '\n');
expect(migrations[105].sql).toBe(sql);
const build = { sourceCommit: '1'.repeat(40), clean: true };
const confirm = '--confirm-fictional-care-claim-recovery-upgrade';
const caller = { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/FictionalOperator/session' };
const values = { PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled',
  DatabaseName: 'clinical_core_qualification', DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' };
const stack = { StackStatus: 'CREATE_COMPLETE',
  StackId: 'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/fictional',
  Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
const result = (command: 'inspect' | 'rehearse' | 'upgrade'): Awaited<ReturnType<typeof runCareClaimRecoverySchemaUpgrade>> => ({
  contract: 'care-claim-recovery-schema-upgrade/1', command, execution: 'qualification', phiAllowed: false, activation: 'blocked', canonical: true,
  observedMigrationCount: command === 'upgrade' ? 106 : 105, applied: command === 'upgrade', alreadyApplied: false,
  rolledBack: command === 'rehearse', dataPreserved: true, tableCount: command === 'upgrade' ? 209 : 207,
  rowCount: 8, dataSha256: 'a'.repeat(64), fromReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.from, toReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to,
});
function fixture() {
  const db: ClinicalCoreDatabase = { transaction: async () => { throw new Error('fictional transport is not hosted SQL evidence'); } };
  const events: string[] = [];
  const d = {
    observeCaller: vi.fn(() => { events.push('caller'); return caller; }),
    observeFoundation: vi.fn(() => { events.push('foundation'); return { Stacks: [stack] }; }),
    loadMigrations: vi.fn(() => { events.push('artifact'); return migrations.map(m => ({ ...m })); }),
    createDatabase: vi.fn(() => { events.push('client'); return db; }),
    run: vi.fn<typeof runCareClaimRecoverySchemaUpgrade>(async (_db, _m, _c, command) => {
      events.push(command); return result(command);
    }),
  };
  return { d, events };
}
describe('prepared recovery operator admission (fictional observations, not AWS acceptance)', () => {
  it('refuses argument overrides, missing confirmation and dirty writes before observing AWS', async () => {
    for (const args of [[], ['apply'], ['inspect', confirm], ['upgrade'], ['rehearse'], ['upgrade', '--yes'],
      ['upgrade', confirm, '--skip-rehearsal'], ['inspect', '--database=clinical_core'], ['inspect', '--profile=other']]) {
      const { d } = fixture();
      await expect(executeCareClaimRecoveryUpgradeCommand(args, build, d)).rejects.toThrow('boundary_refused');
      expect(d.observeCaller).not.toHaveBeenCalled();
    }
    const { d } = fixture();
    await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], { ...build, clean: false }, d)).rejects.toThrow();
    expect(d.observeCaller).not.toHaveBeenCalled();
  });
  it('allows dirty read-only inspection without claiming clean release evidence', async () => {
    const { d, events } = fixture();
    expect(await executeCareClaimRecoveryUpgradeCommand(['inspect'], { ...build, clean: false }, d)).toMatchObject({
      canonical: true, operatorSource: { clean: false }, operatorScope: 'prepared_qualification_only', rehearsal: null,
    });
    expect(events).toEqual(['caller', 'foundation', 'artifact', 'client', 'inspect']);
  });
  it('refuses root, production, stale foundation, staging and activated configurations before creating a client', async () => {
    for (const bad of [{ ...caller, Account: '173535830222' }, { ...caller, Arn: 'arn:aws:iam::588966314750:root' }]) {
      const { d } = fixture(); d.observeCaller.mockReturnValue(bad);
      await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow();
      expect(d.createDatabase).not.toHaveBeenCalled();
    }
    for (const bad of [{ ...stack, StackStatus: 'UPDATE_IN_PROGRESS' },
      ...[['PhiAllowed', 'true'], ['Activation', 'approved'], ['DatabaseName', 'clinical_core'],
        ['DatabaseSecretArn', 'arn:aws:secretsmanager:us-east-2:173535830222:secret:production']].map(([key, value]) =>
        ({ ...stack, Outputs: stack.Outputs.map(o => o.OutputKey === key ? { ...o, OutputValue: value } : o) }))]) {
      const { d } = fixture(); d.observeFoundation.mockReturnValue({ Stacks: [bad] });
      await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow();
      expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('refuses a changed prefix, overlay or incomplete artifact before creating a client', async () => {
    for (const bad of [migrations.slice(0, 105), migrations.map((m, i) => i === 0 || i === 105
      ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m)]) {
      const { d } = fixture(); d.loadMigrations.mockReturnValue(bad);
      await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('artifact_refused');
      expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('rehearses, observes AWS again, then upgrades the same target with the same artifact', async () => {
    const { d, events } = fixture();
    const upgraded = await executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, d);
    expect(events).toEqual(['caller', 'foundation', 'artifact', 'client', 'rehearse', 'caller', 'foundation', 'upgrade']);
    expect(d.run.mock.calls[0].slice(0, 3)).toEqual(d.run.mock.calls[1].slice(0, 3));
    expect(upgraded).toMatchObject({ canonical: true, phiAllowed: false, activation: 'blocked',
      rehearsal: { rolledBack: true, rowCount: 8 }, awsAccountId: '588966314750' });
    expect(JSON.stringify(upgraded)).not.toMatch(/secretArn|DatabaseSecretArn|FictionalOperator/);
  });
  it('refuses changed target or caller after rehearsal without starting the upgrade', async () => {
    for (const change of ['cluster', 'secret', 'caller', 'status']) {
      const { d } = fixture();
      if (change === 'caller') d.observeCaller.mockReturnValueOnce(caller).mockReturnValue({ ...caller, Account: '173535830222' });
      else {
        const bad = change === 'status' ? { ...stack, StackStatus: 'UPDATE_IN_PROGRESS' } : { ...stack, Outputs: stack.Outputs.map(o =>
          o.OutputKey === (change === 'cluster' ? 'DatabaseClusterArn' : 'DatabaseSecretArn') ? { ...o, OutputValue: o.OutputValue + '-changed' } : o) };
        d.observeFoundation.mockReturnValueOnce({ Stacks: [stack] }).mockReturnValue({ Stacks: [bad] });
      }
      await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow();
      expect(d.run).toHaveBeenCalledTimes(1);
    }
  });
  it('does not trust a bare rolledBack flag or incomplete/inconsistent rehearsal receipt', async () => {
    for (const change of [{ rolledBack: false }, { dataPreserved: false }, { canonical: false }, { dataSha256: 'not-a-digest' },
      { phiAllowed: true }, { observedMigrationCount: 104 }, { tableCount: 206 }, { applied: true },
      { toReleaseSha256: 'b'.repeat(64) }, { command: 'upgrade' }, { rowCount: -1 }]) {
      const { d } = fixture(); d.run.mockResolvedValueOnce({ ...result('rehearse'), ...change } as ReturnType<typeof result>);
      await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('verification_failed');
      expect(d.run).toHaveBeenCalledTimes(1); expect(d.observeCaller).toHaveBeenCalledTimes(1);
    }
  });
  it('preserves the embedded source/artifact across asynchronous mutation and rejects false final receipts', async () => {
    const { d } = fixture(); const external = { ...build };
    d.run.mockImplementation(async (_db, current, c, command) => {
      current[105].sql += '\nselect 1;'; c.qualificationDatabaseName = 'clinical_core'; external.clean = false;
      return result(command);
    });
    expect(await executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], external, d)).toMatchObject({ operatorSource: build });
    for (const change of [{ observedMigrationCount: 105 }, { applied: false }, { alreadyApplied: true }, { rolledBack: true }, { execution: 'production' }]) {
      const { d: broken } = fixture(); broken.run.mockResolvedValueOnce(result('rehearse'))
        .mockResolvedValueOnce({ ...result('upgrade'), ...change } as ReturnType<typeof result>);
      await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, broken)).rejects.toThrow('verification_failed');
    }
  });
  it('executes only rehearsal when requested and stops on a failed rollback', async () => {
    const { d } = fixture();
    expect(await executeCareClaimRecoveryUpgradeCommand(['rehearse', confirm], build, d)).toMatchObject({ applied: false, rolledBack: true });
    expect(d.run).toHaveBeenCalledTimes(1);
    const broken = fixture(); broken.d.run.mockRejectedValueOnce(new Error('rollback failed'));
    await expect(executeCareClaimRecoveryUpgradeCommand(['upgrade', confirm], build, broken.d)).rejects.toThrow();
    expect(broken.d.run).toHaveBeenCalledTimes(1);
  });
  it('ships a fixed CLI/SDK profile, embedded SQL, single transport attempts and safe output', () => {
    const source = readFileSync('src/server/clinical-core/care-claim-recovery-schema-upgrade-operator.ts', 'utf8');
    expect(source).toContain("'--profile', profile"); expect(source).toContain('fromIni({ profile })');
    expect(source).toContain('maxAttempts: 1'); expect(source).toContain('__CARE_CLAIM_RECOVERY_MIGRATIONS__');
    expect(source).not.toContain('loadClinicalCoreMigrations'); expect(source).not.toContain('process.env.');
    expect(source).not.toContain('console.error(error)');
  });
});
