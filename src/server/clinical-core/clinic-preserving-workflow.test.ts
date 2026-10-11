import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { executeClinicPreservingWorkflow, clinicWorkflowSha256, type ClinicWorkflowBinding,
  type ClinicWorkflowObservation, type ClinicWorkflowPorts, type ClinicWorkflowStage } from './clinic-preserving-workflow';
import { CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';

let artifact: unknown;
const source = JSON.parse(readFileSync('infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', 'utf8'));
beforeAll(() => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
}, 60000);
const binding = (): ClinicWorkflowBinding => ({ contract: 'clinic-preserving-workflow-binding/1', execution: 'injected_protocol_qualification',
  sourceCommit: 'a'.repeat(40), operatorSha256: 'b'.repeat(64), sourceArtifactSha256: clinicWorkflowSha256(artifact),
  independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256, targetSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64),
  phiAllowed: false, activation: 'blocked' });
function observation(b: ClinicWorkflowBinding, prefix: 112 | 116): ClinicWorkflowObservation {
  return { contract: 'clinic-preserving-workflow-observation/1', execution: 'injected_protocol_qualification',
    bindingSha256: clinicWorkflowSha256(b), schemaSha256: String(prefix === 112 ? '1' : '2').repeat(64),
    witness: { contract: 'clinic-historical-row-witness/1', evidenceLayer: 'row_witness_primitive_only', sourceOnly: true,
      observedMigrationCount: prefix, historicalTableCount: 217, historicalRowCount: 3, historicalDataSha256: '3'.repeat(64),
      historicalReceiptsSha256: '4'.repeat(64), newRows: 0, schemaAdmissionProven: false, operatorAcceptance: false,
      custodyProven: false, managedRoleSemanticsVerified: false, phiAllowed: false, activation: 'blocked' },
    phiAllowed: false, activation: 'blocked' };
}
function harness() {
  const b = binding(), before = observation(b, 112), after = observation(b, 116), calls: string[] = [];
  let current = structuredClone(before), admitted = false, forwardCalls = 0, settlements = 0;
  const events: ClinicWorkflowStage[] = [];
  const verify = async () => { calls.push('verify'); };
  const ports: ClinicWorkflowPorts = {
    guard: async incoming => { calls.push('guard'); expect(incoming).toEqual(b); },
    withFence: async work => { calls.push('fence'); return work({ verify }); },
    observe: async () => { calls.push('observe'); return structuredClone(current); },
    rehearse: async () => { calls.push('rehearse'); return structuredClone(before); },
    forward: async () => { calls.push('forward'); forwardCalls++; current = structuredClone(after); return structuredClone(after); },
    createCustody: async () => { calls.push('custody'); return {
      verify, record: async stage => { calls.push(stage); events.push(stage); if (stage === 'write_admitted') admitted = true; },
      finding: async () => { calls.push('finding'); }, settle: async () => {
        calls.push('settle'); return { runId: '5'.repeat(32), journalSha256: '6'.repeat(64), retire: async () => { calls.push('retire'); settlements++; } };
      },
    }; },
    openRecovery: async () => { calls.push('recovery'); return { baseline: structuredClone(before), writeAdmitted: admitted,
      verify, settle: async () => { calls.push('settle'); return { runId: '5'.repeat(32), journalSha256: '6'.repeat(64), retire: async () => { calls.push('retire'); settlements++; } }; } }; },
  };
  return { b, before, after, calls, events, ports, setCurrent: (v: ClinicWorkflowObservation) => { current = structuredClone(v); },
    setAdmitted: (v: boolean) => { admitted = v; }, forwardCalls: () => forwardCalls, settlements: () => settlements };
}
describe('clinic preserving command protocol qualification, not native custody or managed acceptance', () => {
  it('archives rehearsal and write admission before one forward call and two fresh successor readbacks', async () => {
    const h = harness(); const result = await executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports);
    expect(h.events).toEqual(['rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two']);
    expect(h.calls.indexOf('custody')).toBeLessThan(h.calls.indexOf('rehearse'));
    expect(h.calls.indexOf('write_admitted')).toBeLessThan(h.calls.indexOf('forward'));
    expect(h.calls.filter(c => c === 'observe')).toHaveLength(4);
    expect(h.forwardCalls()).toBe(1); expect(h.settlements()).toBe(1);
    expect(result).toMatchObject({ execution: 'injected_protocol_qualification', observedMigrationCount: 116,
      custodyProtocolCompleted: true, custodyProven: false, canonicalSchemaAdmissionProven: false,
      operatorAcceptance: false, managedRoleSemanticsVerified: false, upgradeAuthorized: false, phiAllowed: false, retryPerformed: false });
  });
  it.each(['contract', 'execution', 'sourceCommit', 'operatorSha256', 'sourceArtifactSha256', 'independentReceiptSha256',
    'targetSha256', 'profileSha256', 'phiAllowed', 'activation'])('refuses altered %s before any port', async field => {
    const h = harness(), changed = { ...h.b, [field]: field === 'phiAllowed' ? true : 'invalid' };
    await expect(executeClinicPreservingWorkflow('upgrade', changed, artifact, source, h.ports)).rejects.toMatchObject({ category: 'binding_refused' });
    expect(h.calls).toEqual([]);
  });
  it('refuses source drift and an invented source approval before any port', async () => {
    for (const receipt of [{ ...source, upgradeAuthorized: true }, { ...source, snapshots: [] }]) {
      const h = harness(); await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, receipt, h.ports))
        .rejects.toMatchObject({ category: 'source_refused' }); expect(h.calls).toEqual([]);
    }
  });
  it.each(['schemaSha256', 'bindingSha256', 'execution', 'unknown'])('refuses bad observation %s before custody', async field => {
    const h = harness(); h.ports.observe = async () => ({ ...h.before, [field]: 'invalid' });
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'observation_refused' });
    expect(h.calls).not.toContain('custody'); expect(h.forwardCalls()).toBe(0);
  });
  it.each(['schemaAdmissionProven', 'operatorAcceptance', 'custodyProven', 'managedRoleSemanticsVerified', 'phiAllowed'])
    ('refuses a witness promoted to %s', async field => {
      const h = harness(); h.ports.observe = async () => ({ ...h.before, witness: { ...h.before.witness, [field]: true } });
      await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'observation_refused' });
      expect(h.forwardCalls()).toBe(0);
    });
  it.each([113, 114, 115])('refuses partially applied prefix %s without another forward call', async prefix => {
    const h = harness(); h.ports.observe = async () => ({ ...h.before, witness: { ...h.before.witness, observedMigrationCount: prefix as 112 } });
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'observation_refused' });
    expect(h.forwardCalls()).toBe(0);
  });
  it('does not upgrade an already-applied successor', async () => {
    const h = harness(); h.setCurrent(h.after);
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'observation_refused' });
    expect(h.calls).not.toContain('custody'); expect(h.forwardCalls()).toBe(0);
  });
  it.each(['rehearse', 'rehearsal', 'write_admitted', 'forward', 'write_reply', 'readback_one', 'readback_two', 'settle'])
    ('preserves original custody after failure at %s and never retries forward', async stage => {
      const h = harness(), oldCreate = h.ports.createCustody;
      h.ports.createCustody = async (...args) => {
        const custody = await oldCreate(...args), oldRecord = custody.record, oldSettle = custody.settle;
        return { ...custody, record: async (name, value) => { if (stage === name) throw Error('FICTIONAL lost journal response'); return oldRecord(name, value); },
          settle: async value => { if (stage === 'settle') throw Error('FICTIONAL archive unavailable'); return oldSettle(value); } };
      };
      if (stage === 'rehearse') h.ports.rehearse = async () => { throw Error('FICTIONAL rehearsal failed'); };
      if (stage === 'forward') h.ports.forward = async () => { h.calls.push('forward'); throw Error('FICTIONAL commit reply lost'); };
      await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({
        writeOutcome: ['forward', 'write_reply', 'readback_one', 'readback_two', 'settle'].includes(stage) ? 'unknown' : 'not_invoked',
      });
      expect(h.calls.filter(c => c === 'forward').length).toBeLessThanOrEqual(1); expect(h.calls).toContain('finding'); expect(h.settlements()).toBe(0);
    });
  it('a missing admission receipt never reaches forward even if recording might have persisted', async () => {
    const h = harness(), old = h.ports.createCustody;
    h.ports.createCustody = async (...args) => { const custody = await old(...args); return { ...custody, record: async (stage, value) => {
      await custody.record(stage, value); if (stage === 'write_admitted') throw Error('FICTIONAL lost durable receipt');
    } }; };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'not_invoked' });
    expect(h.forwardCalls()).toBe(0); expect(h.settlements()).toBe(0);
  });
  it.each(['historicalRowCount', 'historicalDataSha256', 'historicalReceiptsSha256'])('refuses changed %s after a returned write', async field => {
    const h = harness(); h.ports.forward = async () => ({ ...h.after, witness: { ...h.after.witness, [field]: field === 'historicalRowCount' ? 4 : 'f'.repeat(64) } });
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'preservation_refused', writeOutcome: 'unknown' });
    expect(h.calls).not.toContain('write_reply'); expect(h.settlements()).toBe(0);
  });
  it('refuses a changed successor definition on either readback', async () => {
    for (const changedRead of [3, 4]) {
      const h = harness(), old = h.ports.observe; let reads = 0;
      h.ports.observe = async b => { const v = await old(b); return ++reads === changedRead ? { ...v, schemaSha256: 'f'.repeat(64) } : v; };
      await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'preservation_refused', writeOutcome: 'unknown' });
      expect(h.settlements()).toBe(0);
    }
  });
  it('detects changed baseline after physical rehearsal and before write admission', async () => {
    const h = harness(); h.ports.rehearse = async () => { h.setCurrent({ ...h.before, schemaSha256: 'f'.repeat(64) }); return h.before; };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'preservation_refused', writeOutcome: 'not_invoked' });
    expect(h.events).not.toContain('write_admitted'); expect(h.forwardCalls()).toBe(0);
  });
  it('guards binding and fence again after write admission before invoking forward', async () => {
    const h = harness(), old = h.ports.guard;
    h.ports.guard = async b => { await old(b); if (h.events.includes('write_admitted')) throw Error('FICTIONAL target changed'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'not_invoked' });
    expect(h.forwardCalls()).toBe(0);
  });
  it('isolates admitted binding and baseline from mutations by a port', async () => {
    const h = harness(); h.ports.rehearse = async (b, baseline) => { b.targetSha256 = 'f'.repeat(64); baseline.witness.historicalRowCount = 999; return h.before; };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).resolves.toMatchObject({ observedMigrationCount: 116 });
    expect(h.b.targetSha256).toBe('c'.repeat(64)); expect(h.before.witness.historicalRowCount).toBe(3);
  });
  it.each([112, 116] as const)('explicit recovery reads %s three times and invokes no write or rehearsal', async prefix => {
    const h = harness(); h.setAdmitted(true); h.setCurrent(prefix === 112 ? h.before : h.after);
    const result = await executeClinicPreservingWorkflow('reconcile', h.b, artifact, source, h.ports);
    expect(h.calls.filter(c => c === 'observe')).toHaveLength(3); expect(h.calls).not.toContain('forward'); expect(h.calls).not.toContain('rehearse');
    expect(result).toMatchObject({ command: 'reconcile', observedMigrationCount: prefix, databaseMutationPerformed: false,
      writeOutcome: 'unknown', retryPerformed: false, custodyProven: false });
  });
  it('does not reconcile an unadmitted successor', async () => {
    const h = harness(); h.setCurrent(h.after);
    await expect(executeClinicPreservingWorkflow('reconcile', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'recovery_refused' });
    expect(h.settlements()).toBe(0); expect(h.forwardCalls()).toBe(0);
  });
  it('refuses mixed predecessor/successor recovery snapshots', async () => {
    const h = harness(); h.setAdmitted(true); let reads = 0; h.ports.observe = async () => ++reads === 1 ? h.before : h.after;
    await expect(executeClinicPreservingWorkflow('reconcile', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'recovery_refused' });
    expect(h.settlements()).toBe(0);
  });
  it('leaves custody on writer-stop refusal without any recovery read', async () => {
    const h = harness(); h.ports.openRecovery = async () => { throw Error('FICTIONAL original writer active'); };
    await expect(executeClinicPreservingWorkflow('reconcile', h.b, artifact, source, h.ports)).rejects.toThrow('FICTIONAL original writer active');
    expect(h.calls).not.toContain('observe'); expect(h.settlements()).toBe(0);
  });
  it('refuses malformed settlement evidence rather than reporting protocol completion', async () => {
    const h = harness(), old = h.ports.createCustody;
    h.ports.createCustody = async (...args) => ({ ...await old(...args), settle: async () => ({ runId: 'invalid', journalSha256: 'f'.repeat(64), retire: async () => { throw Error('unexpected retirement'); } }) });
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'unknown' });
  });
  it('refuses substitution of a completed result by the outer fence', async () => {
    const h = harness(); h.ports.withFence = async work => { const v = await work({ verify: async () => {} }); return { ...v, operatorAcceptance: true }; };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'unknown' });
    expect(h.forwardCalls()).toBe(1);
    expect(h.calls).not.toContain('retire');
  });
  it('a fence cannot run the workflow twice', async () => {
    const h = harness(); h.ports.withFence = async work => { await work({ verify: async () => {} }); return work({ verify: async () => {} }); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'unknown' });
    expect(h.forwardCalls()).toBe(1);
  });
  it('a swallowed callback refusal cannot become a protocol result', async () => {
    const h = harness(); h.ports.observe = async () => ({ ...h.before, operatorAcceptance: true });
    h.ports.withFence = async work => { try { return await work({ verify: async () => {} }); } catch { return undefined as never; } };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'not_invoked' });
    expect(h.forwardCalls()).toBe(0);
  });
  it('a fence-exit failure after a write retains the unknown write outcome', async () => {
    const h = harness(); h.ports.withFence = async work => { await work({ verify: async () => {} }); throw Error('FICTIONAL fence release uncertain'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'unknown' });
    expect(h.forwardCalls()).toBe(1);
    expect(h.calls).not.toContain('retire'); expect(h.settlements()).toBe(0);
  });
  it('retires only after the exact completed result leaves the fence wrapper', async () => {
    const h = harness();
    h.ports.withFence = async work => { const result = await work({ verify: async () => {} });
      expect(h.calls).not.toContain('retire'); h.calls.push('fence_exited'); return result; };
    await executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports);
    expect(h.calls.indexOf('retire')).toBeGreaterThan(h.calls.indexOf('fence_exited'));
    expect(h.settlements()).toBe(1);
  });
  it('a local retirement failure reports uncertainty without a second forward call', async () => {
    const h = harness(), old = h.ports.createCustody;
    h.ports.createCustody = async (...args) => { const custody = await old(...args), settle = custody.settle;
      return { ...custody, settle: async value => ({ ...await settle(value), retire: async () => { throw Error('FICTIONAL local retirement failed'); } }) }; };
    await expect(executeClinicPreservingWorkflow('upgrade', h.b, artifact, source, h.ports))
      .rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'unknown' });
    expect(h.forwardCalls()).toBe(1); expect(h.settlements()).toBe(0);
  });
});
