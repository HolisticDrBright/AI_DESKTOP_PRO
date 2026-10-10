if (typeof window !== 'undefined') throw Error('telehealth-consent-copy-native-custody is server-only');
import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readSync, writeFileSync, fsyncSync, lstatSync, fstatSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { FullscriptUpgradeError } from './fullscript-schema-upgrade';
import { parseTelehealthConsentCopy, type TelehealthConsentCopy, type TelehealthConsentCopyReceipt } from './telehealth-consent-copy-registration';
import type { RetainedTelehealthCopyObservation } from './telehealth-consent-copy-retained';
import { verifyTelehealthCopyReceipt, verifyRetainedTelehealthCopy } from './telehealth-consent-copy-command';
import type { TelehealthCopyBinding, TelehealthCopyStage, TelehealthCopyFence, TelehealthCopyRecovery, TelehealthCopyWriter, TelehealthCopyEvidence } from './telehealth-consent-copy-command';

// This is the existing shared routing/operator namespace, not a per-checkout
// namespace or an environment/CLI override. Live CLI construction uses only it.
export const TELEHEALTH_COPY_OPERATOR_SHARED_ROOT = 'C:/Users/Brand/Documents/Codex/2026-08-18/referenced-chatgpt-conversation-this-is-an/work/DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing';
type CopyCustodyStage = 'baseline' | TelehealthCopyStage;
type Options = { root: string; operatorFile: string; copyFile: string; runtime?: { pid: number; host: string; now: () => number } };
type Header = TelehealthCopyBinding & { contract: 'telehealth-copy-operator-lock/1'; purpose: 'qualification-telehealth-consent-copy';
  runId: string; pid: number; host: string; operatorSha256: string };
