if (typeof window !== 'undefined') throw new Error('programs/program-media-fictional is server-only.');
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ProgramMediaArtifact, ProgramMediaReference, ProgramMediaReservation } from '@/contracts/programMedia';
import { ProgramMediaWriteError, type ProgramMediaAbsenceProof, type ProgramMediaLedger, type ProgramMediaObjectStore, type ProgramMediaStoredObject } from './program-media-authoring';
import { programMediaReference } from '@/contracts/programMedia';

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
export type FictionalStoreFault = 'lose_put_response' | 'fail_put' | 'fail_head' | 'corrupt_object' | 'incomplete_inventory' | 'fail_inventory' | 'noop_remove' | 'fail_remove';

export function createFictionalProgramMediaStore(input: { kmsKeyArn: string; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  const objects = new Map<string, Array<{ version: string; bytes: Uint8Array; head: ProgramMediaStoredObject }>>();
  const faults: FictionalStoreFault[] = [];
  let counter = 0;
  const log: Array<{ op: 'put' | 'head' | 'remove' | 'preview' | 'inventory'; key: string }> = [];
  const take = (fault: FictionalStoreFault) => { const i = faults.indexOf(fault); if (i >= 0) { faults.splice(i, 1); return true; } return false; };
  const store: ProgramMediaObjectStore & { inject(fault: FictionalStoreFault): void; versionsOf(key: string): string[]; log: typeof log; grantsPublicRead: false } = {
    grantsPublicRead: false,
    log,
    inject: fault => { faults.push(fault); },
    versionsOf: key => (objects.get(key) ?? []).map(o => o.version),
    async put(reservation, bytes) {
      log.push({ op: 'put', key: reservation.objectKey });
      if (take('fail_put')) throw new ProgramMediaWriteError(true);
      if ((objects.get(reservation.objectKey) ?? []).length > 0) throw new ProgramMediaWriteError(true);
      const version = `fv${++counter}`;
      const corrupt = take('corrupt_object');
      const checksum = Buffer.from(corrupt ? 'ff'.repeat(32) : reservation.sha256, 'hex').toString('base64');
      objects.set(reservation.objectKey, [{ version, bytes, head: {
        version, bytes: corrupt ? bytes.byteLength + 1 : bytes.byteLength, contentType: reservation.contentType, checksum, checksumType: 'FULL_OBJECT',
        encryption: 'aws:kms', kmsKeyArn: input.kmsKeyArn,
        metadata: { 'artifact-id': reservation.artifactId, 'program-id': reservation.programId, clinic: reservation.clinic, purpose: 'educational_media' },
      } }]);
      if (take('lose_put_response')) throw new ProgramMediaWriteError(false);
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
      if (take('fail_remove')) throw new Error('fictional_delete_denied');
      if (take('noop_remove')) return;
      const versions = objects.get(reservation.objectKey) ?? [];
      objects.set(reservation.objectKey, versions.filter(o => o.version !== objectVersion));
    },
    async inventory(reservation) {
      log.push({ op: 'inventory', key: reservation.objectKey });
      if (take('fail_inventory')) throw new Error('fictional_inventory_denied');
      return { complete: !take('incomplete_inventory'), versions: (objects.get(reservation.objectKey) ?? []).map(o => structuredClone(o.head)) };
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
  // This is ONLY the fictional implementation of the durable SQL contract. It
  // is not a native mutex, service adapter, or deployment/cleanup certificate.
  const work = new Map<string, { artifactId: string; actorId: string; mode: 'admit' | 'reconcile'; state: 'open' | 'settled' | 'uncertain' }>();
  const cleanups = new Map<string, { claims: Set<string>; proof: ProgramMediaAbsenceProof | null }>();
  const pending = (artifactId: string) => [...work.values()].some(w => w.artifactId === artifactId && w.state !== 'settled');
  const writer = (context: ClinicalRequestContext, artifactId: string, claimId: string) => {
    const w = work.get(claimId);
    if (!w || w.artifactId !== artifactId || w.actorId !== context.actorPersonId || w.state !== 'open' || cleanups.has(artifactId)) throw new Error('conflict');
    return w;
  };
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
    async beginWriter(context, artifactId, claimId, mode, at) {
      const r = scoped(context, reservations.get(artifactId));
      if (!r || cleanups.has(artifactId) || r.state === 'abandoned'
        || ['held', 'retired'].includes(artifacts.get(artifactId)?.state ?? '')
        || (mode === 'admit' && Date.parse(r.acceptBefore) <= Date.parse(at))) return false;
      if (work.has(claimId)) throw new Error('conflict');
      work.set(claimId, { artifactId, actorId: context.actorPersonId, mode, state: 'open' });
      return true;
    },
    async finishWriter(context, artifactId, claimId, outcome) {
      const w = work.get(claimId);
      if (!scoped(context, reservations.get(artifactId)) || !w || w.artifactId !== artifactId || w.actorId !== context.actorPersonId) throw new Error('conflict');
      if (w.state === 'uncertain' && outcome !== 'uncertain') throw new Error('conflict');
      w.state = outcome;
    },
    async beginCleanup(context, artifactId, claimId, at) {
      const r = scoped(context, reservations.get(artifactId));
      if (!r || Date.parse(r.acceptBefore) > Date.parse(at) || pending(artifactId)
        || ['ready', 'retired', 'held'].includes(artifacts.get(artifactId)?.state ?? '')) return false;
      const current = cleanups.get(artifactId) ?? { claims: new Set<string>(), proof: null };
      if (current.proof) return false;
      current.claims.add(claimId); cleanups.set(artifactId, current);
      return true;
    },
    async certifyCleanup(context, artifactId, claimId, proof) {
      const r = scoped(context, reservations.get(artifactId)), c = cleanups.get(artifactId);
      if (!r || !c?.claims.has(claimId) || pending(artifactId) || c.proof
        || proof.artifactId !== artifactId || proof.claimId !== claimId || proof.objectKey !== r.objectKey
        || proof.complete !== true || proof.remainingVersions !== 0
        || ['ready', 'retired', 'held'].includes(artifacts.get(artifactId)?.state ?? '')) throw new Error('conflict');
      c.proof = structuredClone(proof);
      reservations.set(artifactId, { ...r, state: 'abandoned', failure: proof.removedVersions.length ? 'orphan_removed' : 'reservation_expired' });
      const a = artifacts.get(artifactId);
      if (a) artifacts.set(artifactId, { ...a, state: 'abandoned', version: a.version + 1, failure: 'orphan_removed' });
      events.push({ artifactId, event: 'absence_proven', at: proof.checkedAt });
    },
    async commit(context, artifactId, objectVersion, committedAt, claimId) {
      writer(context, artifactId, claimId);
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
    async settle(context, artifactId, state, failure, claimId) {
      const reservation = scoped(context, reservations.get(artifactId));
      if (!reservation) throw new Error('not_found');
      const existing = artifacts.get(artifactId);
      // A concurrent successful writer wins. An error/expiry is not permission
      // to overwrite ready state, nor to abandon an admitted/uncertain writer.
      if (existing && (existing.state === 'ready' || existing.state === 'retired')) return;
      if (!claimId && pending(artifactId)) return;
      if (claimId && !cleanups.get(artifactId)?.claims.has(claimId)) writer(context, artifactId, claimId);
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
      const a = scoped(context, artifacts.get(reference.artifactId));
      if (!a || a.state !== 'ready' || a.version !== reference.version || a.sha256 !== reference.sha256
        || a.programId !== reference.origin.programId || a.kind !== reference.kind || a.bytes !== reference.bytes || a.contentType !== reference.contentType
        || JSON.stringify(a.caption ? { source: a.caption.source, sha256: a.caption.sha256 } : null) !== JSON.stringify(reference.caption)
        || JSON.stringify(a.transcript ? { source: a.transcript.source, sha256: a.transcript.sha256, format: a.transcript.format } : null) !== JSON.stringify(reference.transcript)) throw new Error('conflict');
      publications.push(structuredClone(reference));
      events.push({ artifactId: reference.artifactId, event: `published:v${reference.version}`, at: reference.publishedAt });
    },
    async hasPublication(context, reference) {
      if (reference.origin.clinic !== context.organizationId) return false;
      const canonical = JSON.stringify(programMediaReference.parse(reference));
      return publications.some(p => JSON.stringify(programMediaReference.parse(p)) === canonical);
    },
    async expiredReservations(context, programId, before) {
      return [...reservations.values()].filter(r => r.clinic === context.organizationId && r.programId === programId && Date.parse(r.acceptBefore) <= Date.parse(before)
        && !cleanups.get(r.artifactId)?.proof && artifacts.get(r.artifactId)?.state !== 'ready' && artifacts.get(r.artifactId)?.state !== 'retired').map(r => ({ ...r }));
    },
  };
  return ledger;
}
