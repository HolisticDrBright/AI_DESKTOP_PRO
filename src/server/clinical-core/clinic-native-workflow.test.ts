import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';
import { createNativeClinicCustody, openNativeClinicRecovery } from './clinic-native-custody';
import { executeClinicPreservingWorkflow, clinicWorkflowSha256, type ClinicWorkflowBinding,
  type ClinicWorkflowObservation, type ClinicWorkflowPorts } from './clinic-preserving-workflow';
let artifact: unknown, root: string, operatorFile: string, child: ChildProcess, now: number;
const source = JSON.parse(readFileSync('infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', 'utf8'));
beforeAll(() => { artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })); }, 60000);
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'alp-clinic-native-workflow-')); operatorFile = join(root, 'original.cjs');
  writeFileSync(operatorFile, 'FICTIONAL original command'); now = Date.now();
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
});
async function stop() {
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => { child.once('exit', () => done()); child.kill(); });
  now += 61000;
}
afterEach(async () => { await stop();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'alp-clinic-native-workflow-')) throw Error('fixture_cleanup_scope');
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const binding: ClinicWorkflowBinding = { contract: 'clinic-preserving-workflow-binding/1', execution: 'injected_protocol_qualification',
    sourceCommit: 'a'.repeat(40), operatorSha256: createHash('sha256').update('FICTIONAL original command').digest('hex'),
    sourceArtifactSha256: clinicWorkflowSha256(artifact), independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256,
    targetSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64), phiAllowed: false, activation: 'blocked' };
  const observation = (prefix: 112 | 116): ClinicWorkflowObservation => ({ contract: 'clinic-preserving-workflow-observation/1',
    execution: 'injected_protocol_qualification', bindingSha256: clinicWorkflowSha256(binding), schemaSha256: String(prefix === 112 ? 1 : 2).repeat(64),
    witness: { contract: 'clinic-historical-row-witness/1', evidenceLayer: 'row_witness_primitive_only', sourceOnly: true,
      observedMigrationCount: prefix, historicalTableCount: 217, historicalRowCount: 3, historicalDataSha256: '3'.repeat(64),
      historicalReceiptsSha256: '4'.repeat(64), newRows: 0, schemaAdmissionProven: false, operatorAcceptance: false,
      custodyProven: false, managedRoleSemanticsVerified: false, phiAllowed: false, activation: 'blocked' }, phiAllowed: false, activation: 'blocked' });
  let current = observation(112), writes = 0, reads = 0;
  const options = (pid: number) => ({ root, operatorFile, runtime: { pid, host: 'FICTIONAL-native-host', now: () => now } });
  const ports: ClinicWorkflowPorts = {
    guard: async b => { expect(b).toEqual(binding); }, withFence: async work => work({ verify: async () => {} }),
    observe: async () => { reads++; return structuredClone(current); }, rehearse: async () => observation(112),
    forward: async () => { writes++; current = observation(116); return structuredClone(current); },
    createCustody: (b, initial, fence) => createNativeClinicCustody(options(child.pid!), b, initial, fence),
    openRecovery: (b, fence) => openNativeClinicRecovery(options(process.pid), b, fence),
  };
  return { binding, ports, writes: () => writes, reads: () => reads, current: () => current };
}
describe('Command protocol with real local files/process liveness and explicitly fictional DB ports', () => {
  it('archives all six observations before retiring a normal writer without promoting injected evidence', async () => {
    const h = fixture(), r = await executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports);
    expect(r).toMatchObject({ custodyProtocolCompleted: true, custodyProven: false, operatorAcceptance: false, phiAllowed: false });
    expect(h.writes()).toBe(1); expect(existsSync(join(root, 'operator.lock'))).toBe(false);
    const journal = readFileSync(join(root, readdirSync(root).find(n => n.endsWith('.clinic.events.jsonl'))!), 'utf8');
    expect(journal.trim().split('\n').map(line => JSON.parse(line).stage)).toEqual(['baseline', 'rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two']);
  });
  it('a lost commit reply retains custody, refuses a live original process, then reconciles with three reads and no retry', async () => {
    const h = fixture(), write = h.ports.forward;
    h.ports.forward = async (...args) => { await write(...args); throw Error('FICTIONAL lost response'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'unknown' });
    expect(existsSync(join(root, 'operator.lock'))).toBe(true); now += 61000;
    await expect(executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports)).rejects.toMatchObject({ stage: 'writer_active' });
    await stop(); const before = h.reads();
    const result = await executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports);
    expect(h.reads() - before).toBe(3); expect(h.writes()).toBe(1); expect(result).toMatchObject({ retryPerformed: false,
      databaseMutationPerformed: false, writeOutcome: 'unknown', observedMigrationCount: 116, custodyProven: false });
    expect(existsSync(join(root, 'operator.lock'))).toBe(false);
  });
  it('an interrupted rehearsal preserves the original baseline and recovers without ever invoking forward', async () => {
    const h = fixture(); h.ports.rehearse = async () => { throw Error('FICTIONAL rehearsal receipt lost'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'not_invoked' });
    await stop(); const result = await executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports);
    expect(result).toMatchObject({ observedMigrationCount: 112, databaseMutationPerformed: false }); expect(h.writes()).toBe(0);
  });
  it('failed preservation never retires custody even when the write replied', async () => {
    const h = fixture(), write = h.ports.forward;
    h.ports.forward = async (...args) => { const result = await write(...args); result.witness.historicalDataSha256 = 'f'.repeat(64); return result; };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'unknown', category: 'preservation_refused' });
    expect(h.writes()).toBe(1); expect(existsSync(join(root, 'operator.lock'))).toBe(true);
    expect(readdirSync(root).filter(v => v.endsWith('.clinic.settled.json'))).toHaveLength(0);
  });
  it('an outer fence exit failure retains original custody even after both readbacks and settlement preparation', async () => {
    const h = fixture();
    h.ports.withFence = async work => { await work({ verify: async () => {} }); throw Error('FICTIONAL fence exit failed'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports))
      .rejects.toMatchObject({ writeOutcome: 'unknown' });
    expect(h.writes()).toBe(1); expect(existsSync(join(root, 'operator.lock'))).toBe(true);
    expect(readdirSync(root).filter(v => v.endsWith('.clinic.settled.json'))).toHaveLength(1);
    await stop(); h.ports.withFence = async work => work({ verify: async () => {} });
    const result = await executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports);
    expect(result).toMatchObject({ observedMigrationCount: 116, databaseMutationPerformed: false, retryPerformed: false });
    expect(h.writes()).toBe(1); expect(existsSync(join(root, 'operator.lock'))).toBe(false);
  });
  it('a recovery fence exit failure retains both guards instead of losing the uncertain original attempt', async () => {
    const h = fixture(), forward = h.ports.forward;
    h.ports.forward = async (...args) => { await forward(...args); throw Error('FICTIONAL commit reply lost'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toThrow();
    await stop();
    h.ports.withFence = async work => { await work({ verify: async () => {} }); throw Error('FICTIONAL recovery fence exit failed'); };
    await expect(executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports)).rejects.toThrow();
    expect(existsSync(join(root, 'operator.lock'))).toBe(true);
    expect(existsSync(join(root, 'clinic-upgrade-reconciliation.lock'))).toBe(true);
    expect(h.writes()).toBe(1);
  });
  it.each(['source', 'receipt', 'receipt_identity', 'journal', 'lock_identity'])
    ('post-exit %s substitution refuses local retirement and retains original custody', async changed => {
      const h = fixture();
      h.ports.withFence = async work => {
        const result = await work({ verify: async () => {} });
        const file = changed === 'source' ? operatorFile : changed === 'journal'
          ? join(root, readdirSync(root).find(n => n.endsWith('.clinic.events.jsonl'))!)
          : changed === 'lock_identity' ? join(root, 'operator.lock')
            : join(root, readdirSync(root).find(n => n.endsWith('.clinic.settled.json'))!);
        if (changed.endsWith('_identity')) { const original = readFileSync(file); renameSync(file, file + '.old'); writeFileSync(file, original); }
        else writeFileSync(file, 'FICTIONAL changed after fence exit');
        return result;
      };
      await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports))
        .rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'unknown' });
      expect(h.writes()).toBe(1); expect(existsSync(join(root, 'operator.lock'))).toBe(true);
    });
  it('a substituted outer result retains the prepared native lock instead of retiring it', async () => {
    const h = fixture();
    h.ports.withFence = async work => ({ ...await work({ verify: async () => {} }), operatorAcceptance: true });
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports))
      .rejects.toMatchObject({ category: 'custody_refused', writeOutcome: 'unknown' });
    expect(h.writes()).toBe(1); expect(existsSync(join(root, 'operator.lock'))).toBe(true);
  });
  it('a post-exit recovery receipt change retains both local guards', async () => {
    const h = fixture(), forward = h.ports.forward;
    h.ports.forward = async (...args) => { await forward(...args); throw Error('FICTIONAL response lost'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toThrow();
    await stop();
    h.ports.withFence = async work => { const result = await work({ verify: async () => {} });
      writeFileSync(join(root, readdirSync(root).find(n => n.endsWith('.clinic.reconciled.json'))!), 'FICTIONAL changed'); return result; };
    await expect(executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports))
      .rejects.toMatchObject({ category: 'custody_refused' });
    expect(existsSync(join(root, 'operator.lock'))).toBe(true);
    expect(existsSync(join(root, 'clinic-upgrade-reconciliation.lock'))).toBe(true); expect(h.writes()).toBe(1);
  });
});
