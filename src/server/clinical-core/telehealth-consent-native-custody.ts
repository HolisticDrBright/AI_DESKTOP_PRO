import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readSync, writeFileSync, fsyncSync, lstatSync, fstatSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { FullscriptUpgradeError } from './fullscript-schema-upgrade';
import type { TelehealthConsentUpgradeResult } from './telehealth-consent-schema-upgrade';
import { verifyTelehealthConsentUpgradeObservation, telehealthConsentParentCount } from './telehealth-consent-upgrade-command';
import type { TelehealthConsentCustodyBinding, TelehealthConsentCustodyStage, TelehealthConsentOperatorFence, TelehealthConsentRecoveryCustody, TelehealthConsentWriterCustody } from './telehealth-consent-upgrade-command';

// This is the existing shared routing/operator namespace, not a per-checkout
// namespace or an environment/CLI override. Live CLI construction uses only it.
export const TELEHEALTH_CONSENT_OPERATOR_SHARED_ROOT = 'C:/Users/Brand/Documents/Codex/2026-08-18/referenced-chatgpt-conversation-this-is-an/work/DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing';
type Options = { root: string; operatorFile: string; runtime?: { pid: number; host: string; now: () => number } };
type Header = TelehealthConsentCustodyBinding & { contract: 'telehealth-consent-operator-lock/1'; purpose: 'qualification-telehealth-consent-upgrade';
  runId: string; pid: number; host: string; operatorSha256: string };
type Event = { stage: TelehealthConsentCustodyStage | 'finding'; runId: string; at: string; previousSha256: string; observation: TelehealthConsentUpgradeResult | null };
const stages: TelehealthConsentCustodyStage[] = ['baseline', 'rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two'];
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
function observation(v: TelehealthConsentUpgradeResult, command: TelehealthConsentUpgradeResult['command']) {
  verifyTelehealthConsentUpgradeObservation(v, command);
}
function preserved(a: TelehealthConsentUpgradeResult, b: TelehealthConsentUpgradeResult) {
  check(a.rowCount === b.rowCount && a.dataSha256 === b.dataSha256 && a.historicalSchemaSha256 === b.historicalSchemaSha256, 'preservation');
}
function parseJournal(value: Buffer, header: Header, lockBytes: Buffer, now: number) {
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
      const mode = e.stage === 'baseline' || e.stage.startsWith('readback') ? 'inspect-settled' : e.stage === 'write_reply' ? 'upgrade' : 'rehearse';
      observation(e.observation!, mode); preserved(e.observation!, events[0].observation!);
      check(e.observation!.observedMigrationCount === (i < 3 ? telehealthConsentParentCount(header.configuration) : 112), 'journal_ledger');
      if (e.stage === 'write_reply') check(e.observation!.applied, 'write_reply');
    }
    prior = sha(bytes(e)); at = time;
  }
  const baseline = events[0].observation!; check(baseline.observedMigrationCount === telehealthConsentParentCount(header.configuration), 'baseline');
  return { events, tail, lastAt: at, baseline: structuredClone(baseline), writeAdmitted: events.some(e => e.stage === 'write_admitted') };
}
function context(options: Options, binding: TelehealthConsentCustodyBinding) {
  const root = resolve(options.root), verifyRoot = directories(root), runtime = options.runtime ?? { pid: process.pid, host: hostname(), now: Date.now };
  const operatorBytes = bounded(resolve(options.operatorFile), 16 * 1024 * 1024), operatorSha256 = sha(operatorBytes);
  check(binding.build.clean === true && /^[a-f0-9]{40}$/.test(binding.build.sourceCommit) && /^[a-f0-9]{64}$/.test(binding.callerSha256) && /^[a-f0-9]{64}$/.test(binding.targetSha256)
    && Number.isSafeInteger(runtime.pid) && runtime.pid > 0 && runtime.host.length > 0, 'binding');
  return { root, runtime, operatorBytes, operatorSha256, verifyRoot, verifySource: () => {
    verifyRoot(); check(bounded(resolve(options.operatorFile), 16 * 1024 * 1024).equals(operatorBytes), 'operator_changed');
  } };
}
/** Complete immutable files precede atomic hard-link publication. A crash may
 * leave unused archives, but cannot publish a zero-byte shared operator lock.
 * This is process-interruption custody, not a claim about disk power-loss. */
