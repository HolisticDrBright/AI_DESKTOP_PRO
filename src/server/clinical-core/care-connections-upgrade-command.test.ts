import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { CARE_CONNECTIONS_UPGRADE, runCareConnectionsSchemaUpgrade } from './care-connections-schema-upgrade';
import { executeCareConnectionsUpgradeCommand } from './care-connections-upgrade-command';

// Real compiled artifact admission; subsequent transports are fictional. The
// separate SQL suite proves rollback, preservation and drift checks.
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
const migrations: ClinicalCoreMigration[] = artifact.manifest.migrations.slice(0, 105).map((m: { version: string; file: string }) => ({
  version: m.version, name: m.file.slice(15, -4), sql: artifact.files[m.file],
  sha256: createHash('sha256').update(artifact.files[m.file]).digest('hex'),
}));
const build = { sourceCommit: '1'.repeat(40), clean: true };
const confirm = '--confirm-fictional-care-connections-upgrade';
const caller = { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/FictionalOperator/session' };
const values = { PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled',
  DatabaseName: 'clinical_core_qualification', DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' };
const stack = { StackStatus: 'CREATE_COMPLETE',
  StackId: 'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/fictional',
  Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
const result = (command: 'inspect' | 'rehearse' | 'upgrade'): Awaited<ReturnType<typeof runCareConnectionsSchemaUpgrade>> => ({
  contract: 'care-connections-schema-upgrade/1', command, execution: 'qualification', phiAllowed: false, activation: 'blocked',
  observedMigrationCount: command === 'upgrade' ? 105 : 104, applied: command === 'upgrade', alreadyApplied: false,
  rolledBack: command === 'rehearse', dataPreserved: true, tableCount: command === 'upgrade' ? 207 : 206,
  rowCount: 8, dataSha256: 'a'.repeat(64), fromReleaseSha256: CARE_CONNECTIONS_UPGRADE.from, toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to,
});
function fixture() {
  const db: ClinicalCoreDatabase = { transaction: async () => { throw new Error('fictional transport is not SQL evidence'); } };
  const events: string[] = [];
  const d = {
    observeCaller: vi.fn(() => { events.push('caller'); return caller; }),
    observeFoundation: vi.fn(() => { events.push('foundation'); return { Stacks: [stack] }; }),
    loadMigrations: vi.fn(() => { events.push('artifact'); return migrations; }),
    createDatabase: vi.fn(() => { events.push('client'); return db; }),
    run: vi.fn<typeof runCareConnectionsSchemaUpgrade>(async (_db, _m, _c, command) => {
      events.push(command); return result(command);
    }),
  };
  return { d, events };
}
describe('qualification-only connection upgrade CLI admission and sequencing', () => {
  it('refuses malformed arguments and dirty write artifacts before observing AWS', async () => {
    for (const args of [[], ['apply'], ['inspect', confirm], ['upgrade'], ['rehearse'], ['upgrade', '--yes'],
      ['upgrade', confirm, '--database=clinical_core'], ['inspect', '--profile=other']]) {
      const { d } = fixture();
      await expect(executeCareConnectionsUpgradeCommand(args, build, d)).rejects.toThrow('boundary_refused');
      expect(d.observeCaller).not.toHaveBeenCalled();
    }
    for (const invalidBuild of [{ ...build, clean: false }, { ...build, sourceCommit: 'not-a-release' }]) {
      const { d } = fixture();
      await expect(executeCareConnectionsUpgradeCommand(['upgrade', confirm], invalidBuild, d)).rejects.toThrow('boundary_refused');
      expect(d.observeCaller).not.toHaveBeenCalled();
    }
  });
  it('allows dirty read-only inspection but never treats it as a clean candidate or performs rehearsal', async () => {
    const { d, events } = fixture();
    const inspected = await executeCareConnectionsUpgradeCommand(['inspect'], { ...build, clean: false }, d);
    expect(inspected.operatorSource.clean).toBe(false); expect(inspected.rehearsal).toBeNull();
    expect(events).toEqual(['caller', 'foundation', 'artifact', 'client', 'inspect']);
    expect(d.run.mock.calls[0][2]).toMatchObject({ phiAllowed: false, activation: 'blocked',
      expectedAccountId: '588966314750', qualificationDatabaseName: 'clinical_core_qualification',
      fromReleaseSha256: CARE_CONNECTIONS_UPGRADE.from, toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to });
  });
  it('refuses root or production caller and unfinished/staging/activated foundation before creating a database client', async () => {
    for (const bad of [{ ...caller, Account: '173535830222' }, { ...caller, Arn: 'arn:aws:iam::588966314750:root' }]) {
      const { d } = fixture(); d.observeCaller.mockReturnValue(bad);
      await expect(executeCareConnectionsUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('boundary_refused');
      expect(d.createDatabase).not.toHaveBeenCalled(); expect(d.loadMigrations).not.toHaveBeenCalled();
    }
    for (const bad of [{ ...stack, StackStatus: 'UPDATE_IN_PROGRESS' },
      ...[['PhiAllowed', 'true'], ['Activation', 'approved'], ['DatabaseName', 'clinical_core']].map(([key, value]) =>
        ({ ...stack, Outputs: stack.Outputs.map(o => o.OutputKey === key ? { ...o, OutputValue: value } : o) }))]) {
      const { d } = fixture(); d.observeFoundation.mockReturnValue({ Stacks: [bad] });
      await expect(executeCareConnectionsUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('boundary_refused');
      expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('refuses incomplete or modified canonical release before the database client', async () => {
    for (const bad of [migrations.slice(0, 104), migrations.map((m, i) => i === 104 ? { ...m, sql: m.sql + '\nselect 1;' } : m)]) {
      const { d } = fixture(); d.loadMigrations.mockReturnValue(bad);
      await expect(executeCareConnectionsUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow('artifact_refused');
      expect(d.createDatabase).not.toHaveBeenCalled(); expect(d.run).not.toHaveBeenCalled();
    }
  });
  it('requires the same bound client/artifact and an observed rollback before upgrade', async () => {
    const { d, events } = fixture();
    const upgraded = await executeCareConnectionsUpgradeCommand(['upgrade', confirm], build, d);
    expect(events).toEqual(['caller', 'foundation', 'artifact', 'client', 'rehearse', 'upgrade']);
    expect(d.run.mock.calls[0].slice(0, 3)).toEqual(d.run.mock.calls[1].slice(0, 3));
    expect(upgraded.rehearsal).toEqual({ rolledBack: true, dataSha256: 'a'.repeat(64) });
    expect(upgraded).toMatchObject({ phiAllowed: false, activation: 'blocked', awsAccountId: '588966314750' });
    expect(JSON.stringify(upgraded)).not.toMatch(/secretArn|DatabaseSecretArn|FictionalOperator/);
  });
  it('does not upgrade when rehearsal throws or does not certify rollback', async () => {
    for (const fail of ['throw', 'not_rolled_back']) {
      const { d } = fixture();
      if (fail === 'throw') d.run.mockRejectedValueOnce(new Error('fictional storage failure'));
      else d.run.mockResolvedValueOnce({ ...result('rehearse'), rolledBack: false });
      await expect(executeCareConnectionsUpgradeCommand(['upgrade', confirm], build, d)).rejects.toThrow();
      expect(d.run).toHaveBeenCalledTimes(1);
    }
  });
  it('does not upgrade or add a second transaction when only rehearsal was requested', async () => {
    const { d } = fixture();
    expect(await executeCareConnectionsUpgradeCommand(['rehearse', confirm], build, d)).toMatchObject({ applied: false, rolledBack: true });
    expect(d.run).toHaveBeenCalledTimes(1); expect(d.run.mock.calls[0][3]).toBe('rehearse');
  });
  it('keeps the command source identity stable across asynchronous mutation', async () => {
    const { d } = fixture(); const external = { ...build };
    d.run.mockImplementation(async (_db, _m, _c, command) => {
      external.sourceCommit = 'f'.repeat(40); external.clean = false; return result(command);
    });
    const upgraded = await executeCareConnectionsUpgradeCommand(['upgrade', confirm], external, d);
    expect(upgraded.operatorSource).toEqual(build);
  });
  it('ships one fixed CLI/SDK profile with no environment target override and safe failure output', () => {
    const source = readFileSync('src/server/clinical-core/care-connections-schema-upgrade-operator.ts', 'utf8');
    expect(source).toContain("'--profile', profile"); expect(source).toContain('fromIni({ profile })');
    expect(source).toContain('observeCaller: () => aws');
    expect(source).toContain('observeFoundation: () => aws');
    expect(source).not.toContain('process.env.'); expect(source).not.toContain('console.error(error)');
  });
});