type Event = { stage: CopyCustodyStage | 'finding'; runId: string; at: string; previousSha256: string; observation: TelehealthCopyEvidence | null };
const stages: CopyCustodyStage[] = ['baseline', 'rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two'];
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
const fail = (stage: string): never => { throw new FullscriptUpgradeError('custody_refused', stage); };
const check = (v: unknown, stage: string) => { if (!v) fail(stage); };
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(v);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && same(Object.keys(v).sort(), [...keys].sort());
function bounded(file: string, maximum = 256 * 1024) {
  const before = lstatSync(file); check(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum, 'file');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    check(opened.ino === before.ino && opened.dev === before.dev && opened.size === before.size
      && opened.mtimeMs === before.mtimeMs, 'file_changed');
    // A file can grow after lstat. Never let that turn an initially admitted
    // journal/operator into an unbounded readFileSync allocation. One extra
    // byte detects growth; short descriptor reads must still be completed.
    const buffer = Buffer.alloc(before.size + 1); let received = 0;
    while (received < buffer.length) {
      const count = readSync(fd, buffer, received, buffer.length - received, received);
      if (!count) break; received += count;
    }
    const value = buffer.subarray(0, received), final = fstatSync(fd), after = lstatSync(file);
    check(final.ino === before.ino && final.dev === before.dev && final.size === before.size && final.mtimeMs === before.mtimeMs
      && after.ino === before.ino && after.dev === before.dev && after.size === before.size && after.mtimeMs === before.mtimeMs
      && !after.isSymbolicLink() && value.length === before.size, 'file_changed');
    return value;
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
function stopped(pid: number) {
  check(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid, 'writer_identity');
  try { process.kill(pid, 0); return false; } catch (e) {
    check((e as NodeJS.ErrnoException).code === 'ESRCH', 'writer_unknown'); return true;
  }
}
function directories(root: string) {
  const pins: { path: string; ino: number; dev: number }[] = [];
  for (let path = resolve(root); ; path = dirname(path)) {
    const s = lstatSync(path); check(s.isDirectory() && !s.isSymbolicLink(), 'directory');
    pins.push({ path, ino: s.ino, dev: s.dev }); if (dirname(path) === path) break;
  }
  return () => { for (const pin of pins) {
    const s = lstatSync(pin.path); check(s.isDirectory() && !s.isSymbolicLink() && s.ino === pin.ino && s.dev === pin.dev, 'directory_changed');
  } };
}
function observation(v: TelehealthCopyEvidence, command: 'inspect' | 'rehearse' | 'register' | 'retained', copy: TelehealthConsentCopy) {
  if (command === 'retained') verifyRetainedTelehealthCopy(v as RetainedTelehealthCopyObservation, copy);
  else verifyTelehealthCopyReceipt(v as TelehealthConsentCopyReceipt, command, copy);
}
function preserved(a: TelehealthCopyEvidence, b: TelehealthCopyEvidence) {
  check(a.artifactId === b.artifactId && a.contentSha256 === b.contentSha256, 'preservation');
}
function parseJournal(value: Buffer, header: Header, lockBytes: Buffer, now: number, copy: TelehealthConsentCopy) {
  const end = value.lastIndexOf(10); check(end >= 0, 'journal_prefix');
  const prefix = value.subarray(0, end + 1), tail = value.subarray(end + 1);
  check(tail.length < 16384 && Buffer.from(prefix.toString('utf8')).equals(prefix), 'journal_encoding');
  let events: Event[];
  try { events = prefix.toString('utf8').trimEnd().split('\n').map(s => JSON.parse(s)); } catch { return fail('journal_json'); }
  check(events.length >= 1 && events.length <= 7 && Buffer.concat(events.map(bytes)).equals(prefix), 'journal_fields');
  let prior = sha(lockBytes), at = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const e = events[i], time = Date.parse(e.at);
    check(exact(e, ['stage', 'runId', 'at', 'previousSha256', 'observation']) && e.runId === header.runId
      && e.previousSha256 === prior && Number.isFinite(time) && new Date(time).toISOString() === e.at && time >= at && time <= now, 'journal_chain');
    if (e.stage === 'finding') check(i === events.length - 1 && i > 0 && e.observation === null, 'journal_finding');
    else {
      check(e.stage === stages[i] && e.observation !== null, 'journal_order');
      const mode = e.stage === 'baseline' ? 'inspect' : e.stage.startsWith('readback') ? 'retained' : e.stage === 'write_reply' ? 'register' : 'rehearse';
      observation(e.observation!, mode, copy); preserved(e.observation!, events[0].observation!);
      const baselinePresent = events[0].observation!.copyPresent;
      if (i < 3) check(e.observation!.copyPresent === baselinePresent, 'journal_presence');
      else check(e.observation!.copyPresent === true, 'journal_presence');
      if (e.stage === 'write_reply') check((e.observation as TelehealthConsentCopyReceipt).copyInserted === !baselinePresent, 'write_reply');
    }
    prior = sha(bytes(e)); at = time;
  }
  const baseline = events[0].observation as TelehealthConsentCopyReceipt;
  return { events, tail, lastAt: at, baseline: structuredClone(baseline), writeAdmitted: events.some(e => e.stage === 'write_admitted') };
}
function context(options: Options, binding: TelehealthCopyBinding) {
  const root = resolve(options.root), verifyRoot = directories(root), runtime = options.runtime ?? { pid: process.pid, host: hostname(), now: Date.now };
  const operatorBytes = readTelehealthCopyOperatorFile(options.operatorFile, 16 * 1024 * 1024), operatorSha256 = sha(operatorBytes);
  const copyBytes = readTelehealthCopyOperatorFile(options.copyFile, 131072);
  check(sha(copyBytes) === binding.copySha256 && Buffer.from(copyBytes.toString('utf8')).equals(copyBytes), 'copy_binding');
  let raw: unknown; try { raw = JSON.parse(copyBytes.toString('utf8')); } catch { return fail('copy_json'); }
  check(Buffer.from(canonical(raw) + '\n').equals(copyBytes), 'copy_encoding');
  const copy = parseTelehealthConsentCopy(raw);
  const { content: _content, contract: _contract, ...copyBinding } = copy;
  check(same(copyBinding, binding.copy), 'copy_binding');
  check(binding.build.clean === true && /^[a-f0-9]{40}$/.test(binding.build.sourceCommit) && /^[a-f0-9]{64}$/.test(binding.callerSha256) && /^[a-f0-9]{64}$/.test(binding.targetSha256)
    && Number.isSafeInteger(runtime.pid) && runtime.pid > 0 && runtime.host.length > 0, 'binding');
  return { root, runtime, operatorBytes, operatorSha256, copyBytes, copy, verifyRoot, verifySource: () => {
    verifyRoot(); check(readTelehealthCopyOperatorFile(options.operatorFile, 16 * 1024 * 1024).equals(operatorBytes), 'operator_changed');
    check(readTelehealthCopyOperatorFile(options.copyFile, 131072).equals(copyBytes), 'copy_changed');
  } };
}
/** Complete immutable files precede atomic hard-link publication. A crash may
 * leave unused archives, but cannot publish a zero-byte shared operator lock.
 * This is process-interruption custody, not a claim about disk power-loss. */
