if (typeof window !== 'undefined') throw Error('clinic-native-custody is server-only');
import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readSync, writeFileSync, fsyncSync, lstatSync, fstatSync,
  linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';
import { assertClinicHistoricalRowsAtPrefixPreserved } from '../../../scripts/clinic-row-preservation.mjs';
import { assertClinicWorkflowObservation, canonicalClinicWorkflow, clinicWorkflowSha256,
  type ClinicWorkflowBinding, type ClinicWorkflowObservation, type ClinicWorkflowStage,
  type ClinicWorkflowFence, type ClinicWorkflowWriter, type ClinicWorkflowRecovery } from './clinic-preserving-workflow';

// Shared with the existing operators. There is deliberately no live CLI or
// environment override. Injected roots/runtime are for local qualification.
export const CLINIC_OPERATOR_SHARED_ROOT = 'C:/Users/Brand/Documents/Codex/2026-08-18/referenced-chatgpt-conversation-this-is-an/work/DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing';
type Options = { root?: string; operatorFile: string; runtime?: { pid: number; host: string; now(): number } };
type Header = { contract: 'clinic-native-lock/1'; purpose: 'clinic-source-qualification'; runId: string;
  pid: number; host: string; binding: ClinicWorkflowBinding };
type Event = { stage: 'baseline' | ClinicWorkflowStage | 'finding'; runId: string; at: string;
  previousSha256: string; observation: ClinicWorkflowObservation | null };
type Guard = { contract: 'clinic-native-recovery-guard/1'; id: string; pid: number; host: string;
  runId: string; bindingSha256: string; journalSha256: string; at: string };
const stages = ['baseline', 'rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two'] as const;
const sha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const bytes = (v: unknown) => Buffer.from(canonicalClinicWorkflow(v) + '\n');
const same = (a: unknown, b: unknown) => canonicalClinicWorkflow(a) === canonicalClinicWorkflow(b);
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v)
  && same(Object.keys(v).sort(), [...keys].sort());
export class ClinicNativeCustodyError extends Error {
  readonly category = 'custody_refused';
  constructor(readonly stage: string) { super('clinic_native_custody_refused:' + stage); }
}
function check(v: unknown, stage: string): asserts v { if (!v) throw new ClinicNativeCustodyError(stage); }

/** Descriptor-bounded reads with pathname identity checks before and after.
 * Power-loss durability and a hostile local administrator are not certified. */
