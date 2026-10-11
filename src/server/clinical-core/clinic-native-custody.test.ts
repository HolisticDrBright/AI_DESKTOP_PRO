import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, appendFileSync,
  unlinkSync, renameSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createNativeClinicCustody, openNativeClinicRecovery } from './clinic-native-custody';
import { canonicalClinicWorkflow, clinicWorkflowSha256, type ClinicWorkflowBinding,
  type ClinicWorkflowObservation, type ClinicWorkflowWriter } from './clinic-preserving-workflow';
import { CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';
let root: string, operatorFile: string, now: number, child: ChildProcess | undefined;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fence = { verify: async () => {} };
const options = (pid = process.pid) => ({ root, operatorFile, runtime: { pid, host: 'FICTIONAL-host', now: () => now } });
const lock = () => join(root, 'operator.lock');
const binding = (): ClinicWorkflowBinding => ({ contract: 'clinic-preserving-workflow-binding/1', execution: 'injected_protocol_qualification',
  sourceCommit: 'a'.repeat(40), operatorSha256: hash('FICTIONAL clinic operator'), sourceArtifactSha256: 'b'.repeat(64),
  independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256, targetSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64),
  phiAllowed: false, activation: 'blocked' });
const observation = (b = binding(), prefix: 112 | 116 = 112): ClinicWorkflowObservation => ({
  contract: 'clinic-preserving-workflow-observation/1', execution: 'injected_protocol_qualification', bindingSha256: clinicWorkflowSha256(b),
  schemaSha256: String(prefix === 112 ? 1 : 2).repeat(64), witness: { contract: 'clinic-historical-row-witness/1',
    evidenceLayer: 'row_witness_primitive_only', sourceOnly: true, observedMigrationCount: prefix,
    historicalTableCount: 217, historicalRowCount: 3, historicalDataSha256: '3'.repeat(64), historicalReceiptsSha256: '4'.repeat(64),
    newRows: 0, schemaAdmissionProven: false, operatorAcceptance: false, custodyProven: false,
    managedRoleSemanticsVerified: false, phiAllowed: false, activation: 'blocked' }, phiAllowed: false, activation: 'blocked' });