export async function createNativeTelehealthCopyCustody(options: Options, supplied: TelehealthCopyBinding,
  initial: TelehealthConsentCopyReceipt, fence: TelehealthCopyFence): Promise<TelehealthCopyWriter> {
  const binding = structuredClone(supplied), baseline = structuredClone(initial), c = context(options, binding);
  await fence.verify(); observation(baseline, 'inspect', c.copy);
  const runId = randomBytes(16).toString('hex'), lock = resolve(c.root, 'operator.lock');
  check(!existsSync(lock), 'operator_active');
  check(!existsSync(resolve(c.root, 'telehealth-consent-copy-reconciliation.lock')), 'recovery_active');
  const header: Header = { contract: 'telehealth-copy-operator-lock/1', purpose: 'qualification-telehealth-consent-copy', runId,
    pid: c.runtime.pid, host: c.runtime.host, ...binding, operatorSha256: c.operatorSha256 };
  const lockBytes = bytes(header), headerFile = resolve(c.root, runId + '.inventory-header.json'), journal = resolve(c.root, runId + '.telehealth-copy.events.jsonl');
  const first: Event = { stage: 'baseline', runId, at: new Date(c.runtime.now()).toISOString(), previousSha256: sha(lockBytes), observation: baseline };
  let journalBytes = bytes(first), live = true;
  save(resolve(c.root, runId + '.telehealth-copy.operator.cjs'), c.operatorBytes);
  save(resolve(c.root, runId + '.telehealth-copy.original.json'), c.copyBytes);
  save(headerFile, lockBytes); save(journal, journalBytes);
  c.verifySource(); await fence.verify(); linkSync(headerFile, lock);
  const verify = async () => { await fence.verify(); c.verifySource(); check(live && bounded(lock, 16384).equals(lockBytes)
    && bounded(headerFile, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes)
    && bounded(resolve(c.root, runId + '.telehealth-copy.operator.cjs'), 16 * 1024 * 1024).equals(c.operatorBytes)
    && bounded(resolve(c.root, runId + '.telehealth-copy.original.json'), 131072).equals(c.copyBytes), 'custody_changed'); };
  const record = async (stage: CopyCustodyStage | 'finding', value: TelehealthCopyEvidence | null) => {
    await verify(); const parsed = parseJournal(journalBytes, header, lockBytes, c.runtime.now(), c.copy);
    check(parsed.tail.length === 0 && parsed.events.at(-1)?.stage !== 'finding', 'journal_terminal');
    const next: Event = { stage, runId, at: new Date(c.runtime.now()).toISOString(), previousSha256: sha(bytes(parsed.events.at(-1))),
      observation: value === null ? null : structuredClone(value) };
    const candidate = Buffer.concat([journalBytes, bytes(next)]); parseJournal(candidate, header, lockBytes, c.runtime.now(), c.copy);
    const before = lstatSync(journal);
    const fd = openSync(journal, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      check(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev
        && opened.size === journalBytes.length && !before.isSymbolicLink(), 'journal_changed');
      writeFileSync(fd, bytes(next)); fsyncSync(fd);
    } finally { closeSync(fd); }
    journalBytes = candidate; await verify();
  };
  return { verify, record: (stage, value) => record(stage, value), finding: () => record('finding', null), settle: async value => {
    await verify(); observation(value, 'register', c.copy); preserved(value, baseline);
    const parsed = parseJournal(journalBytes, header, lockBytes, c.runtime.now(), c.copy);
    check(parsed.tail.length === 0 && same(parsed.events.map(e => e.stage), stages)
      && same(parsed.events[3].observation, value), 'settlement');
    const receipt = { contract: 'telehealth-copy-custody-settlement/1', runId, operatorSha256: c.operatorSha256,
      journalSha256: sha(journalBytes), before: baseline, after: structuredClone(value), phiAllowed: false, activation: 'blocked' };
    save(resolve(c.root, runId + '.telehealth-copy.settled.json'), bytes(receipt));
    archive(resolve(c.root, runId + '.telehealth-copy.settled-lock.json'), lockBytes);
    await verify(); unlinkSync(lock); live = false;
    return { runId, journalSha256: sha(journalBytes), custodySettled: true };
  } };
}