function bounded(file: string, maximum = 256 * 1024) {
  const before = lstatSync(file);
  check(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum, 'file');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    check(opened.ino === before.ino && opened.dev === before.dev && opened.size === before.size
      && opened.mtimeMs === before.mtimeMs, 'file_changed');
    const buffer = Buffer.alloc(before.size + 1); let received = 0;
    while (received < buffer.length) {
      const n = readSync(fd, buffer, received, buffer.length - received, received);
      if (!n) break; received += n;
    }
    const final = fstatSync(fd), after = lstatSync(file);
    check(final.ino === before.ino && final.dev === before.dev && final.size === before.size && final.mtimeMs === before.mtimeMs
      && after.isFile() && !after.isSymbolicLink() && after.ino === before.ino && after.dev === before.dev
      && after.size === before.size && after.mtimeMs === before.mtimeMs && received === before.size, 'file_changed');
    return buffer.subarray(0, received);
  } finally { closeSync(fd); }
}
function save(file: string, value: Buffer) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  check(bounded(file, Math.max(value.length, 16384)).equals(value), 'archive_readback');
}
function archive(file: string, value: Buffer) {
  if (existsSync(file)) check(bounded(file, Math.max(value.length, 16384)).equals(value), 'archive_conflict');
  else save(file, value);
}
function directories(root: string) {
  const pins: { path: string; ino: number; dev: number }[] = [];
  for (let path = resolve(root); ; path = dirname(path)) {
    const s = lstatSync(path); check(s.isDirectory() && !s.isSymbolicLink(), 'directory');
    pins.push({ path, ino: s.ino, dev: s.dev }); if (dirname(path) === path) break;
  }
  return () => { for (const pin of pins) {
    const s = lstatSync(pin.path);
    check(s.isDirectory() && !s.isSymbolicLink() && s.ino === pin.ino && s.dev === pin.dev, 'directory_changed');
  } };
}
function identity(file: string) {
  const original = lstatSync(file); check(original.isFile() && !original.isSymbolicLink(), 'file_identity');
  return () => { const s = lstatSync(file);
    check(s.isFile() && !s.isSymbolicLink() && s.ino === original.ino && s.dev === original.dev, 'file_identity_changed'); };
}
function stopped(pid: number) {
  check(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'writer_identity');
  try { process.kill(pid, 0); return false; }
  catch (error) { check((error as NodeJS.ErrnoException).code === 'ESRCH', 'writer_unknown'); return true; }
}
function preserved(before: ClinicWorkflowObservation, after: ClinicWorkflowObservation) {
  if (after.witness.observedMigrationCount === 112) check(same(before, after), 'predecessor_changed');
  else {
    try { assertClinicHistoricalRowsAtPrefixPreserved(before.witness, after.witness, 116); }
    catch { check(false, 'historical_rows_changed'); }
  }
}
function context(options: Options, binding: ClinicWorkflowBinding) {
  const root = resolve(options.root ?? CLINIC_OPERATOR_SHARED_ROOT), verifyRoot = directories(root);
  const operator = resolve(options.operatorFile), verifyOperatorDirectory = directories(dirname(operator));
  const suppliedRuntime = options.runtime ?? { pid: process.pid, host: hostname(), now: Date.now };
  const runtime = { pid: suppliedRuntime.pid, host: suppliedRuntime.host, now: suppliedRuntime.now.bind(suppliedRuntime) };
  const operatorBytes = bounded(operator, 16 * 1024 * 1024), verifyOperatorIdentity = identity(operator);
  check(exact(binding, ['contract', 'execution', 'sourceCommit', 'operatorSha256', 'sourceArtifactSha256',
    'independentReceiptSha256', 'targetSha256', 'profileSha256', 'phiAllowed', 'activation'])
    && binding.contract === 'clinic-preserving-workflow-binding/1' && binding.execution === 'injected_protocol_qualification'
    && /^[a-f0-9]{40}$/.test(binding.sourceCommit)
    && ['operatorSha256', 'sourceArtifactSha256', 'targetSha256', 'profileSha256'].every(k => /^[a-f0-9]{64}$/.test(binding[k as keyof ClinicWorkflowBinding] as string))
    && binding.operatorSha256 === sha(operatorBytes) && binding.independentReceiptSha256 === CLINIC_NATIVE_SOURCE_RECEIPT_SHA256
    && binding.phiAllowed === false && binding.activation === 'blocked'
    && Number.isSafeInteger(runtime.pid) && runtime.pid > 0 && typeof runtime.host === 'string' && runtime.host.length > 0
    && runtime.host.length <= 255 && Number.isFinite(runtime.now()), 'binding');
  return { root, runtime, operatorBytes, verifySource: () => {
    verifyRoot(); verifyOperatorDirectory(); verifyOperatorIdentity();
    check(bounded(operator, 16 * 1024 * 1024).equals(operatorBytes), 'operator_changed');
  } };
}
function parseJournal(value: Buffer, h: Header, lockBytes: Buffer, now: number) {
  const end = value.lastIndexOf(10); check(end >= 0, 'journal_prefix');
  const prefix = value.subarray(0, end + 1), tail = value.subarray(end + 1);
  check(tail.length < 16384 && Buffer.from(prefix.toString('utf8')).equals(prefix), 'journal_encoding');
  let events: Event[];
  try { events = prefix.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)); }
  catch { throw new ClinicNativeCustodyError('journal_json'); }
  check(events.length >= 1 && events.length <= 7 && Buffer.concat(events.map(bytes)).equals(prefix), 'journal_fields');
  let prior = sha(lockBytes), time = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const e = events[i], at = Date.parse(e.at);
    check(exact(e, ['stage', 'runId', 'at', 'previousSha256', 'observation']) && e.runId === h.runId && e.previousSha256 === prior
      && Number.isFinite(at) && new Date(at).toISOString() === e.at && at >= time && at <= now, 'journal_chain');
    if (e.stage === 'finding') check(i > 0 && i === events.length - 1 && e.observation === null, 'journal_finding');
    else {
      check(e.stage === stages[i] && e.observation !== null, 'journal_order');
      assertClinicWorkflowObservation(e.observation, h.binding);
      check(e.observation.witness.observedMigrationCount === (i < 3 ? 112 : 116), 'journal_prefix_count');
      if (i > 0) preserved(events[0].observation!, e.observation);
      if (i > 3) check(same(events[3].observation, e.observation), 'successor_changed');
    }
    prior = sha(bytes(e)); time = at;
  }
  return { events, tail, lastAt: time, baseline: structuredClone(events[0].observation!),
    writeAdmitted: events.some(e => e.stage === 'write_admitted') };
}

