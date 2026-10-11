if (typeof window !== 'undefined') throw Error('clinic-preserving-workflow is server-only');
import { createHash } from 'node:crypto';
import { buildClinicPreservingTransition, CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';
import { assertClinicHistoricalRowsAtPrefixPreserved, type ClinicRowWitness } from '../../../scripts/clinic-row-preservation.mjs';

/** Source qualification of the command/custody protocol. This deliberately has
 * no AWS transport, CLI, approval parser or managed-profile constructor. Ports
 * are injected and never provide managed or durable-custody evidence. The live
 * operator must supply independently admitted managed definitions, a fenced
 * forward kernel and native immutable custody before exposing a write command. */
export type ClinicWorkflowBinding = {
  contract: 'clinic-preserving-workflow-binding/1'; execution: 'injected_protocol_qualification';
  sourceCommit: string; operatorSha256: string; sourceArtifactSha256: string;
  independentReceiptSha256: typeof CLINIC_NATIVE_SOURCE_RECEIPT_SHA256;
  targetSha256: string; profileSha256: string; phiAllowed: false; activation: 'blocked';
};
export type ClinicWorkflowObservation = {
  contract: 'clinic-preserving-workflow-observation/1'; execution: 'injected_protocol_qualification';
  bindingSha256: string; schemaSha256: string; witness: ClinicRowWitness;
  phiAllowed: false; activation: 'blocked';
};
export type ClinicWorkflowStage = 'rehearsal' | 'write_admitted' | 'write_reply' | 'readback_one' | 'readback_two';
export type ClinicWorkflowFence = { verify(): Promise<void> };
/** Preparation runs under the DB fence; local retirement runs only after its
 * wrapper returns the exact sealed result. An uncertain exit retains custody. */
export type ClinicWorkflowSettlement = {
  runId: string; journalSha256: string; retire(): Promise<void>;
};
export type ClinicWorkflowWriter = {
  verify(): Promise<void>;
  record(stage: ClinicWorkflowStage, value: ClinicWorkflowObservation): Promise<void>;
  finding(): Promise<void>;
  settle(value: ClinicWorkflowObservation): Promise<ClinicWorkflowSettlement>;
};
export type ClinicWorkflowRecovery = {
  baseline: ClinicWorkflowObservation; writeAdmitted: boolean;
  verify(): Promise<void>;
  settle(value: ClinicWorkflowObservation): Promise<ClinicWorkflowSettlement>;
};
export type ClinicWorkflowPorts = {
  guard(binding: ClinicWorkflowBinding): Promise<void>;
  withFence<T>(work: (fence: ClinicWorkflowFence) => Promise<T>): Promise<T>;
  observe(binding: ClinicWorkflowBinding): Promise<ClinicWorkflowObservation>;
  rehearse(binding: ClinicWorkflowBinding, baseline: ClinicWorkflowObservation): Promise<ClinicWorkflowObservation>;
  forward(binding: ClinicWorkflowBinding, baseline: ClinicWorkflowObservation): Promise<ClinicWorkflowObservation>;
  createCustody(binding: ClinicWorkflowBinding, baseline: ClinicWorkflowObservation,
    fence: ClinicWorkflowFence): Promise<ClinicWorkflowWriter>;
  openRecovery(binding: ClinicWorkflowBinding, fence: ClinicWorkflowFence): Promise<ClinicWorkflowRecovery>;
};
const hash = /^[a-f0-9]{64}$/;
export const canonicalClinicWorkflow = (value: unknown): string => Array.isArray(value)
  ? '[' + value.map(canonicalClinicWorkflow).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':'
      + canonicalClinicWorkflow((value as Record<string, unknown>)[key])).join(',') + '}'
    : JSON.stringify(value);