const file = (suffix: string) => join(root, readdirSync(root).find(name => name.endsWith(suffix))!);
const journal = () => file('.clinic.events.jsonl');
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'alp-clinic-custody-')); operatorFile = join(root, 'original.cjs');
  writeFileSync(operatorFile, 'FICTIONAL clinic operator'); now = Date.now(); });
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) await stopWriter(false);
  child = undefined;
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'alp-clinic-custody-')) throw Error('fixture_cleanup_scope');
  rmSync(root, { recursive: true, force: true });
});
async function writerProcess() {
  child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((done, fail) => { child!.once('spawn', done); child!.once('error', fail); }); return child.pid!;
}
async function stopWriter(advance = true) {
  await new Promise<void>(done => { child!.once('exit', () => done()); child!.kill(); }); if (advance) now += 61000;
}
async function admitted(writer: ClinicWorkflowWriter) {
  await writer.record('rehearsal', observation()); await writer.record('write_admitted', observation());
}
async function complete(writer: ClinicWorkflowWriter) {
  await admitted(writer); const after = observation(binding(), 116);
  await writer.record('write_reply', after); await writer.record('readback_one', after); await writer.record('readback_two', after);
  return after;
}
describe('Clinic native local process custody; fictional observations and DB fence, not managed evidence', () => {
  it('publishes only a bound immutable header with complete original operator and baseline journal', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence); await writer.verify();
    expect(JSON.parse(readFileSync(lock(), 'utf8'))).toMatchObject({ purpose: 'clinic-source-qualification', binding: binding() });
    expect(readFileSync(file('.clinic.operator.cjs'), 'utf8')).toBe('FICTIONAL clinic operator');
    expect(readFileSync(journal(), 'utf8').endsWith('\n')).toBe(true);
  });
  it.each(['foreign fullscript operator', 'foreign generic operator'])('refuses existing shared lock %s', async value => {
    writeFileSync(lock(), value); await expect(createNativeClinicCustody(options(), binding(), observation(), fence)).rejects.toMatchObject({ stage: 'operator_active' });
    expect(readFileSync(lock(), 'utf8')).toBe(value);
  });
  it.each(['clinic-upgrade-reconciliation.lock', 'fullscript-upgrade-reconciliation.lock'])('refuses a preexisting %s', async name => {
    writeFileSync(join(root, name), 'foreign'); await expect(createNativeClinicCustody(options(), binding(), observation(), fence)).rejects.toMatchObject({ stage: 'recovery_active' });
    expect(existsSync(lock())).toBe(false);
  });
  it('refuses an operator digest not matching actual bytes before creating custody', async () => {
    const b = { ...binding(), operatorSha256: 'f'.repeat(64) };
    await expect(createNativeClinicCustody(options(), b, observation(b), fence)).rejects.toMatchObject({ stage: 'binding' });
    expect(existsSync(lock())).toBe(false);
  });
  it('refuses source changes and same-byte path replacement', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence);
    renameSync(operatorFile, operatorFile + '.old'); writeFileSync(operatorFile, 'FICTIONAL clinic operator');
    await expect(writer.verify()).rejects.toMatchObject({ stage: 'file_identity_changed' }); expect(existsSync(lock())).toBe(true);
  });
  it('refuses an oversize operator without publishing a lock', async () => {
    writeFileSync(operatorFile, Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(createNativeClinicCustody(options(), binding(), observation(), fence)).rejects.toMatchObject({ stage: 'file' });
    expect(existsSync(lock())).toBe(false);
  });
  it('cannot settle before all stages', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence);
    await expect(writer.settle(observation(binding(), 116))).rejects.toMatchObject({ stage: 'settlement' }); expect(existsSync(lock())).toBe(true);
  });
  it('refuses reordered journal stages before append', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence), before = readFileSync(journal());
    await expect(writer.record('write_admitted', observation())).rejects.toMatchObject({ stage: 'journal_order' });
    expect(readFileSync(journal()).equals(before)).toBe(true);
  });
  it('requires the exact baseline including definitions during rehearsal', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence);
    await expect(writer.record('rehearsal', { ...observation(), schemaSha256: 'f'.repeat(64) })).rejects.toMatchObject({ stage: 'predecessor_changed' });
  });
  it.each(['historicalDataSha256', 'historicalReceiptsSha256'] as const)('preserves entire historical %s at every successor stage', async field => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence); await admitted(writer);
    const after = observation(binding(), 116); after.witness[field] = 'f'.repeat(64);
    await expect(writer.record('write_reply', after)).rejects.toMatchObject({ stage: 'historical_rows_changed' });
  });
  it('requires identical full successor definitions on each readback', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence); await admitted(writer);
    await writer.record('write_reply', observation(binding(), 116));
    await expect(writer.record('readback_one', { ...observation(binding(), 116), schemaSha256: 'f'.repeat(64) })).rejects.toMatchObject({ stage: 'successor_changed' });
  });
  it('finding is terminal and never retires original custody', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence); await admitted(writer); await writer.finding();
    await expect(writer.record('write_reply', observation(binding(), 116))).rejects.toMatchObject({ stage: 'journal_terminal' }); expect(existsSync(lock())).toBe(true);
  });
  it('archives full settlement before lock retirement without promoting authority', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence), after = await complete(writer);
    const result = await writer.settle(after); expect(result.journalSha256).toBe(hash(readFileSync(journal())));
    expect(existsSync(lock())).toBe(false); expect(JSON.parse(readFileSync(file('.clinic.settled.json'), 'utf8'))).toMatchObject({
      evidenceLayer: 'local_process_custody_only', operatorAcceptance: false, phiAllowed: false, activation: 'blocked' });
  });
  it('a conflicting preexisting receipt refuses retirement', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence), after = await complete(writer);
    const h = JSON.parse(readFileSync(lock(), 'utf8')); writeFileSync(join(root, h.runId + '.clinic.settled.json'), 'foreign');
    await expect(writer.settle(after)).rejects.toThrow(); expect(existsSync(lock())).toBe(true);
  });
  it('cannot reconcile an actually live writer even after the interval', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); now += 61000;
    await expect(openNativeClinicRecovery(options(), binding(), fence)).rejects.toMatchObject({ stage: 'writer_active' });
  });
  it('cannot reconcile a recently stopped writer', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter(false);
    await expect(openNativeClinicRecovery(options(), binding(), fence)).rejects.toMatchObject({ stage: 'writer_settlement' });
  });
  it.each(['sourceCommit', 'targetSha256', 'profileSha256', 'sourceArtifactSha256'])('refuses original binding drift in %s', async key => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter();
    await expect(openNativeClinicRecovery(options(), { ...binding(), [key]: 'f'.repeat(key === 'sourceCommit' ? 40 : 64) }, fence)).rejects.toMatchObject({ stage: 'lock_binding' });
    expect(existsSync(lock())).toBe(true);
  });
  it('refuses foreign host', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter();
    const o = options(); o.runtime.host = 'foreign'; await expect(openNativeClinicRecovery(o, binding(), fence)).rejects.toMatchObject({ stage: 'lock_binding' });
  });
  it('refuses missing original header or changed source archive', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter();
    writeFileSync(file('.clinic.operator.cjs'), 'changed');
    await expect(openNativeClinicRecovery(options(), binding(), fence)).rejects.toMatchObject({ stage: 'original_archive' });
    expect(existsSync(lock())).toBe(true);
  });
  it('torn admission tail is archived intact and cannot create write authority', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence);
    appendFileSync(journal(), '{"stage":"write_admitted"'); const original = readFileSync(journal()); await stopWriter();
    const recovery = await openNativeClinicRecovery(options(), binding(), fence); expect(recovery.writeAdmitted).toBe(false);
    await expect(recovery.settle(observation(binding(), 116))).rejects.toMatchObject({ stage: 'unadmitted_successor' });
    await recovery.settle(observation()); expect(readFileSync(file('.clinic.original-journal.jsonl')).equals(original)).toBe(true);
  });
  it('refuses corrupt complete journal bytes', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter();
    const events = JSON.parse(readFileSync(journal(), 'utf8')); events.previousSha256 = 'f'.repeat(64);
    writeFileSync(journal(), canonicalClinicWorkflow(events) + '\n');
    await expect(openNativeClinicRecovery(options(), binding(), fence)).rejects.toMatchObject({ stage: 'journal_chain' });
  });
  it('refuses a live recovery guard and preserves it', async () => {
    const pid = await writerProcess(); const writer = await createNativeClinicCustody(options(pid), binding(), observation(), fence); await admitted(writer); await stopWriter();
    await openNativeClinicRecovery(options(), binding(), fence); const guard = join(root, 'clinic-upgrade-reconciliation.lock'), original = readFileSync(guard);
    await expect(openNativeClinicRecovery(options(), binding(), fence)).rejects.toThrow(); expect(readFileSync(guard).equals(original)).toBe(true);
  });
  it('refuses custody mutation during recovery', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter();
    const recovery = await openNativeClinicRecovery(options(), binding(), fence); writeFileSync(file('.clinic.header.json'), 'changed');
    await expect(recovery.verify()).rejects.toThrow(); expect(existsSync(lock())).toBe(true);
  });
  it('refuses same-byte lock replacement during recovery', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence); await stopWriter();
    const recovery = await openNativeClinicRecovery(options(), binding(), fence), original = readFileSync(lock()); unlinkSync(lock()); writeFileSync(lock(), original);
    await expect(recovery.verify()).rejects.toMatchObject({ stage: 'file_identity_changed' });
  });
  it('retains the original lock if fence fails after recovery guard retirement', async () => {
    const pid = await writerProcess(); const writer = await createNativeClinicCustody(options(pid), binding(), observation(), fence); await admitted(writer); await stopWriter();
    let failAfterGuard = false;
    const closingFence = { verify: async () => { if (failAfterGuard && !existsSync(join(root, 'clinic-upgrade-reconciliation.lock'))) throw Error('FICTIONAL fence lost'); } };
    const recovery = await openNativeClinicRecovery(options(), binding(), closingFence); failAfterGuard = true;
    await expect(recovery.settle(observation(binding(), 116))).rejects.toThrow('FICTIONAL fence lost'); expect(existsSync(lock())).toBe(true);
    expect(existsSync(join(root, 'clinic-upgrade-reconciliation.lock'))).toBe(false);
  });
  it('refuses replacement by a same-byte hard-linked operator', async () => {
    const writer = await createNativeClinicCustody(options(), binding(), observation(), fence);
    const substitute = join(root, 'substitute.cjs'); writeFileSync(substitute, 'FICTIONAL clinic operator');
    unlinkSync(operatorFile); linkSync(substitute, operatorFile);
    await expect(writer.verify()).rejects.toMatchObject({ stage: 'file_identity_changed' });
  });
  it.each(['.clinic.header.json', '.clinic.events.jsonl', '.clinic.operator.cjs'])('refuses archive mutation during publication fence for %s', async suffix => {
    let calls = 0;
    const mutatingFence = { verify: async () => { if (++calls === 2) writeFileSync(file(suffix), 'changed'); } };
    await expect(createNativeClinicCustody(options(), binding(), observation(), mutatingFence)).rejects.toThrow();
    expect(existsSync(lock())).toBe(false);
  });
  it('recovers an abandoned stopped recovery guard only with its exact immutable archive', async () => {
    const pid = await writerProcess(); const writer = await createNativeClinicCustody(options(pid), binding(), observation(), fence);
    await admitted(writer); await stopWriter(); const recoveryPid = await writerProcess();
    await openNativeClinicRecovery(options(recoveryPid), binding(), fence); await stopWriter();
    const recovered = await openNativeClinicRecovery(options(), binding(), fence);
    expect(readdirSync(root).filter(v => v.endsWith('.clinic.abandoned-guard.json'))).toHaveLength(1);
    await recovered.settle(observation(binding(), 116)); expect(existsSync(lock())).toBe(false);
  });
  it('refuses a stopped recovery guard when its archive is missing', async () => {
    const pid = await writerProcess(); await createNativeClinicCustody(options(pid), binding(), observation(), fence);
    await stopWriter(); const recoveryPid = await writerProcess();
    await openNativeClinicRecovery(options(recoveryPid), binding(), fence); await stopWriter();
    unlinkSync(file('.clinic.recovery-guard.json'));
    await expect(openNativeClinicRecovery(options(), binding(), fence)).rejects.toThrow();
    expect(existsSync(lock())).toBe(true); expect(existsSync(join(root, 'clinic-upgrade-reconciliation.lock'))).toBe(true);
  });
  it('recovery cannot substitute definitions for a successor already recorded in the original journal', async () => {
    const pid = await writerProcess(); const writer = await createNativeClinicCustody(options(pid), binding(), observation(), fence);
    await admitted(writer); await writer.record('write_reply', observation(binding(), 116)); await writer.finding(); await stopWriter();
    const recovery = await openNativeClinicRecovery(options(), binding(), fence);
    await expect(recovery.settle({ ...observation(binding(), 116), schemaSha256: 'f'.repeat(64) })).rejects.toThrow();
    expect(existsSync(lock())).toBe(true);
  });
});