export async function createNativeTelehealthConsentCustody(options: Options, supplied: TelehealthConsentCustodyBinding,
  initial: TelehealthConsentUpgradeResult, fence: TelehealthConsentOperatorFence): Promise<TelehealthConsentWriterCustody> {
  const binding = structuredClone(supplied), baseline = structuredClone(initial), c = context(options, binding);
  await fence.verify(); observation(baseline, 'inspect-settled'); check(baseline.observedMigrationCount === telehealthConsentParentCount(binding.configuration), 'baseline');
  const runId = randomBytes(16).toString('hex'), lock = resolve(c.root, 'operator.lock');
  check(!existsSync(lock), 'operator_active');
  check(!existsSync(resolve(c.root, 'telehealth-consent-upgrade-reconciliation.lock')), 'recovery_active');
  const header: Header = { contract: 'telehealth-consent-operator-lock/1', purpose: 'qualification-telehealth-consent-upgrade', runId,
    pid: c.runtime.pid, host: c.runtime.host, ...binding, operatorSha256: c.operatorSha256 };
  const lockBytes = bytes(header), headerFile = resolve(c.root, runId + '.inventory-header.json'), journal = resolve(c.root, runId + '.telehealth-consent.events.jsonl');
  const first: Event = { stage: 'baseline', runId, at: new Date(c.runtime.now()).toISOString(), previousSha256: sha(lockBytes), observation: baseline };
  let journalBytes = bytes(first), live = true;
  save(resolve(c.root, runId + '.telehealth-consent.operator.cjs'), c.operatorBytes); save(headerFile, lockBytes); save(journal, journalBytes);
  c.verifySource(); await fence.verify(); linkSync(headerFile, lock);
  const verify = async () => { await fence.verify(); c.verifySource(); check(live && bounded(lock, 16384).equals(lockBytes)
    && bounded(headerFile, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes)
    && bounded(resolve(c.root, runId + '.telehealth-consent.operator.cjs'), 16 * 1024 * 1024).equals(c.operatorBytes), 'custody_changed'); };
  const record = async (stage: TelehealthConsentCustodyStage | 'finding', value: TelehealthConsentUpgradeResult | null) => {
    await verify(); const parsed = parseJournal(journalBytes, header, lockBytes, c.runtime.now());
    check(parsed.tail.length === 0 && parsed.events.at(-1)?.stage !== 'finding', 'journal_terminal');
    const next: Event = { stage, runId, at: new Date(c.runtime.now()).toISOString(), previousSha256: sha(bytes(parsed.events.at(-1))),
      observation: value === null ? null : structuredClone(value) };
    const candidate = Buffer.concat([journalBytes, bytes(next)]); parseJournal(candidate, header, lockBytes, c.runtime.now());
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
    await verify(); observation(value, 'upgrade'); preserved(value, baseline);
    const parsed = parseJournal(journalBytes, header, lockBytes, c.runtime.now());
    check(parsed.tail.length === 0 && same(parsed.events.map(e => e.stage), stages)
      && same(parsed.events[3].observation, value), 'settlement');
    const receipt = { contract: 'telehealth-consent-custody-settlement/1', runId, operatorSha256: c.operatorSha256,
      journalSha256: sha(journalBytes), before: baseline, after: structuredClone(value), phiAllowed: false, activation: 'blocked' };
    save(resolve(c.root, runId + '.telehealth-consent.settled.json'), bytes(receipt));
    archive(resolve(c.root, runId + '.telehealth-consent.settled-lock.json'), lockBytes);
    await verify(); unlinkSync(lock); live = false;
    return { runId, journalSha256: sha(journalBytes), custodySettled: true };
  } };
}

/** Frozen original operator and original exact lock/journal bytes are mandatory.
 * A torn final event is archived intact; it never creates write authority. */
