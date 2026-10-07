import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadClinicalCoreMigrations } from './migrations';
import { loadGovernedCatalogMigrations } from './catalog-migrations';
import { CARE_ERASURE_AWS, CARE_ERASURE_UPGRADE, type CareErasureUpgradeResult } from './care-erasure-schema-upgrade';
import { executeCareErasureUpgradeCommand, type CareErasureUpgradeDependencies } from './care-erasure-upgrade-command';
const a = CARE_ERASURE_AWS, build = { sourceCommit: 'a'.repeat(40), clean: true };
const caller = { Account: a.account, Arn: `arn:aws:sts::${a.account}:assumed-role/FictionalOperator/session` };
const stack = { StackStatus: 'UPDATE_COMPLETE', StackId: `arn:aws:cloudformation:${a.region}:${a.account}:stack/${a.foundation}/fictional`,
  Outputs: Object.entries({ PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only', DatabaseName: a.databaseName,
    ClinicalApiId: a.apiId, DatabaseClusterArn: a.clusterArn, DatabaseSecretArn: a.secretArn }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
function result(command: 'inspect' | 'rehearse' | 'upgrade'): CareErasureUpgradeResult {
  const upgrade = command === 'upgrade';
  return { contract: 'care-erasure-schema-upgrade/1', command, execution: 'synthetic-staging', phiAllowed: false,
    observedMigrationCount: upgrade ? 47 : 46, sourceMigrationCount: upgrade ? 46 : 45, tableCount: upgrade ? 88 : 87,
    rowCount: 10, dataSha256: 'b'.repeat(64), dataPreserved: true, applied: upgrade, alreadyApplied: false, rolledBack: command === 'rehearse',
    fromLedgerSha256: CARE_ERASURE_UPGRADE.liveBefore, toLedgerSha256: CARE_ERASURE_UPGRADE.liveAfter, referenceLedgerSha256: CARE_ERASURE_UPGRADE.reference };
}
function dependencies() {
  const events: string[] = [];
  const d: CareErasureUpgradeDependencies = {
    observeCaller: vi.fn(() => { events.push('caller'); return structuredClone(caller); }),
    observeFoundation: vi.fn(() => { events.push('foundation'); return { Stacks: [structuredClone(stack)] }; }),
    loadMigrations: loadClinicalCoreMigrations, loadReferenceMigrations: loadGovernedCatalogMigrations,
    createDatabase: vi.fn(() => { events.push('client'); return { transaction: async () => { throw Error('unexpected'); } }; }),
    run: vi.fn(async (_db, _m, _ref, _c, command) => { events.push(command); return result(command); }),
  };
  return { d, events };
}
describe('fixed synthetic erasure upgrade command, fictional transports only', () => {
  it('builds a self-contained exact-source operator with embedded histories and refuses overrides without AWS calls', () => {
    execFileSync(process.execPath, ['scripts/build-care-erasure-schema-upgrade.mjs'], { encoding: 'utf8', timeout: 30000 });
    const dir = 'dist/aws-clinical-core/care-erasure-schema-upgrade/', emitted = readFileSync(dir + 'index.cjs');
    const manifest = JSON.parse(readFileSync(dir + 'artifact-manifest.json', 'utf8'));
    expect(manifest).toMatchObject({ embeddedMigrations: true, embeddedReferenceMigrations: true, targetOverrides: false,
      expectedLiveBefore: 46, expectedLiveAfter: 47, historicalAliasPreserved: true, phiAllowed: false, migrationPerformed: false });
    expect(manifest.sha256).toBe(createHash('sha256').update(emitted).digest('hex'));
    expect(emitted.toString()).toContain(CARE_ERASURE_UPGRADE.sqlSha256);
    expect(emitted.toString()).toContain(referenceSourceDigest());
    try { execFileSync(process.execPath, [dir + 'index.cjs', 'inspect', '--database=clinical_core_qualification'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
      throw Error('unexpected success');
    } catch (error) {
      expect(error).toHaveProperty('status', 1); expect(String((error as { stderr: string }).stderr).trim()).toBe('boundary_refused');
    }
  }, 40000);
  it('refuses unknown arguments, target/review overrides and dirty mutating builds before AWS observation', async () => {
    for (const args of [[], ['apply'], ['upgrade'], ['rehearse'], ['inspect', '--confirm-fictional-care-erasure-upgrade'],
      ['upgrade', '--confirm-fictional-care-erasure-upgrade', '--skip-rehearsal'], ['inspect', '--database=clinical_core'], ['inspect', '--phi']]) {
      const { d, events } = dependencies(); await expect(executeCareErasureUpgradeCommand(args, build, d)).rejects.toThrow('boundary_refused'); expect(events).toEqual([]);
    }
    const { d, events } = dependencies();
    await expect(executeCareErasureUpgradeCommand(['upgrade', '--confirm-fictional-care-erasure-upgrade'], { ...build, clean: false }, d)).rejects.toThrow(); expect(events).toEqual([]);
  });
  it('does not open a database for root, wrong account, unfinished/wrong foundation or mismatched required output', async () => {
    for (const changed of [{ Account: '173535830222' }, { Arn: `arn:aws:iam::${a.account}:root` }, { Arn: `arn:aws:iam::${a.account}:user/test` }]) {
      const { d } = dependencies(); d.observeCaller = () => ({ ...caller, ...changed });
      await expect(executeCareErasureUpgradeCommand(['inspect'], build, d)).rejects.toThrow('boundary_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
    }
    for (const output of stack.Outputs) {
      for (const value of ['', output.OutputKey === 'PhiAllowed' ? 'true' : 'wrong']) {
        const { d } = dependencies(), changed = structuredClone(stack);
        changed.Outputs.find(x => x.OutputKey === output.OutputKey)!.OutputValue = value; d.observeFoundation = () => ({ Stacks: [changed] });
        await expect(executeCareErasureUpgradeCommand(['inspect'], build, d)).rejects.toThrow('boundary_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
      }
    }
    for (const changed of [{ StackStatus: 'UPDATE_ROLLBACK_COMPLETE' }, { StackId: stack.StackId.replace(a.foundation, 'ai-clinical-core-qualification-foundation') },
      { Outputs: [...stack.Outputs, stack.Outputs[0]] }]) {
      const { d } = dependencies(); d.observeFoundation = () => ({ Stacks: [{ ...stack, ...changed }] });
      await expect(executeCareErasureUpgradeCommand(['inspect'], build, d)).rejects.toThrow('boundary_refused'); expect(d.createDatabase).not.toHaveBeenCalled();
    }
  });
  it('inspects only and upgrade cannot bypass a verified rehearsal and a fresh target observation', async () => {
    const inspect = dependencies();
    expect(await executeCareErasureUpgradeCommand(['inspect'], build, inspect.d)).toMatchObject({ command: 'inspect', applied: false, acceptance: false });
    expect(inspect.events).toEqual(['caller', 'foundation', 'client', 'inspect']);
    const { d, events } = dependencies();
    expect(await executeCareErasureUpgradeCommand(['upgrade', '--confirm-fictional-care-erasure-upgrade'], build, d)).toMatchObject({ command: 'upgrade', applied: true,
      rehearsal: { rolledBack: true }, acceptance: false, phiActivation: false });
    expect(events).toEqual(['caller', 'foundation', 'client', 'rehearse', 'caller', 'foundation', 'upgrade']);
  });
  it('refuses a false/altered rehearsal report and a changed target before any upgrade', async () => {
    for (const patch of [{ rolledBack: false }, { execution: 'qualification' }, { sourceMigrationCount: 46 }, { fromLedgerSha256: 'f'.repeat(64) },
      { dataPreserved: false }, { phiAllowed: true }]) {
      const { d, events } = dependencies(); d.run = vi.fn(async () => ({ ...result('rehearse'), ...patch } as CareErasureUpgradeResult));
      await expect(executeCareErasureUpgradeCommand(['upgrade', '--confirm-fictional-care-erasure-upgrade'], build, d)).rejects.toThrow('verification_failed'); expect(events).not.toContain('upgrade');
    }
    const { d, events } = dependencies(); let reads = 0;
    d.observeFoundation = () => { reads++; return { Stacks: [{ ...stack, StackStatus: reads === 1 ? 'UPDATE_COMPLETE' : 'UPDATE_IN_PROGRESS' }] }; };
    await expect(executeCareErasureUpgradeCommand(['upgrade', '--confirm-fictional-care-erasure-upgrade'], build, d)).rejects.toThrow('boundary_refused'); expect(events).not.toContain('upgrade');
  });
});
function referenceSourceDigest() { return loadGovernedCatalogMigrations()[0].sha256; }