/** Real local files/process liveness; injected DB fence and observation remain
 * source qualification. No managed admission, activation or live command. */
export async function createNativeClinicCustody(options: Options, supplied: ClinicWorkflowBinding,
  initial: ClinicWorkflowObservation, fence: ClinicWorkflowFence): Promise<ClinicWorkflowWriter> {
  const binding = structuredClone(supplied), baseline = structuredClone(initial), c = context(options, binding);
  await fence.verify(); c.verifySource(); assertClinicWorkflowObservation(baseline, binding);
  check(baseline.witness.observedMigrationCount === 112, 'baseline');
  const runId = randomBytes(16).toString('hex'), lock = resolve(c.root, 'operator.lock');
  check(!existsSync(lock), 'operator_active');
  check(!existsSync(resolve(c.root, 'clinic-upgrade-reconciliation.lock'))
    && !existsSync(resolve(c.root, 'fullscript-upgrade-reconciliation.lock')), 'recovery_active');
  const h: Header = { contract: 'clinic-native-lock/1', purpose: 'clinic-source-qualification', runId,
    pid: c.runtime.pid, host: c.runtime.host, binding };
  const lockBytes = bytes(h), headerFile = resolve(c.root, runId + '.clinic.header.json');
  const journal = resolve(c.root, runId + '.clinic.events.jsonl'), sourceFile = resolve(c.root, runId + '.clinic.operator.cjs');
  let journalBytes = bytes({ stage: 'baseline', runId, at: new Date(c.runtime.now()).toISOString(), previousSha256: sha(lockBytes), observation: baseline }), live = true;
  save(sourceFile, c.operatorBytes); save(headerFile, lockBytes); save(journal, journalBytes);
  const archivePins = [sourceFile, headerFile, journal].map(identity);
  await fence.verify(); c.verifySource(); archivePins.forEach(v => v());
  check(bounded(sourceFile, 16 * 1024 * 1024).equals(c.operatorBytes) && bounded(headerFile, 16384).equals(lockBytes)
    && bounded(journal).equals(journalBytes), 'publication_archive_changed');
  check(!existsSync(resolve(c.root, 'clinic-upgrade-reconciliation.lock'))
    && !existsSync(resolve(c.root, 'fullscript-upgrade-reconciliation.lock')), 'recovery_active');
  linkSync(headerFile, lock);
  const verifyIdentities = [lock, headerFile, journal, sourceFile].map(identity);
  const verifyLocal = () => {
    c.verifySource(); verifyIdentities.forEach(v => v());
    check(live && bounded(lock, 16384).equals(lockBytes) && bounded(headerFile, 16384).equals(lockBytes)
      && bounded(journal).equals(journalBytes) && bounded(sourceFile, 16 * 1024 * 1024).equals(c.operatorBytes), 'custody_changed');
  };
  const verify = async () => { await fence.verify(); verifyLocal(); };
  let prepared = false;
  const record = async (stage: Event['stage'], value: ClinicWorkflowObservation | null) => {
    await verify(); check(!prepared, 'settlement_prepared'); const parsed = parseJournal(journalBytes, h, lockBytes, c.runtime.now());
    check(parsed.tail.length === 0 && parsed.events.at(-1)?.stage !== 'finding', 'journal_terminal');
    const next: Event = { stage, runId, at: new Date(c.runtime.now()).toISOString(), previousSha256: sha(bytes(parsed.events.at(-1))),
      observation: value === null ? null : structuredClone(value) };
    const candidate = Buffer.concat([journalBytes, bytes(next)]); parseJournal(candidate, h, lockBytes, c.runtime.now());
    const before = lstatSync(journal), fd = openSync(journal, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      check(!before.isSymbolicLink() && opened.isFile() && opened.ino === before.ino && opened.dev === before.dev
        && opened.size === journalBytes.length, 'journal_changed');
      writeFileSync(fd, bytes(next)); fsyncSync(fd);
    } finally { closeSync(fd); }
    journalBytes = candidate; await verify();
  };
  return { verify, record: (stage, value) => record(stage, value), finding: () => record('finding', null), settle: async value => {
    const after = structuredClone(value); await verify(); check(!prepared, 'settlement_prepared'); assertClinicWorkflowObservation(after, binding); preserved(baseline, after);
    const parsed = parseJournal(journalBytes, h, lockBytes, c.runtime.now());
    check(parsed.tail.length === 0 && same(parsed.events.map(e => e.stage), stages) && same(parsed.events[3].observation, after), 'settlement');
    const receipt = { contract: 'clinic-native-settlement/2', retirement: 'prepared_only', runId, bindingSha256: clinicWorkflowSha256(binding),
      journalSha256: sha(journalBytes), before: baseline, after, evidenceLayer: 'local_process_custody_only',
      managedRoleSemanticsVerified: false, operatorAcceptance: false, phiAllowed: false, activation: 'blocked' };
    const receiptFile = resolve(c.root, runId + '.clinic.settled.json'), lockArchive = resolve(c.root, runId + '.clinic.settled-lock.json');
    const receiptBytes = bytes(receipt);
    save(receiptFile, receiptBytes); archive(lockArchive, lockBytes);
    const receiptPins = [receiptFile, lockArchive].map(identity);
    await verify(); prepared = true;
    return { runId, journalSha256: sha(journalBytes), retire: async () => {
      verifyLocal(); receiptPins.forEach(pin => pin());
      check(prepared && bounded(receiptFile).equals(receiptBytes) && bounded(lockArchive, 16384).equals(lockBytes), 'prepared_receipt_changed');
      unlinkSync(lock); live = false;
    } };
  } };
}

