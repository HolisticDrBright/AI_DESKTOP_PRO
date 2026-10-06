import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { CARE_CONNECTIONS_UPGRADE } from './care-connections-schema-upgrade';
import { executeCareConsentCopyCommand } from './care-consent-copy-command';
import { runCareConsentCopyRegistration } from './care-consent-copy-registration';

// Real artifact admission; fictional AWS observations. No live AWS calls.
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const migrations: ClinicalCoreMigration[] = artifact.manifest.migrations.map((m: { version: string; file: string }) => ({
  version: m.version, name: m.file.slice(15, -4), sql: artifact.files[m.file], sha256: sha(artifact.files[m.file]),
}));
const build = { sourceCommit: '1'.repeat(40), clean: true };
const file = '--copy-file=/fictional/consent.json', confirm = '--confirm-fictional-consent-copy-registration';
const copy = { contract: 'care-consent-copy/1', artifactId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222', scope: 'messaging', artifactVersion: 'FICTIONAL-test/1',
  content: 'FICTIONAL copy only, already approved elsewhere.', contentSha256: sha('FICTIONAL copy only, already approved elsewhere.') };
const caller = { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/FictionalOperator/session' };
const values = { PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'disabled', DatabaseName: 'clinical_core_qualification',
  DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional' };
const stack = { StackStatus: 'CREATE_COMPLETE',
  StackId: 'arn:aws:cloudformation:us-east-2:588966314750:stack/ai-clinical-core-qualification-foundation/fictional',
  Outputs: Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
type Receipt = Awaited<ReturnType<typeof runCareConsentCopyRegistration>>;
const result = (command: Receipt['command']): Receipt => ({ contract: 'care-consent-copy-registration/1', command,
  execution: 'qualification', phiAllowed: false, activation: 'blocked', migrationCount: 105, migrationReleaseSha256: CARE_CONNECTIONS_UPGRADE.to,
  approvalsCreated: false, grantsCreated: false, copyInserted: command === 'register', copyPresent: command === 'register',
  artifactId: copy.artifactId, contentSha256: copy.contentSha256, rolledBack: command === 'rehearse' });
function fixture() {
  const events: string[] = [];
  const database: ClinicalCoreDatabase = { transaction: async () => { throw new Error('fictional CLI test is not SQL evidence'); } };
  const d = {
    readCopy: vi.fn(() => { events.push('copy'); return { ...copy }; }),
    loadMigrations: vi.fn(() => { events.push('artifact'); return migrations; }),
    observeCaller: vi.fn(() => { events.push('caller'); return { ...caller }; }),
    observeFoundation: vi.fn(() => { events.push('foundation'); return { Stacks: [stack] }; }),
    createDatabase: vi.fn((_configuration: QualificationUpgradeConfiguration) => { events.push('client'); return database; }),
    run: vi.fn<typeof runCareConsentCopyRegistration>(async (_db, _m, _c, mode) => { events.push(mode); return result(mode); }),
  };
  return { d, events };
}
describe('qualification consent-copy command admission and replay', () => {
  it.each([[], ['apply'], ['register', file], ['register', file, '--yes'], ['inventory', file], ['inspect'], ['inspect', file, confirm],
    ['register', file, confirm, '--phi=true'], ['inventory', '--profile=other'], ['register', '--copy-file=', confirm]].map(args => [args]))
  ('refuses invalid arguments before reading a file or observing AWS: %j', async args => {
    const { d, events } = fixture(); await expect(executeCareConsentCopyCommand(args, build, d)).rejects.toThrow('copy_invalid'); expect(events).toEqual([]);
  });
  it('refuses dirty or unversioned writes before file/AWS access', async () => {
    for (const bad of [{ ...build, clean: false }, { ...build, sourceCommit: 'invalid' }]) {
      const { d, events } = fixture(); await expect(executeCareConsentCopyCommand(['register', file, confirm], bad, d)).rejects.toThrow('copy_invalid'); expect(events).toEqual([]);
    }
  });
  it('permits dirty read-only inventory without a copy or rehearsal', async () => {
    const { d, events } = fixture(); const receipt = await executeCareConsentCopyCommand(['inventory'], { ...build, clean: false }, d);
    expect(events).toEqual(['artifact', 'caller', 'foundation', 'client', 'inventory']); expect(d.readCopy).not.toHaveBeenCalled();
    expect(receipt.operatorSource.clean).toBe(false); expect(receipt.rehearsal).toBeNull();
  });
  it('refuses a changed digest or extra approval field before observing AWS', async () => {
    for (const bad of [{ ...copy, contentSha256: 'f'.repeat(64) }, { ...copy, signedBy: 'operator' }]) {
      const { d } = fixture(); d.readCopy.mockReturnValue(bad);
      await expect(executeCareConsentCopyCommand(['register', file, confirm], build, d)).rejects.toThrow('copy_invalid');
      expect(d.observeCaller).not.toHaveBeenCalled(); expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it.each([{ ...caller, Account: '173535830222' }, { ...caller, Arn: 'arn:aws:iam::588966314750:root' }])
  ('refuses non-member or wrong account before constructing a database client', async bad => {
    const { d } = fixture(); d.observeCaller.mockReturnValue(bad);
    await expect(executeCareConsentCopyCommand(['register', file, confirm], build, d)).rejects.toThrow('boundary_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
  });
  it.each([['PhiAllowed', 'true'], ['Activation', 'approved'], ['DatabaseName', 'clinical_core'], ['QualificationExecution', 'enabled']])
  ('refuses activation/staging drift in observed foundation %s', async (key, value) => {
    const { d } = fixture(); d.observeFoundation.mockReturnValue({ Stacks: [{ ...stack,
      Outputs: stack.Outputs.map(o => o.OutputKey === key ? { ...o, OutputValue: value } : o) }] });
    await expect(executeCareConsentCopyCommand(['register', file, confirm], build, d)).rejects.toThrow('boundary_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
  });
  it('refuses incomplete stack, conflicting outputs, or changed artifact before client construction', async () => {
    for (const bad of [{ ...stack, StackStatus: 'UPDATE_IN_PROGRESS' }, { ...stack, Outputs: [...stack.Outputs, stack.Outputs[0]] }]) {
      const { d } = fixture(); d.observeFoundation.mockReturnValue({ Stacks: [bad] });
      await expect(executeCareConsentCopyCommand(['inventory'], build, d)).rejects.toThrow(); expect(d.createDatabase).not.toHaveBeenCalled();
    }
    for (const bad of [migrations.slice(0, 104), migrations.map((m, i) => i === 104 ? { ...m, sql: m.sql + '\nselect 1;' } : m)]) {
      const { d } = fixture(); d.loadMigrations.mockReturnValue(bad);
      await expect(executeCareConsentCopyCommand(['inventory'], build, d)).rejects.toThrow('artifact_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('requires verified rollback before registration on the same client and exact captured copy', async () => {
    const { d, events } = fixture(); const receipt = await executeCareConsentCopyCommand(['register', file, confirm], build, d);
    expect(events).toEqual(['copy', 'artifact', 'caller', 'foundation', 'client', 'rehearse', 'register']);
    expect(d.run.mock.calls[0].filter((_, i) => i !== 3)).toEqual(d.run.mock.calls[1].filter((_, i) => i !== 3));
    expect(d.createDatabase.mock.calls[0][0]).toMatchObject({ qualificationDatabaseName: 'clinical_core_qualification',
      expectedAccountId: '588966314750', phiAllowed: false, activation: 'blocked', toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to });
    expect(receipt.rehearsal).toEqual({ rolledBack: true, copyPresent: false }); expect(receipt.operatorPrincipalSha256).toBe(sha(JSON.stringify(caller)));
    expect(JSON.stringify(receipt)).not.toMatch(/FICTIONAL|secretArn|FictionalOperator|content\"/);
  });
  it('does not register after failed or uncertified rehearsal', async () => {
    for (const kind of ['throw', 'no_rollback']) {
      const { d } = fixture(); if (kind === 'throw') d.run.mockRejectedValueOnce(new Error('fictional failure'));
      else d.run.mockResolvedValueOnce({ ...result('rehearse'), rolledBack: false });
      await expect(executeCareConsentCopyCommand(['register', file, confirm], build, d)).rejects.toThrow(); expect(d.run).toHaveBeenCalledTimes(1);
    }
  });
  it('does not register when only inspection or rehearsal was requested', async () => {
    for (const mode of ['inspect', 'rehearse']) {
      const { d } = fixture(); await executeCareConsentCopyCommand(mode === 'inspect' ? [mode, file] : [mode, file, confirm], build, d);
      expect(d.run).toHaveBeenCalledTimes(1); expect(d.run.mock.calls[0][3]).toBe(mode);
    }
  });
  it('captures source, approval text and observed caller before async mutation', async () => {
    const { d } = fixture(); const source = { ...build }, identity = { ...caller }, supplied = { ...copy };
    d.observeCaller.mockReturnValue(identity); d.readCopy.mockReturnValue(supplied);
    d.run.mockImplementation(async (_db, _m, _c, mode, registered) => {
      source.clean = false; source.sourceCommit = 'f'.repeat(40); identity.Arn += '-mutated'; supplied.content = 'mutated';
      expect(registered).toEqual(copy); return result(mode);
    });
    const receipt = await executeCareConsentCopyCommand(['register', file, confirm], source, d);
    expect(receipt.operatorSource).toEqual(build); expect(receipt.operatorPrincipalSha256).toBe(sha(JSON.stringify(caller)));
  });
  it('uses one fixed CLI and SDK profile, bounded input, single SDK attempt, and redacted errors', () => {
    const source = readFileSync('src/server/clinical-core/care-consent-copy-operator.ts', 'utf8');
    expect(source).toContain("'--profile', profile"); expect(source).toContain('fromIni({ profile })');
    expect(source).toContain('createSingleAttemptRdsClient'); expect(source).toContain('isAbsolute(path)');
    expect(source).toContain('stat.size > 65536'); expect(source).toContain('Buffer.alloc(65537)'); expect(source).toContain("fatal: true");
    expect(source).not.toContain('process.env.'); expect(source).not.toContain('console.error(error)');
    expect(source).toContain("writeStatus: 'not_certified'");
  });
});
