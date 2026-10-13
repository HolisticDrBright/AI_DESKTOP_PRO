if (typeof window !== 'undefined') throw new Error('commerce host target source is server-only');
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { programCommerceHostTarget, type ProgramCommerceHostTarget } from './commerce-host-target';

/**
 * Where the reviewed commerce target comes from, and the checks it passes on EVERY read.
 *
 *   Desktop (Next server): the reviewed, read-only container mount below. Opened without following
 *   a link, bounded, read twice-stat'd (size, mtime and inode unchanged while reading), its SHA-256
 *   equal to PROGRAM_COMMERCE_HOST_TARGET_SHA256 and its source commit equal to
 *   PROGRAM_COMMERCE_SOURCE_COMMIT. No browser path, environment path, search or cache is accepted.
 *   Lambda (education API, worker): the same bytes in PROGRAM_COMMERCE_HOST_TARGET_JSON, under the
 *   same two pins.
 * A target that fails any check is unavailable, and an unavailable target closes every surface it
 * would open. A well-formed target names reviews; it does not prove they happened.
 */
export const COMMERCE_HOST_TARGET_FILE = '/run/alp/program-commerce-host-target.json';
export const MAX_COMMERCE_TARGET_BYTES = 262_144;
export class CommerceTargetRefused extends Error { constructor(readonly reason: string) { super('commerce_target_refused'); this.name = 'CommerceTargetRefused'; } }

type Env = Record<string, string | undefined>;

/** The pinned bytes, parsed and bound to this source commit; throws CommerceTargetRefused otherwise. */
export function verifyCommerceTargetBytes(bytes: Uint8Array, env: Env): ProgramCommerceHostTarget {
  const pinned = env.PROGRAM_COMMERCE_HOST_TARGET_SHA256 ?? '';
  if (!/^[a-f0-9]{64}$/.test(pinned)) throw new CommerceTargetRefused('target_pin_missing');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_COMMERCE_TARGET_BYTES) throw new CommerceTargetRefused('target_size');
  if (createHash('sha256').update(bytes).digest('hex') !== pinned) throw new CommerceTargetRefused('target_digest_mismatch');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CommerceTargetRefused('target_malformed'); }
  const target = programCommerceHostTarget.safeParse(parsed);
  if (!target.success) throw new CommerceTargetRefused('target_invalid');
  if (env.PROGRAM_COMMERCE_SOURCE_COMMIT !== target.data.sourceCommit) throw new CommerceTargetRefused('source_commit_mismatch');
  return target.data;
}

const raceAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  // The work may settle after the abort answered; its late outcome is owned here, never an unhandled rejection.
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new CommerceTargetRefused('aborted'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CommerceTargetRefused('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
};

/** The Desktop read of the mounted target. `path` exists for the source tests; the bootstrap never passes one. */
export async function readCommerceHostTargetFile(env: Env, signal: AbortSignal, path: string = COMMERCE_HOST_TARGET_FILE): Promise<ProgramCommerceHostTarget> {
  const opening = open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).then(async file => {
    // A late open still owns a descriptor and must close it.
    if (signal.aborted) { await file.close(); throw new CommerceTargetRefused('aborted'); }
    return file;
  }, () => { throw new CommerceTargetRefused('target_unreadable'); });
  const file = await raceAbort(opening, signal);
  try {
    const initial = await raceAbort(file.stat(), signal);
    if (!initial.isFile() || initial.size < 1 || initial.size > MAX_COMMERCE_TARGET_BYTES) throw new CommerceTargetRefused('target_size');
    const buffer = Buffer.alloc(MAX_COMMERCE_TARGET_BYTES + 1);
    let received = 0;
    while (received <= MAX_COMMERCE_TARGET_BYTES) {
      const result = await raceAbort(file.read(buffer, received, buffer.byteLength - received, received), signal);
      if (result.bytesRead === 0) break;
      received += result.bytesRead;
    }
    const final = await raceAbort(file.stat(), signal);
    if (received !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ino !== initial.ino) throw new CommerceTargetRefused('target_changed');
    return verifyCommerceTargetBytes(buffer.subarray(0, received), env);
  } finally { await file.close().catch(() => undefined); }
}

/** The Lambda read: the same bytes from the function's own configuration, under the same pins. */
export function commerceHostTargetFromEnvironment(env: Env): ProgramCommerceHostTarget {
  const raw = env.PROGRAM_COMMERCE_HOST_TARGET_JSON;
  if (!raw) throw new CommerceTargetRefused('target_unavailable');
  return verifyCommerceTargetBytes(new TextEncoder().encode(raw), env);
}