export const clinicWorkflowSha256 = (value: unknown) => createHash('sha256').update(canonicalClinicWorkflow(value)).digest('hex');
const exact = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export class ClinicPreservingWorkflowError extends Error {
  constructor(readonly category: 'source_refused' | 'binding_refused' | 'observation_refused' | 'preservation_refused'
    | 'recovery_refused' | 'custody_refused' | 'workflow_failed', readonly writeOutcome: 'not_invoked' | 'unknown') {
    super(category); this.name = 'ClinicPreservingWorkflowError';
  }
}
function refuse(category: ClinicPreservingWorkflowError['category']): never {
  throw new ClinicPreservingWorkflowError(category, 'not_invoked');
}
const witnessKeys = ['contract', 'evidenceLayer', 'sourceOnly', 'observedMigrationCount', 'historicalTableCount',
  'historicalRowCount', 'historicalDataSha256', 'historicalReceiptsSha256', 'newRows', 'schemaAdmissionProven',
  'operatorAcceptance', 'custodyProven', 'managedRoleSemanticsVerified', 'phiAllowed', 'activation'];
/** Strict report admission, not verification of a managed database. A valid
 * caller-supplied report can never be promoted into runtime/approval evidence. */
export function assertClinicWorkflowObservation(value: unknown, binding: ClinicWorkflowBinding): asserts value is ClinicWorkflowObservation {
  if (!exact(value, ['contract', 'execution', 'bindingSha256', 'schemaSha256', 'witness', 'phiAllowed', 'activation']))
    refuse('observation_refused');
  const v = value as ClinicWorkflowObservation, w = v.witness;
  if (v.contract !== 'clinic-preserving-workflow-observation/1' || v.execution !== 'injected_protocol_qualification'
    || v.bindingSha256 !== clinicWorkflowSha256(binding) || !hash.test(v.schemaSha256)
    || v.phiAllowed !== false || v.activation !== 'blocked' || !exact(w, witnessKeys)
    || w.contract !== 'clinic-historical-row-witness/1' || w.evidenceLayer !== 'row_witness_primitive_only'
    || w.sourceOnly !== true || ![112, 116].includes(w.observedMigrationCount) || w.historicalTableCount !== 217
    || !Number.isSafeInteger(w.historicalRowCount) || w.historicalRowCount < 0 || w.newRows !== 0
    || !hash.test(w.historicalDataSha256) || !hash.test(w.historicalReceiptsSha256)
    || ['schemaAdmissionProven', 'operatorAcceptance', 'custodyProven', 'managedRoleSemanticsVerified', 'phiAllowed']
      .some(key => (w as unknown as Record<string, unknown>)[key] !== false) || w.activation !== 'blocked')
    refuse('observation_refused');
}
function preserved(before: ClinicWorkflowObservation, after: ClinicWorkflowObservation) {
  if (after.witness.observedMigrationCount === 112) {
    if (canonicalClinicWorkflow(before) !== canonicalClinicWorkflow(after)) refuse('preservation_refused');
  } else {
    try { assertClinicHistoricalRowsAtPrefixPreserved(before.witness, after.witness, 116); }
    catch { refuse('preservation_refused'); }
  }
}
function settlement(value: unknown) {
  if (!exact(value, ['runId', 'journalSha256', 'retire'])) refuse('custody_refused');
  const r = value as ClinicWorkflowSettlement;
  if (!/^[a-f0-9]{32}$/.test(r.runId) || !hash.test(r.journalSha256) || typeof r.retire !== 'function') refuse('custody_refused');
  return { receipt: { runId: r.runId, journalSha256: r.journalSha256 }, retire: r.retire.bind(r) };
}
export async function executeClinicPreservingWorkflow(command: 'upgrade' | 'reconcile', suppliedBinding: unknown,
  suppliedArtifact: unknown, suppliedReceipt: unknown, ports: ClinicWorkflowPorts) {
  let binding: ClinicWorkflowBinding;
  try {
    // Clone source BEFORE any asynchronous callback. Ports cannot change the
    // admitted binding or expected source by retaining a caller-owned object.
    const artifact = structuredClone(suppliedArtifact), receipt = structuredClone(suppliedReceipt);
    buildClinicPreservingTransition(artifact, receipt);
    binding = structuredClone(suppliedBinding) as ClinicWorkflowBinding;
    if (!exact(binding, ['contract', 'execution', 'sourceCommit', 'operatorSha256', 'sourceArtifactSha256',
      'independentReceiptSha256', 'targetSha256', 'profileSha256', 'phiAllowed', 'activation'])
      || !['upgrade', 'reconcile'].includes(command) || binding.contract !== 'clinic-preserving-workflow-binding/1'
      || binding.execution !== 'injected_protocol_qualification' || !/^[a-f0-9]{40}$/.test(binding.sourceCommit)
      || ['operatorSha256', 'targetSha256', 'profileSha256'].some(key => !hash.test(binding[key as keyof ClinicWorkflowBinding] as string))
      || binding.sourceArtifactSha256 !== clinicWorkflowSha256(artifact)
      || binding.independentReceiptSha256 !== CLINIC_NATIVE_SOURCE_RECEIPT_SHA256
      || binding.phiAllowed !== false || binding.activation !== 'blocked') refuse('binding_refused');
  } catch (error) {
    if (error instanceof ClinicPreservingWorkflowError) throw error;
    return refuse('source_refused');
  }
  // Every port receives its own clone; callbacks cannot mutate later guards.
  const clonedBinding = () => structuredClone(binding);
  let fenceInvocations = 0, sealedResult: string | undefined, invokedWriter = false;
  let retireAfterFenceExit: (() => Promise<void>) | undefined;
  const prepare = (value: unknown) => {
    if (retireAfterFenceExit) refuse('custody_refused');
    const prepared = settlement(value); retireAfterFenceExit = prepared.retire; return prepared.receipt;
  };
  const complete = <T>(value: T): T => { sealedResult = canonicalClinicWorkflow(value); return value; };
  const output = await ports.withFence(async fence => {
    if (++fenceInvocations !== 1) refuse('custody_refused');
    let forwardInvoked = false;
    const check = async () => { await fence.verify(); await ports.guard(clonedBinding()); await fence.verify(); };
    const read = async () => {
      await check(); const value = structuredClone(await ports.observe(clonedBinding()));
      assertClinicWorkflowObservation(value, binding); await check(); return value;
    };
    const result = (mode: 'upgrade' | 'reconcile', value: ClinicWorkflowObservation,
      receipt: { runId: string; journalSha256: string }) => ({
      contract: 'clinic-preserving-workflow-result/1' as const, execution: 'injected_protocol_qualification' as const,
      command: mode, bindingSha256: clinicWorkflowSha256(binding), ...receipt, observation: value,
      observedMigrationCount: value.witness.observedMigrationCount, repeatedReadbackVerified: true,
      retryPerformed: false, writeOutcome: mode === 'reconcile' ? 'unknown' as const : 'reply_returned' as const,
      custodyProtocolCompleted: true, custodyProven: false, managedRoleSemanticsVerified: false,
      canonicalSchemaAdmissionProven: false, operatorAcceptance: false, upgradeAuthorized: false,
      providerAuthorized: false, phiAllowed: false, activation: 'blocked' as const,
    });
    if (command === 'reconcile') {
      await check(); const custody = await ports.openRecovery(clonedBinding(), fence);
      const baseline = structuredClone(custody.baseline), writeAdmitted = custody.writeAdmitted;
      assertClinicWorkflowObservation(baseline, binding);
      if (baseline.witness.observedMigrationCount !== 112 || typeof writeAdmitted !== 'boolean') refuse('recovery_refused');
      let observed: ClinicWorkflowObservation | undefined;
      for (let pass = 0; pass < 3; pass++) {
        await custody.verify(); const next = await read(); preserved(baseline, next);
        if (!writeAdmitted && next.witness.observedMigrationCount !== 112
          || observed && canonicalClinicWorkflow(observed) !== canonicalClinicWorkflow(next)) refuse('recovery_refused');
        await custody.verify(); await check(); observed = next;
      }
      await custody.verify(); await check();
      return complete({ ...result('reconcile', observed!, prepare(await custody.settle(structuredClone(observed!)))),
        databaseMutationPerformed: false });
    }
    const baseline = await read();
    if (baseline.witness.observedMigrationCount !== 112) refuse('observation_refused');
    const custody = await ports.createCustody(clonedBinding(), structuredClone(baseline), fence);
    try {
      await custody.verify(); await check();
      const rehearsal = structuredClone(await ports.rehearse(clonedBinding(), structuredClone(baseline)));
      assertClinicWorkflowObservation(rehearsal, binding); preserved(baseline, rehearsal);
      if (rehearsal.witness.observedMigrationCount !== 112) refuse('observation_refused');
      await custody.record('rehearsal', structuredClone(rehearsal));
      // A fresh read after rehearsal must still match the archived baseline.
      await custody.verify(); const beforeWrite = await read(); preserved(baseline, beforeWrite);
      if (beforeWrite.witness.observedMigrationCount !== 112) refuse('observation_refused');
      await custody.record('write_admitted', structuredClone(beforeWrite));
      await custody.verify(); await check();
      forwardInvoked = true;
      invokedWriter = true;
      const written = structuredClone(await ports.forward(clonedBinding(), structuredClone(baseline)));
      assertClinicWorkflowObservation(written, binding); preserved(baseline, written);
      if (written.witness.observedMigrationCount !== 116) refuse('observation_refused');
      await custody.record('write_reply', structuredClone(written));
      for (const stage of ['readback_one', 'readback_two'] as const) {
        await custody.verify(); const next = await read(); preserved(baseline, next);
        if (canonicalClinicWorkflow(next) !== canonicalClinicWorkflow(written)) refuse('preservation_refused');
        await custody.verify(); await custody.record(stage, structuredClone(next));
      }
      await custody.verify(); await check();
      return complete(result('upgrade', written, prepare(await custody.settle(structuredClone(written)))));
    } catch (error) {
      // This intentionally neither retries forward nor retires original custody.
      // A timeout or lost commit reply remains unknown even if a later probe
      // might show the successor. Only explicit read-only reconciliation may
      // classify that observation under original native writer-stop authority.
      try { await custody.finding(); } catch { /* Preserve original custody. */ }
      throw new ClinicPreservingWorkflowError(error instanceof ClinicPreservingWorkflowError ? error.category : 'workflow_failed',
        forwardInvoked ? 'unknown' : 'not_invoked');
    }
  }).catch(error => {
    // Even failure of the outer fence AFTER a callback returned must not reset
    // an admitted writer to "not invoked". A recovery command, not a retry,
    // owns all later classification of that attempt.
    if (invokedWriter) throw new ClinicPreservingWorkflowError(
      error instanceof ClinicPreservingWorkflowError ? error.category : 'workflow_failed', 'unknown');
    throw error;
  });
  // A fence adapter must execute the callback exactly once and return its exact
  // completed result. Skipping it, swallowing failure or substituting success
  // cannot certify the command protocol. No authority is learned from the port.
  if (fenceInvocations !== 1 || sealedResult === undefined || canonicalClinicWorkflow(output) !== sealedResult || !retireAfterFenceExit)
    throw new ClinicPreservingWorkflowError('custody_refused', invokedWriter ? 'unknown' : 'not_invoked');
  // No database work occurs after fence exit. The native closure rechecks every
  // original archive and prepared receipt before retiring local custody. Failure
  // never retries the write and never yields a completed command result.
  try { await retireAfterFenceExit(); }
  catch { throw new ClinicPreservingWorkflowError('custody_refused', invokedWriter ? 'unknown' : 'not_invoked'); }
  return structuredClone(output);
}