/** Frozen original operator and original exact lock/journal bytes are mandatory.
 * A torn final event is archived intact; it never creates write authority. */
export async function openNativeTelehealthCopyRecovery(options: Options, supplied: TelehealthCopyBinding,
  fence: TelehealthCopyFence): Promise<TelehealthCopyRecovery> {
  const binding = structuredClone(supplied), c = context(options, binding); await fence.verify();
  const lock = resolve(c.root, 'operator.lock'), lockBytes = bounded(lock, 16384);
  let h: Header; try { h = JSON.parse(lockBytes.toString('utf8')); } catch { return fail('lock_json'); }
  check(exact(h, ['contract', 'purpose', 'runId', 'pid', 'host', 'build', 'configuration', 'callerSha256', 'targetSha256', 'operatorSha256', 'copySha256', 'copy'])
    && h.contract === 'telehealth-copy-operator-lock/1' && h.purpose === 'qualification-telehealth-consent-copy'
    && /^[a-f0-9]{32}$/.test(h.runId) && h.host === c.runtime.host && same(h.build, binding.build)
    && h.targetSha256 === binding.targetSha256 && same(h.configuration, binding.configuration) && /^[a-f0-9]{64}$/.test(h.callerSha256)
    && h.copySha256 === binding.copySha256 && same(h.copy, binding.copy)
    && h.operatorSha256 === c.operatorSha256 && bytes(h).equals(lockBytes), 'lock_binding');
  check(stopped(h.pid), 'writer_active');
  const journal = resolve(c.root, h.runId + '.telehealth-copy.events.jsonl'), journalBytes = bounded(journal);
  const parsed = parseJournal(journalBytes, h, lockBytes, c.runtime.now(), c.copy);
  check(c.runtime.now() - parsed.lastAt >= 60000, 'writer_settlement');
  check(bounded(resolve(c.root, h.runId + '.inventory-header.json'), 16384).equals(lockBytes)
    && bounded(resolve(c.root, h.runId + '.telehealth-copy.operator.cjs'), 16 * 1024 * 1024).equals(c.operatorBytes)
    && bounded(resolve(c.root, h.runId + '.telehealth-copy.original.json'), 131072).equals(c.copyBytes), 'original_archive');
  const guard = resolve(c.root, 'telehealth-consent-copy-reconciliation.lock');
  // Native callers hold the DB fence for all local retirement/publication.
  // A live/foreign/changed guard is never deleted or replaced.
  if (existsSync(guard)) {
    const oldBytes = bounded(guard, 16384); let old: Record<string, unknown>;
    try { old = JSON.parse(oldBytes.toString('utf8')); } catch { return fail('guard_json'); }
    check(exact(old, ['contract', 'id', 'pid', 'host', 'runId', 'operatorSha256', 'journalSha256', 'at'])
      && old.contract === 'telehealth-copy-reconciliation-guard/1' && old.runId === h.runId && old.host === c.runtime.host
      && typeof old.id === 'string' && /^[a-f0-9]{32}$/.test(old.id) && old.operatorSha256 === c.operatorSha256
      && old.journalSha256 === sha(journalBytes) && bytes(old).equals(oldBytes)
      && typeof old.at === 'string' && Number.isFinite(Date.parse(old.at)) && c.runtime.now() - Date.parse(old.at) >= 60000
      && stopped(old.pid as number), 'guard_active_or_foreign');
    archive(resolve(c.root, old.id + '.telehealth-copy.abandoned-reconciliation-guard.json'), oldBytes);
    await fence.verify(); check(bounded(guard, 16384).equals(oldBytes), 'guard_changed'); unlinkSync(guard);
  }
  const guardId = randomBytes(16).toString('hex'), guardBytes = bytes({ contract: 'telehealth-copy-reconciliation-guard/1', id: guardId,
    pid: c.runtime.pid, host: c.runtime.host, runId: h.runId, operatorSha256: c.operatorSha256, journalSha256: sha(journalBytes), at: new Date(c.runtime.now()).toISOString() });
  const guardHeader = resolve(c.root, guardId + '.telehealth-copy.reconciliation-guard.json'); save(guardHeader, guardBytes);
  await fence.verify(); check(bounded(lock, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes), 'custody_changed'); linkSync(guardHeader, guard);
  let live = true;
  const verify = async () => { await fence.verify(); c.verifySource(); check(live && stopped(h.pid)
    && bounded(lock, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes)
    && bounded(guard, 16384).equals(guardBytes) && bounded(guardHeader, 16384).equals(guardBytes)
    && bounded(resolve(c.root, h.runId + '.telehealth-copy.operator.cjs'), 16 * 1024 * 1024).equals(c.operatorBytes)
    && bounded(resolve(c.root, h.runId + '.telehealth-copy.original.json'), 131072).equals(c.copyBytes), 'recovery_changed'); };
  return { baseline: structuredClone(parsed.baseline), writeAdmitted: parsed.writeAdmitted, verify, settle: async value => {
    await verify(); observation(value, 'retained', c.copy); preserved(value, parsed.baseline);
    check(!parsed.baseline.copyPresent || value.copyPresent, 'baseline_disappeared');
    check(!parsed.events.some(e => (e.stage === 'write_reply' || e.stage.startsWith('readback')) && e.observation?.copyPresent)
      || value.copyPresent, 'observed_copy_disappeared');
    check(parsed.writeAdmitted || value.copyPresent === parsed.baseline.copyPresent, 'unadmitted_copy');
    const receipt = { contract: 'telehealth-copy-custody-reconciliation/1', runId: h.runId, originalWriteOutcome: 'unknown',
      currentCallerSha256: binding.callerSha256, operatorSha256: c.operatorSha256, originalJournalSha256: sha(journalBytes),
      tornJournalTail: parsed.tail.length > 0, before: parsed.baseline, after: structuredClone(value),
      retryPerformed: false, databaseMutationPerformed: false, approvalAuthorityCertified: false, deletionCertified: false, phiAllowed: false, activation: 'blocked' };
    archive(resolve(c.root, guardId + '.telehealth-copy.reconciled.json'), bytes(receipt));
    archive(resolve(c.root, h.runId + '.telehealth-copy.reconciled-lock.json'), lockBytes);
    // Retire the subsidiary guard first while still holding the database fence.
    // If interrupted, the original lock remains available for another read-only
    // reconciliation. Never leave a guard whose original lock was deleted.
    await verify(); unlinkSync(guard);
    await fence.verify(); c.verifySource();
    check(bounded(lock, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes), 'custody_changed');
    unlinkSync(lock); live = false;
    return { runId: h.runId, journalSha256: sha(journalBytes), custodySettled: true, originalWriteOutcome: 'unknown' };
  } };
}


export function readTelehealthCopyOperatorFile(file: string, maximum = 16384) {
  const verifyDirectories=directories(dirname(resolve(file))); verifyDirectories();
  const bytes=bounded(resolve(file),maximum); verifyDirectories(); return bytes;
}