/** Read-only recovery requires the exact stopped writer and original archives.
 * Torn tails remain bytes, never admission events. Local locks retire only after
 * the caller's three observations and this immutable settlement receipt. */
export async function openNativeClinicRecovery(options: Options, supplied: ClinicWorkflowBinding,
  fence: ClinicWorkflowFence): Promise<ClinicWorkflowRecovery> {
  const binding = structuredClone(supplied), c = context(options, binding); await fence.verify(); c.verifySource();
  const lock = resolve(c.root, 'operator.lock'), lockBytes = bounded(lock, 16384);
  let h: Header; try { h = JSON.parse(lockBytes.toString('utf8')); } catch { throw new ClinicNativeCustodyError('lock_json'); }
  check(exact(h, ['contract', 'purpose', 'runId', 'pid', 'host', 'binding']) && h.contract === 'clinic-native-lock/1'
    && h.purpose === 'clinic-source-qualification' && /^[a-f0-9]{32}$/.test(h.runId) && h.host === c.runtime.host
    && same(h.binding, binding) && bytes(h).equals(lockBytes), 'lock_binding');
  check(stopped(h.pid), 'writer_active');
  const headerFile = resolve(c.root, h.runId + '.clinic.header.json'), sourceFile = resolve(c.root, h.runId + '.clinic.operator.cjs');
  const journal = resolve(c.root, h.runId + '.clinic.events.jsonl'), journalBytes = bounded(journal);
  const parsed = parseJournal(journalBytes, h, lockBytes, c.runtime.now());
  check(c.runtime.now() - parsed.lastAt >= 60000, 'writer_settlement');
  check(bounded(headerFile, 16384).equals(lockBytes) && bounded(sourceFile, 16 * 1024 * 1024).equals(c.operatorBytes), 'original_archive');
  const originalPins = [lock, headerFile, sourceFile, journal].map(identity);
  const original = () => { c.verifySource(); originalPins.forEach(v => v());
    check(stopped(h.pid) && bounded(lock, 16384).equals(lockBytes) && bounded(headerFile, 16384).equals(lockBytes)
      && bounded(journal).equals(journalBytes) && bounded(sourceFile, 16 * 1024 * 1024).equals(c.operatorBytes), 'recovery_changed'); };
  const guard = resolve(c.root, 'clinic-upgrade-reconciliation.lock');
  check(!existsSync(resolve(c.root, 'fullscript-upgrade-reconciliation.lock')), 'foreign_recovery_active');
  if (existsSync(guard)) {
    const oldBytes = bounded(guard, 16384); let old: Guard;
    try { old = JSON.parse(oldBytes.toString('utf8')); } catch { throw new ClinicNativeCustodyError('guard_json'); }
    check(exact(old, ['contract', 'id', 'pid', 'host', 'runId', 'bindingSha256', 'journalSha256', 'at'])
      && old.contract === 'clinic-native-recovery-guard/1' && /^[a-f0-9]{32}$/.test(old.id) && old.host === c.runtime.host
      && old.runId === h.runId && old.bindingSha256 === clinicWorkflowSha256(binding) && old.journalSha256 === sha(journalBytes)
      && bytes(old).equals(oldBytes) && Number.isFinite(Date.parse(old.at)) && new Date(Date.parse(old.at)).toISOString() === old.at
      && c.runtime.now() - Date.parse(old.at) >= 60000 && stopped(old.pid), 'guard_active_or_foreign');
    check(bounded(resolve(c.root, old.id + '.clinic.recovery-guard.json'), 16384).equals(oldBytes), 'guard_archive');
    archive(resolve(c.root, old.id + '.clinic.abandoned-guard.json'), oldBytes);
    await fence.verify(); original(); check(bounded(guard, 16384).equals(oldBytes), 'guard_changed'); unlinkSync(guard);
  }
  const guardId = randomBytes(16).toString('hex'), guardHeader = resolve(c.root, guardId + '.clinic.recovery-guard.json');
  const guardBytes = bytes({ contract: 'clinic-native-recovery-guard/1', id: guardId, pid: c.runtime.pid, host: c.runtime.host,
    runId: h.runId, bindingSha256: clinicWorkflowSha256(binding), journalSha256: sha(journalBytes), at: new Date(c.runtime.now()).toISOString() });
  save(guardHeader, guardBytes); const guardArchivePin = identity(guardHeader);
  await fence.verify(); original(); guardArchivePin();
  check(bounded(guardHeader, 16384).equals(guardBytes), 'guard_archive_changed'); linkSync(guardHeader, guard);
  const guardPins = [guard, guardHeader].map(identity); let live = true;
  const verifyLocal = () => { original(); guardPins.forEach(v => v());
    check(live && bounded(guard, 16384).equals(guardBytes) && bounded(guardHeader, 16384).equals(guardBytes), 'guard_changed'); };
  const verify = async () => { await fence.verify(); verifyLocal(); };
  let prepared = false;
  return { baseline: structuredClone(parsed.baseline), writeAdmitted: parsed.writeAdmitted, verify, settle: async value => {
    const after = structuredClone(value); await verify(); check(!prepared, 'settlement_prepared'); assertClinicWorkflowObservation(after, binding); preserved(parsed.baseline, after);
    check(parsed.writeAdmitted || after.witness.observedMigrationCount === 112, 'unadmitted_successor');
    const returnedSuccessor = parsed.events.find(e => e.stage === 'write_reply')?.observation;
    check(!returnedSuccessor || same(returnedSuccessor, after), 'recorded_successor_changed');
    const receipt = { contract: 'clinic-native-reconciliation/2', retirement: 'prepared_only', runId: h.runId, bindingSha256: clinicWorkflowSha256(binding),
      originalWriteOutcome: 'unknown', journalSha256: sha(journalBytes), tornJournalTail: parsed.tail.length > 0,
      before: parsed.baseline, after, retryPerformed: false, databaseMutationPerformed: false,
      evidenceLayer: 'local_process_custody_only', operatorAcceptance: false, managedRoleSemanticsVerified: false,
      phiAllowed: false, activation: 'blocked' };
    const receiptFile = resolve(c.root, guardId + '.clinic.reconciled.json'), lockArchive = resolve(c.root, h.runId + '.clinic.reconciled-lock.json');
    const journalArchive = resolve(c.root, guardId + '.clinic.original-journal.jsonl'), receiptBytes = bytes(receipt);
    archive(receiptFile, receiptBytes); archive(lockArchive, lockBytes); archive(journalArchive, journalBytes);
    const receiptPins = [receiptFile, lockArchive, journalArchive].map(identity);
    await verify(); prepared = true;
    return { runId: h.runId, journalSha256: sha(journalBytes), retire: async () => {
      verifyLocal(); receiptPins.forEach(pin => pin());
      check(prepared && bounded(receiptFile).equals(receiptBytes) && bounded(lockArchive, 16384).equals(lockBytes)
        && bounded(journalArchive).equals(journalBytes), 'prepared_receipt_changed');
      // No await or database work between local guard and original retirement.
      // If unlinking the original fails, its exact archive and lock remain for
      // explicit read-only recovery; never delete the original first.
      unlinkSync(guard); original(); unlinkSync(lock); live = false;
    } };
  } };
}
