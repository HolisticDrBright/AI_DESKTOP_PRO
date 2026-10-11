if (typeof window !== 'undefined') throw new Error('programs/program-media-fictional is server-only.');
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ProgramMediaArtifact, ProgramMediaReference, ProgramMediaReservation } from '@/contracts/programMedia';
import type { ProgramMediaLedger, ProgramMediaObjectStore, ProgramMediaStoredObject } from './program-media-authoring';

/**
 * FICTIONAL ledger and object store for the program-media authoring runtime. In memory, no
 * network, no credentials. They exist so every journey, denial and race can be run here and so
 * Codex can run the same ordered cases against a real store later. They prove nothing about S3,
 * KMS, a database, or any hosted service, and the runtime stays disabled whether or not they are
 * used.
 *
 * The store behaves like the dedicated bucket the design asks for: a conditional create that
 * refuses an existing key, versioned objects, SSE-KMS and a full-object SHA-256 checksum reported
 * on head, and removal by exact version. Faults can be injected to rehearse a lost response, a
 * failed write and a mismatched object.
 */
export type FictionalStoreFault = 'lose_put_response' | 'fail_put' | 'fail_head' | 'corrupt_object';

export function createFictionalProgramMediaStore(input: { kmsKeyArn: string; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  const objects = new Map<string, Array<{ version: string; bytes: Uint8Array; head: ProgramMediaStoredObject }>>();
  const faults: FictionalStoreFault[] = [];
  let counter = 0;
  const log: Array<{ op: 'put' | 'head' | 'remove' | 'preview'; key: string }> = [];
  const take = (fault: FictionalStoreFault) => { const i = faults.indexOf(fault); if (i >= 0) { faults.splice(i, 1); return true; } return false; };
  const store: ProgramMediaObjectStore & { inject(fault: FictionalStoreFault): void; versionsOf(key: string): string[]; log: typeof log; grantsPublicRead: false } = {
    grantsPublicRead: false,
    log,
    inject: fault => { faults.push(fault); },
    versionsOf: key => (objects.get(key) ?? []).map(o => o.version),
    async put(reservation, bytes) {
      log.push({ op: 'put', key: reservation.objectKey });
      if (take('fail_put')) throw new Error('fictional_store_write_failed');
      if ((objects.get(reservation.objectKey) ?? []).length > 0) throw new Error('PreconditionFailed');
      const version = `fv${++counter}`;
      const corrupt = take('corrupt_object');
      const checksum = Buffer.from(corrupt ? 'ff'.repeat(32) : reservation.sha256, 'hex').toString('base64');
      objects.set(reservation.objectKey, [{ version, bytes, head: {
        version, bytes: corrupt ? bytes.byteLength + 1 : bytes.byteLength, contentType: reservation.contentType, checksum, checksumType: 'FULL_OBJECT',
        encryption: 'aws:kms', kmsKeyArn: input.kmsKeyArn,
        metadata: { 'artifact-id': reservation.artifactId, 'program-id': reservation.programId, clinic: reservation.clinic, purpose: 'educational_media' },
      } }]);
      if (take('lose_put_response')) throw new Error('fictional_lost_response');
      return { version };
    },
    async head(reservation, objectVersion) {
      log.push({ op: 'head', key: reservation.objectKey });
      if (take('fail_head')) throw new Error('fictional_store_unreachable');
      const versions = objects.get(reservation.objectKey) ?? [];
      const found = objectVersion === undefined ? versions[versions.length - 1] : versions.find(o => o.version === objectVersion);
      return found ? { ...found.head } : null;
    },
    async remove(reservation, objectVersion) {
      log.push({ op: 'remove', key: reservation.objectKey });
      const versions = objects.get(reservation.objectKey) ?? [];
      objects.set(reservation.objectKey, versions.filter(o => o.version !== objectVersion));
    },
    async preview(artifact) {
      log.push({ op: 'preview', key: artifact.objectKey });
      const versions = objects.get(artifact.objectKey) ?? [];
      if (!versions.some(o => o.version === artifact.objectVersion)) throw new Error('fictional_object_missing');
      return { token: `fictional-preview-${artifact.artifactId}-${artifact.objectVersion}`, until: new Date(now().getTime() + 5 * 60 * 1000).toISOString() };
    },
  };
  return store;
}

export function createFictionalProgramMediaLedger(input: { authorized: (context: ClinicalRequestContext, programId: string) => boolean }) {
  const reservations = new Map<string, ProgramMediaReservation>();
  const artifacts = new Map<string, ProgramMediaArtifact>();
  const publications: ProgramMediaReference[] = [];
  const events: Array<{ artifactId: string; event: string; at: string }> = [];
  const byCommand = new Map<string, string>();
  const commandKey = (clinic: string, programId: string, commandId: string) => `${clinic}|${programId}|${commandId}`;
  const scoped = <T extends { clinic: string }>(context: ClinicalRequestContext, record: T | undefined): T | null =>
    record && record.clinic === context.organizationId ? record : null;
  const ledger: ProgramMediaLedger & { publications: ProgramMediaReference[]; events: typeof events; size(): number } = {
    publications, events,
    size: () => reservations.size,
    async authorize(context, programId) { return input.authorized(context, programId); },
    async reserve(context, reservation) {
      const key = commandKey(reservation.clinic, reservation.programId, reservation.commandId);
      const earlier = byCommand.get(key);
      if (earlier) {
        const existing = reservations.get(earlier)!;
        if (existing.sha256 !== reservation.sha256 || existing.bytes !== reservation.bytes || existing.contentType !== reservation.contentType) throw new Error('conflict');
        return { ...existing, replayed: true };
      }
      if (reservations.has(reservation.artifactId)) throw new Error('conflict');
      const stored: ProgramMediaReservation = { ...reservation, replayed: false };
      reservations.set(reservation.artifactId, stored);
      byCommand.set(key, reservation.artifactId);
      events.push({ artifactId: reservation.artifactId, event: 'reserved', at: reservation.createdAt });
      return { ...stored };
    },
    async reservation(context, artifactId) { const r = scoped(context, reservations.get(artifactId)); return r ? { ...r } : null; },
    async artifact(context, artifactId) { const a = scoped(context, artifacts.get(artifactId)); return a ? structuredClone(a) : null; },
    async commit(context, artifactId, objectVersion, committedAt) {
      const reservation = scoped(context, reservations.get(artifactId));
      if (!reservation) throw new Error('not_found');
      const existing = artifacts.get(artifactId);
      if (existing) {
        if (existing.state === 'ready' && existing.objectVersion === objectVersion) return structuredClone(existing);
        if (existing.state !== 'error') throw new Error('conflict');
      }
      const artifact: ProgramMediaArtifact = {
        artifactId, clinic: reservation.clinic, programId: reservation.programId, kind: reservation.kind, contentType: reservation.contentType,
        bytes: reservation.bytes, sha256: reservation.sha256, objectKey: reservation.objectKey, version: existing ? existing.version + 1 : 1,
        state: 'ready', objectVersion, committedAt, retiredAt: null, failure: null, caption: existing?.caption ?? null, transcript: existing?.transcript ?? null,
      };
      artifacts.set(artifactId, artifact);
      reservations.set(artifactId, { ...reservation, state: 'reserved', failure: null });
      events.push({ artifactId, event: 'committed', at: committedAt });
      return structuredClone(artifact);
    },
    async settle(context, artifactId, state, failure) {
      const reservation = scoped(context, reservations.get(artifactId));
      if (!reservation) throw new Error('not_found');
      const existing = artifacts.get(artifactId);
      if (existing && (existing.state === 'ready' || existing.state === 'retired')) throw new Error('conflict');
      if (state === 'held') {
        artifacts.set(artifactId, {
          artifactId, clinic: reservation.clinic, programId: reservation.programId, kind: reservation.kind, contentType: reservation.contentType,
          bytes: reservation.bytes, sha256: reservation.sha256, objectKey: reservation.objectKey, version: existing ? existing.version + 1 : 1,
          state: 'held', objectVersion: null, committedAt: null, retiredAt: null, failure, caption: null, transcript: null,
        });
      } else {
        reservations.set(artifactId, { ...reservation, state, failure });
        if (existing) artifacts.set(artifactId, { ...existing, state, failure, version: existing.version + 1 });
        else if (state === 'error') artifacts.set(artifactId, {
          artifactId, clinic: reservation.clinic, programId: reservation.programId, kind: reservation.kind, contentType: reservation.contentType,
          bytes: reservation.bytes, sha256: reservation.sha256, objectKey: reservation.objectKey, version: 1,
          state: 'error', objectVersion: null, committedAt: null, retiredAt: null, failure, caption: null, transcript: null,
        });
      }
      events.push({ artifactId, event: state + ':' + failure, at: new Date().toISOString() });
    },
    async attachText(context, artifactId, expectedVersion, slot, text) {
      const artifact = scoped(context, artifacts.get(artifactId));
      if (!artifact || artifact.state !== 'ready') throw new Error('not_found');
      if (artifact.version !== expectedVersion) throw new Error('conflict');
      const next = { ...artifact, [slot]: text, version: artifact.version + 1 };
      artifacts.set(artifactId, next);
      events.push({ artifactId, event: `text:${slot}`, at: new Date().toISOString() });
      return structuredClone(next);
    },
    async retire(context, artifactId, expectedVersion, retiredAt) {
      const artifact = scoped(context, artifacts.get(artifactId));
      if (!artifact || artifact.state !== 'ready') throw new Error('not_found');
      if (artifact.version !== expectedVersion) throw new Error('conflict');
      const next: ProgramMediaArtifact = { ...artifact, state: 'retired', retiredAt, version: artifact.version + 1 };
      artifacts.set(artifactId, next);
      events.push({ artifactId, event: 'retired', at: retiredAt });
      return structuredClone(next);
    },
    async recordPublication(context, reference) {
      if (reference.origin.clinic !== context.organizationId) throw new Error('access_refused');
      publications.push(structuredClone(reference));
      events.push({ artifactId: reference.artifactId, event: `published:v${reference.version}`, at: reference.publishedAt });
    },
    async expiredReservations(context, programId, before) {
      return [...reservations.values()].filter(r => r.clinic === context.organizationId && r.programId === programId && Date.parse(r.acceptBefore) <= Date.parse(before)
        && (r.state === 'reserved' || r.state === 'error') && artifacts.get(r.artifactId)?.state !== 'ready' && artifacts.get(r.artifactId)?.state !== 'retired').map(r => ({ ...r }));
    },
  };
  return ledger;
}
