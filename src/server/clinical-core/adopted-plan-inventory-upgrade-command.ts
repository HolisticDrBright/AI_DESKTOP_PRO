if (typeof window !== 'undefined') throw new Error('adopted-plan-inventory-upgrade-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { qualificationUpgradeFromAws, QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { ADOPTED_INVENTORY_UPGRADE, AdoptedInventoryUpgradeError, assertAdoptedInventoryUpgrade,
  runAdoptedInventorySchemaUpgrade, type AdoptedInventoryUpgradeResult } from './adopted-plan-inventory-schema-upgrade';
import { createHash } from 'node:crypto';
import type { InventoryCustodyBinding, InventoryOperatorFence, InventoryRecoveryCustody, InventoryWriterCustody } from './adopted-plan-inventory-custody-types';

export type AdoptedInventoryUpgradeBuild = { sourceCommit: string; clean: boolean };
export type AdoptedInventoryUpgradeDependencies = {
  observeCaller: () => unknown; observeFoundation: () => unknown; loadMigrations: () => ClinicalCoreMigration[];
  createDatabase: (c: QualificationUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runAdoptedInventorySchemaUpgrade;
  withFence?: <T>(work: (fence: InventoryOperatorFence) => Promise<T>) => Promise<T>;
  createCustody?: (binding: InventoryCustodyBinding, baseline: AdoptedInventoryUpgradeResult, fence: InventoryOperatorFence) => Promise<InventoryWriterCustody>;
  openRecoveryCustody?: (binding: InventoryCustodyBinding, fence: InventoryOperatorFence) => Promise<InventoryRecoveryCustody>;
};
const refuse = (): never => { throw new AdoptedInventoryUpgradeError('boundary_refused'); };
function observe(d: AdoptedInventoryUpgradeDependencies) {
  const caller = d.observeCaller();
  const c = qualificationUpgradeFromAws(caller, d.observeFoundation());
  return { caller: JSON.stringify(caller), configuration: { ...c, fromReleaseSha256: ADOPTED_INVENTORY_UPGRADE.from, toReleaseSha256: ADOPTED_INVENTORY_UPGRADE.to } };
}
export function verifyAdoptedInventoryObservation(r: AdoptedInventoryUpgradeResult, command: AdoptedInventoryUpgradeResult['command']) {
  if (r.contract !== 'adopted-plan-inventory-schema-upgrade/1' || r.command !== command || r.execution !== 'qualification'
    || r.phiAllowed !== false || r.activation !== 'blocked' || r.dataPreserved !== true || r.historicalSchemaPreserved !== true
    || ![106, 107].includes(r.observedMigrationCount) || r.tableCount !== ADOPTED_INVENTORY_UPGRADE.tableCount
    || !Number.isSafeInteger(r.rowCount) || r.rowCount < 0 || !/^[a-f0-9]{64}$/.test(r.dataSha256)
    || !/^[a-f0-9]{64}$/.test(r.historicalSchemaSha256) || typeof r.alreadyApplied !== 'boolean' || typeof r.applied !== 'boolean'
    || r.fromReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.from || r.toReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.to
    || r.rolledBack !== (command === 'rehearse') || command !== 'upgrade' && r.applied !== false
    || command !== 'upgrade' && r.alreadyApplied !== (r.observedMigrationCount === 107)
    || command === 'upgrade' && (r.observedMigrationCount !== 107 || r.applied !== !r.alreadyApplied)) {
    throw new AdoptedInventoryUpgradeError('verification_failed');
  }
}
function samePrestate(a: AdoptedInventoryUpgradeResult, b: AdoptedInventoryUpgradeResult) {
  if (a.rowCount !== b.rowCount || a.dataSha256 !== b.dataSha256 || a.historicalSchemaSha256 !== b.historicalSchemaSha256) {
    throw new AdoptedInventoryUpgradeError('verification_failed');
  }
}
/** Fixed synthetic account/foundation, embedded SQL, no target/review/credential
 * overrides. An uncertain write is not retried; the same target is inspected. */
export async function executeAdoptedInventoryUpgradeCommand(args: readonly string[], supplied: AdoptedInventoryUpgradeBuild,
  d: AdoptedInventoryUpgradeDependencies) {
  const build = { ...supplied }, [command, confirmation, ...extra] = args;
  if (extra.length || !['inspect', 'rehearse', 'upgrade', 'reconcile'].includes(command) || !/^[a-f0-9]{40}$/.test(build.sourceCommit)
    || typeof build.clean !== 'boolean' || command === 'inspect' && confirmation !== undefined
    || command !== 'inspect' && (confirmation !== (command === 'reconcile'
      ? '--reconcile-fictional-adopted-inventory-upgrade' : '--confirm-fictional-adopted-inventory-upgrade') || !build.clean)) refuse();
  // Until the native durable port is bound, no public writer or reconciliation
  // can fall back to a bare SQL call or a saved report.
  if ((command === 'upgrade' || command === 'reconcile') && (!d.withFence
    || command === 'upgrade' && !d.createCustody || command === 'reconcile' && !d.openRecoveryCustody)) {
    throw new AdoptedInventoryUpgradeError('custody_refused', 'native_port_required');
  }
  const target = observe(d), migrations = d.loadMigrations().map(m => ({ ...m }));
  assertAdoptedInventoryUpgrade(target.configuration, migrations);
  const database = d.createDatabase({ ...target.configuration }), run = d.run ?? runAdoptedInventorySchemaUpgrade;
  const summary = { operatorSource: build, operatorScope: 'prepared_qualification_only' as const,
    foundation: QUALIFICATION_UPGRADE_AWS.foundation, awsAccountId: QUALIFICATION_UPGRADE_AWS.account };
  const invoke = async (mode: AdoptedInventoryUpgradeResult['command'], before?: AdoptedInventoryUpgradeResult) => {
    const r = await run(database, migrations.map(m => ({ ...m })), { ...target.configuration }, mode, before ? {
      observedMigrationCount: before.observedMigrationCount, rowCount: before.rowCount,
      dataSha256: before.dataSha256, historicalSchemaSha256: before.historicalSchemaSha256,
    } : undefined);
    verifyAdoptedInventoryObservation(r, mode); return structuredClone(r);
  };
  if (command === 'inspect' || command === 'rehearse') return { ...await invoke(command), ...summary, rehearsal: null };
  const binding: InventoryCustodyBinding = { build: { ...build }, configuration: { ...target.configuration },
    callerSha256: createHash('sha256').update(target.caller).digest('hex') };
  return d.withFence!(async fence => {
    const guard = async () => {
      await fence.verify(); if (JSON.stringify(observe(d)) !== JSON.stringify(target)) refuse(); await fence.verify();
    };
    if (command === 'reconcile') {
      const custody = await d.openRecoveryCustody!(structuredClone(binding), fence);
      const baseline = structuredClone(custody.baseline);
      verifyAdoptedInventoryObservation(baseline, 'inspect-settled');
      if (baseline.observedMigrationCount !== 106 || baseline.alreadyApplied || baseline.applied
        || typeof custody.writeAdmitted !== 'boolean') throw new AdoptedInventoryUpgradeError('recovery_refused');
      let observed: AdoptedInventoryUpgradeResult | undefined;
      // Every observation takes the real migration/table locks. No DDL, inverse
      // migration, rollback request, retry or caller-provided report is used.
      for (let pass = 0; pass < 3; pass++) {
        await custody.verify(); await guard(); const next = await invoke('inspect-settled');
        samePrestate(next, baseline);
        if (!custody.writeAdmitted && next.observedMigrationCount !== 106
          || observed && JSON.stringify(next) !== JSON.stringify(observed)) throw new AdoptedInventoryUpgradeError('recovery_refused');
        await custody.verify(); await guard(); observed = next;
      }
      const settled = await custody.settle(observed!);
      return { contract: 'adopted-plan-inventory-upgrade-reconciliation/1', command: 'reconcile', execution: 'qualification',
        observation: observed!.observedMigrationCount === 107 ? 'preserved_successor_observed' : 'preserved_predecessor_observed',
        observedMigrationCount: observed!.observedMigrationCount, rowCount: observed!.rowCount, dataSha256: observed!.dataSha256,
        historicalSchemaSha256: observed!.historicalSchemaSha256, repeatedReadbackVerified: true,
        databaseMutationPerformed: false, retryPerformed: false, phiAllowed: false, activation: 'blocked', ...summary, ...settled };
    }
    await guard(); const baseline = await invoke('inspect-settled');
    if (baseline.observedMigrationCount !== 106 || baseline.alreadyApplied) throw new AdoptedInventoryUpgradeError('history_refused');
    const custody = await d.createCustody!(structuredClone(binding), structuredClone(baseline), fence);
    try {
      await custody.verify(); await guard(); const rehearsal = await invoke('rehearse');
      samePrestate(rehearsal, baseline);
      if (rehearsal.observedMigrationCount !== 106 || rehearsal.alreadyApplied) throw new AdoptedInventoryUpgradeError('verification_failed');
      await custody.record('rehearsal', rehearsal); await guard(); await custody.verify();
      await custody.record('write_admitted', rehearsal); await custody.verify(); await fence.verify();
      const result = await invoke('upgrade', rehearsal); samePrestate(result, baseline);
      if (!result.applied || result.alreadyApplied) throw new AdoptedInventoryUpgradeError('verification_failed');
      await custody.record('write_reply', result);
      for (const stage of ['readback_one', 'readback_two'] as const) {
        await custody.verify(); await guard(); const observed = await invoke('inspect-settled'); samePrestate(observed, baseline);
        if (observed.observedMigrationCount !== 107) throw new AdoptedInventoryUpgradeError('verification_failed');
        await custody.record(stage, observed);
      }
      await custody.verify(); await guard();
      const settled = await custody.settle(result);
      return { ...result, ...summary, ...settled, rehearsal: { rolledBack: true, rowCount: rehearsal.rowCount,
        dataSha256: rehearsal.dataSha256, historicalSchemaSha256: rehearsal.historicalSchemaSha256 } };
    } catch (error) {
      // A missing final journal entry is an interrupted run, never permission
      // to drop its lock or retry SQL. Findings contain no provider payload.
      try { await custody.finding(); } catch { /* retain original custody */ }
      throw error;
    }
  });
}