export async function openNativeTelehealthConsentRecovery(options: Options, supplied: TelehealthConsentCustodyBinding,
  fence: TelehealthConsentOperatorFence): Promise<TelehealthConsentRecoveryCustody> {
  const binding = structuredClone(supplied), c = context(options, binding); await fence.verify();
  const lock = resolve(c.root, 'operator.lock'), lockBytes = bounded(lock, 16384);
  let h: Header; try { h = JSON.parse(lockBytes.toString('utf8')); } catch { return fail('lock_json'); }
  check(exact(h, ['contract', 'purpose', 'runId', 'pid', 'host', 'build', 'configuration', 'callerSha256', 'targetSha256', 'operatorSha256'])
    && h.contract === 'telehealth-consent-operator-lock/1' && h.purpose === 'qualification-telehealth-consent-upgrade'
    && /^[a-f0-9]{32}$/.test(h.runId) && h.host === c.runtime.host && same(h.build, binding.build)
    && h.targetSha256 === binding.targetSha256 && same(h.configuration, binding.configuration) && /^[a-f0-9]{64}$/.test(h.callerSha256)
    && h.operatorSha256 === c.operatorSha256 && bytes(h).equals(lockBytes), 'lock_binding');
  check(stopped(h.pid), 'writer_active');
  const journal = resolve(c.root, h.runId + '.telehealth-consent.events.jsonl'), journalBytes = bounded(journal);
  const parsed = parseJournal(journalBytes, h, lockBytes, c.runtime.now());
  check(c.runtime.now() - parsed.lastAt >= 60000, 'writer_settlement');
  check(bounded(resolve(c.root, h.runId + '.inventory-header.json'), 16384).equals(lockBytes)
    && bounded(resolve(c.root, h.runId + '.telehealth-consent.operator.cjs'), 16 * 1024 * 1024).equals(c.operatorBytes), 'original_archive');
  const guard = resolve(c.root, 'telehealth-consent-upgrade-reconciliation.lock');
  // Native callers hold the DB fence for all local retirement/publication.
  // A live/foreign/changed guard is never deleted or replaced.
  if (existsSync(guard)) {
    const oldBytes = bounded(guard, 16384); let old: Record<string, unknown>;
    try { old = JSON.parse(oldBytes.toString('utf8')); } catch { return fail('guard_json'); }
    check(exact(old, ['contract', 'id', 'pid', 'host', 'runId', 'operatorSha256', 'journalSha256', 'at'])
      && old.contract === 'telehealth-consent-reconciliation-guard/1' && old.runId === h.runId && old.host === c.runtime.host
      && typeof old.id === 'string' && /^[a-f0-9]{32}$/.test(old.id) && old.operatorSha256 === c.operatorSha256
      && old.journalSha256 === sha(journalBytes) && bytes(old).equals(oldBytes)
      && typeof old.at === 'string' && Number.isFinite(Date.parse(old.at)) && c.runtime.now() - Date.parse(old.at) >= 60000
      && stopped(old.pid as number), 'guard_active_or_foreign');
    archive(resolve(c.root, old.id + '.telehealth-consent.abandoned-reconciliation-guard.json'), oldBytes);
    await fence.verify(); check(bounded(guard, 16384).equals(oldBytes), 'guard_changed'); unlinkSync(guard);
  }
  const guardId = randomBytes(16).toString('hex'), guardBytes = bytes({ contract: 'telehealth-consent-reconciliation-guard/1', id: guardId,
    pid: c.runtime.pid, host: c.runtime.host, runId: h.runId, operatorSha256: c.operatorSha256, journalSha256: sha(journalBytes), at: new Date(c.runtime.now()).toISOString() });
  const guardHeader = resolve(c.root, guardId + '.telehealth-consent.reconciliation-guard.json'); save(guardHeader, guardBytes);
  await fence.verify(); check(bounded(lock, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes), 'custody_changed'); linkSync(guardHeader, guard);
  let live = true;
  const verify = async () => { await fence.verify(); c.verifySource(); check(live && stopped(h.pid)
    && bounded(lock, 16384).equals(lockBytes) && bounded(journal).equals(journalBytes)
    && bounded(guard, 16384).equals(guardBytes) && bounded(guardHeader, 16384).equals(guardBytes)
    && bounded(resolve(c.root, h.runId + '.telehealth-consent.operator.cjs'), 16 * 1024 * 1024).equals(c.operatorBytes), 'recovery_changed'); };
  return { baseline: structuredClone(parsed.baseline), writeAdmitted: parsed.writeAdmitted, verify, settle: async value => {
    await verify(); observation(value, 'inspect-settled'); preserved(value, parsed.baseline);
    check(parsed.writeAdmitted || value.observedMigrationCount === telehealthConsentParentCount(binding.configuration), 'unadmitted_successor');
    const receipt = { contract: 'telehealth-consent-custody-reconciliation/1', runId: h.runId, originalWriteOutcome: 'unknown',
      currentCallerSha256: binding.callerSha256, operatorSha256: c.operatorSha256, originalJournalSha256: sha(journalBytes),
      tornJournalTail: parsed.tail.length > 0, before: parsed.baseline, after: structuredClone(value),
      retryPerformed: false, databaseMutationPerformed: false, phiAllowed: false, activation: 'blocked' };
    archive(resolve(c.root, guardId + '.telehealth-consent.reconciled.json'), bytes(receipt));
    archive(resolve(c.root, h.runId + '.telehealth-consent.reconciled-lock.json'), lockBytes);
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


export function readTelehealthConsentOperatorFile(file: string, maximum = 16384) {
  const verifyDirectories=directories(dirname(resolve(file))); verifyDirectories();
  const bytes=bounded(resolve(file),maximum); verifyDirectories(); return bytes;
}
