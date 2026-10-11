if (typeof window !== 'undefined') throw new Error('programs/program-media-fictional is server-only.');
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ProgramMediaArtifact, ProgramMediaLease, ProgramMediaReference, ProgramMediaReservation } from '@/contracts/programMedia';
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
 * failed write, a mismatched object, a delete that is acknowledged and does nothing, and a delete
 * that leaves a marker. `before(op, fn)` runs a one-shot hook ahead of the next such operation so a
 * competing party can be interleaved at an exact point.
 *
 * The ledger keeps the fence the way the SQL successor candidate would: one row per reservation,
 * a lease taken only when no unexpired lease of the other holder exists, a commit that must carry
 * the writer's token, abandonment that needs absence proof or an unresolved flag, and a listing of
 * everything whose storage is not accounted for.
 */
export type FictionalStoreFault = 'lose_put_response' | 'fail_put' | 'fail_head' | 'corrupt_object' | 'ignore_remove' | 'delete_marker_on_remove' | 'fail_remove';
type StoreOp = 'put' | 'head' | 'remove' | 'preview';

export function createFictionalProgramMediaStore(input: { kmsKeyArn: string; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  const objects = new Map<string, Array<{ version: string; bytes: Uint8Array; head: ProgramMediaStoredObject }>>();
  const faults: FictionalStoreFault[] = [];
  const hooks: Array<{ op: StoreOp; run: () => Promise<void> }> = [];
  let counter = 0;
  const log: Array<{ op: StoreOp; key: string }> = [];
  const take = (fault: FictionalStoreFault) => { const i = faults.indexOf(fault); if (i >= 0) { faults.splice(i, 1); return true; } return false; };
  const fire = async (op: StoreOp) => { const i = hooks.findIndex(h => h.op === op); if (i >= 0) { const [hook] = hooks.splice(i, 1); await hook!.run(); } };
  const store: ProgramMediaObjectStore & {
    inject(fault: FictionalStoreFault): void; before(op: StoreOp, run: () => Promise<void>): void;
    versionsOf(key: string): string[]; log: typeof log; grantsPublicRead: false;
  } = {
    grantsPublicRead: false,
    log,
    inject: fault => { faults.push(fault); },
    before: (op, run) => { hooks.push({ op, run }); },
    versionsOf: key => (objects.get(key) ?? []).filter(o => !o.head.deleteMarker).map(o => o.version),
    async put(reservation, bytes) {
      await fire('put');
      log.push({ op: 'put', key: reservation.objectKey });
      if (take('fail_put')) throw new Error('fictional_store_write_failed');
      if ((objects.get(reservation.objectKey) ?? []).some(o => !o.head.deleteMarker)) throw new Error('PreconditionFailed');
      const version = `fv${++counter}`;
      const corrupt = take('corrupt_object');
      const checksum = Buffer.from(corrupt ? 'ff'.repeat(32) : reservation.sha256, 'hex').toString('base64');
      objects.set(reservation.objectKey, [...(objects.get(reservation.objectKey) ?? []), { version, bytes, head: {
        version, bytes: corrupt ? bytes.byteLength + 1 : bytes.byteLength, contentType: reservation.contentType, checksum, checksumType: 'FULL_OBJECT',
        encryption: 'aws:kms', kmsKeyArn: input.kmsKeyArn,
        metadata: { 'artifact-id': reservation.artifactId, 'program-id': reservation.programId, clinic: reservation.clinic, purpose: 'educational_media' },
      } }]);
      if (take('lose_put_response')) throw new Error('fictional_lost_response');
      return { version };
    },
    async head(reservation, objectVersion) {
      await fire('head');
      log.push({ op: 'head', key: reservation.objectKey });
      if (take('fail_head')) throw new Error('fictional_store_unreachable');
      const versions = objects.get(reservation.objectKey) ?? [];
      const found = objectVersion === undefined ? versions[versions.length - 1] : versions.find(o => o.version === objectVersion);
      return found ? { ...found.head } : null;
    },
    async remove(reservation, objectVersion) {
      await fire('remove');
      log.push({ op: 'remove', key: reservation.objectKey });
      if (take('fail_remove')) throw new Error('fictional_store_delete_failed');
      if (take('ignore_remove')) return;
      const versions = objects.get(reservation.objectKey) ?? [];
      if (take('delete_marker_on_remove')) {
        objects.set(reservation.objectKey, [...versions, { version: `fm${++counter}`, bytes: new Uint8Array(), head: { version: `fm${counter}`, deleteMarker: true } }]);
        return;
      }
      objects.set(reservation.objectKey, versions.filter(o => o.version !== objectVersion));
    },
    async preview(artifact) {
      await fire('preview');
      log.push({ op: 'preview', key: artifact.objectKey });
      const versions = objects.get(artifact.objectKey) ?? [];
      if (!versions.some(o => o.version === artifact.objectVersion && !o.head.deleteMarker)) throw new Error('fictional_object_missing');
      return { token: `fictional-preview-${artifact.artifactId}-${artifact.objectVersion}`, until: new Date(now().getTime() + 5 * 60 * 1000).toISOString() };
    },
  };
  return store;
}

export function createFictionalProgramMediaLedger(input: { authorized: (context: ClinicalRequestContext, programId: string) => boolean; now?: () => Date }) {
  const now = input.now ?? (() => new Date());
  const reservations = new Map<string, ProgramMediaReservation>();
  const artifacts = new Map<string, ProgramMediaArtifact>();
  const publications = new Map<string, ProgramMediaReference>();
  const events: Array<{ artifactId: string; event: string; at: string }> = [];
  const byCommand = new Map<string, string>();
  const commandKey = (clinic: string, programId: string, commandId: string) => `${clinic}|${programId}|${commandId}`;
  const scoped = <T extends { clinic: string }>(context: ClinicalRequestContext, record: T | undefined): T | null =>
    record && record.clinic === context.organizationId ? record : null;
  const event = (artifactId: string, name: string) => events.push({ artifactId, event: name, at: now().toISOString() });
  const leaseLive = (r: ProgramMediaReservation) => r.lease !== null && Date.parse(r.lease.until) > now().getTime();
  const committed = (artifactId: string) => { const a = artifacts.get(artifactId); return a !== undefined && (a.state === 'ready' || a.state === 'retired' || a.state === 'held'); };
  const base = (r: ProgramMediaReservation, over: Partial<ProgramMediaArtifact> = {}): ProgramMediaArtifact => ({
    artifactId: r.artifactId, clinic: r.clinic, programId: r.programId, kind: r.kind, contentType: r.contentType, bytes: r.bytes, sha256: r.sha256,
    objectKey: r.objectKey, version: 1, state: 'error', objectVersion: null, committedAt: null, retiredAt: null, failure: null, caption: null, transcript: null, ...over,
  });
  const holding = (context: ClinicalRequestContext, artifactId: string, holder: ProgramMediaLease['holder'], token: string): ProgramMediaReservation => {
    const r = scoped(context, reservations.get(artifactId));
    if (!r) throw new Error('not_found');
    if (r.lease === null || r.lease.holder !== holder || r.lease.token !== token || !leaseLive(r)) throw new Error('lease_lost');
    return r;
  };
  const claim = async (context: ClinicalRequestContext, artifactId: string, lease: ProgramMediaLease): Promise<ProgramMediaReservation | null> => {
    const r = scoped(context, reservations.get(artifactId));
    if (!r) throw new Error('not_found');
    if (committed(artifactId)) return null;
    if (r.state === 'abandoned' && !r.unresolvedStorage) return null;
    if (leaseLive(r)) return null;
    const next: ProgramMediaReservation = { ...r, state: lease.holder === 'writer' ? 'writing' : 'cleaning', lease: { ...lease } };
    reservations.set(artifactId, next);
    event(artifactId, `lease:${lease.holder}`);
    return { ...next };
  };

  const ledger: ProgramMediaLedger & { publications: ProgramMediaReference[]; events: typeof events; size(): number } = {
    get publications() { return [...publications.values()]; },
    events,
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
      event(reservation.artifactId, 'reserved');
      return { ...stored };
    },
    async reservation(context, artifactId) { const r = scoped(context, reservations.get(artifactId)); return r ? { ...r } : null; },
    async artifact(context, artifactId) { const a = scoped(context, artifacts.get(artifactId)); return a ? structuredClone(a) : null; },
    beginWrite: (context, artifactId, lease) => claim(context, artifactId, { ...lease, holder: 'writer' }),
    claimCleanup: (context, artifactId, lease) => claim(context, artifactId, { ...lease, holder: 'cleanup' }),
    async commit(context, artifactId, token, objectVersion, committedAt) {
      const r = holding(context, artifactId, 'writer', token);
      const existing = artifacts.get(artifactId);
      if (existing && existing.state === 'ready' && existing.objectVersion === objectVersion) return structuredClone(existing);
      if (existing && existing.state !== 'error') throw new Error('conflict');
      const artifact = base(r, { version: existing ? existing.version + 1 : 1, state: 'ready', objectVersion, committedAt, caption: existing?.caption ?? null, transcript: existing?.transcript ?? null });
      artifacts.set(artifactId, artifact);
      reservations.set(artifactId, { ...r, state: 'reserved', lease: null, failure: null, unresolvedStorage: false });
      event(artifactId, 'committed');
      return structuredClone(artifact);
    },
    async endWrite(context, artifactId, token, settlement) {
      const r = holding(context, artifactId, 'writer', token);
      const existing = artifacts.get(artifactId);
      if (settlement.state === 'held') {
        artifacts.set(artifactId, base(r, { version: existing ? existing.version + 1 : 1, state: 'held', failure: settlement.failure }));
        reservations.set(artifactId, { ...r, state: 'error', lease: null, failure: settlement.failure });
      } else if (settlement.state === 'abandoned') {
        reservations.set(artifactId, { ...r, state: 'abandoned', lease: null, failure: settlement.failure, absenceProvenAt: settlement.absenceProvenAt, unresolvedStorage: false });
        if (existing) artifacts.set(artifactId, { ...existing, state: 'abandoned', failure: settlement.failure, version: existing.version + 1 });
      } else {
        reservations.set(artifactId, { ...r, state: settlement.state, lease: null, failure: settlement.failure, unresolvedStorage: settlement.unresolvedStorage || r.unresolvedStorage });
        if (settlement.state === 'error') artifacts.set(artifactId, existing ? { ...existing, state: 'error', failure: settlement.failure, version: existing.version + 1 } : base(r, { failure: settlement.failure }));
      }
      event(artifactId, `write:${settlement.state}:${settlement.failure ?? ''}`);
    },
    async settleCleanup(context, artifactId, token, settlement) {
      const r = holding(context, artifactId, 'cleanup', token);
      const existing = artifacts.get(artifactId);
      if (settlement.state === 'held') {
        artifacts.set(artifactId, base(r, { version: existing ? existing.version + 1 : 1, state: 'held', failure: settlement.failure }));
        reservations.set(artifactId, { ...r, state: 'error', lease: null, failure: settlement.failure });
      } else if (settlement.state === 'abandoned') {
        reservations.set(artifactId, { ...r, state: 'abandoned', lease: null, failure: settlement.failure, absenceProvenAt: settlement.absenceProvenAt, unresolvedStorage: false });
        if (existing) artifacts.set(artifactId, { ...existing, state: 'abandoned', failure: settlement.failure, version: existing.version + 1 });
      } else {
        reservations.set(artifactId, { ...r, state: settlement.state, lease: null, failure: settlement.failure, unresolvedStorage: settlement.unresolvedStorage || r.unresolvedStorage });
        if (settlement.state === 'error') artifacts.set(artifactId, existing ? { ...existing, state: 'error', failure: settlement.failure, version: existing.version + 1 } : base(r, { failure: settlement.failure }));
      }
      event(artifactId, `cleanup:${settlement.state}:${settlement.failure}`);
    },
    async markUnresolved(context, artifactId, reason) {
      const r = scoped(context, reservations.get(artifactId));
      if (!r) throw new Error('not_found');
      reservations.set(artifactId, { ...r, unresolvedStorage: true, failure: reason });
      event(artifactId, `unresolved:${reason}`);
    },
    async hold(context, artifactId, failure) {
      const r = scoped(context, reservations.get(artifactId));
      if (!r) throw new Error('not_found');
      const existing = artifacts.get(artifactId);
      if (existing && (existing.state === 'ready' || existing.state === 'retired')) throw new Error('conflict');
      artifacts.set(artifactId, base(r, { version: existing ? existing.version + 1 : 1, state: 'held', failure }));
      reservations.set(artifactId, { ...r, state: 'error', lease: null, failure });
      event(artifactId, `held:${failure}`);
    },
    async attachText(context, artifactId, expectedVersion, slot, text) {
      const artifact = scoped(context, artifacts.get(artifactId));
      if (!artifact || artifact.state !== 'ready') throw new Error('not_found');
      if (artifact.version !== expectedVersion) throw new Error('conflict');
      const next = { ...artifact, [slot]: text, version: artifact.version + 1 };
      artifacts.set(artifactId, next);
      event(artifactId, `text:${slot}`);
      return structuredClone(next);
    },
    async retire(context, artifactId, expectedVersion, retiredAt) {
      const artifact = scoped(context, artifacts.get(artifactId));
      if (!artifact || artifact.state !== 'ready') throw new Error('not_found');
      if (artifact.version !== expectedVersion) throw new Error('conflict');
      const next: ProgramMediaArtifact = { ...artifact, state: 'retired', retiredAt, version: artifact.version + 1 };
      artifacts.set(artifactId, next);
      event(artifactId, 'retired');
      return structuredClone(next);
    },
    async recordPublication(context, reference) {
      if (reference.origin.clinic !== context.organizationId) throw new Error('access_refused');
      if (publications.has(reference.publicationId)) throw new Error('conflict');
      publications.set(reference.publicationId, structuredClone(reference));
      event(reference.artifactId, `published:v${reference.version}`);
    },
    async publication(context, artifactId, publicationId) {
      const recorded = publications.get(publicationId);
      if (!recorded || recorded.artifactId !== artifactId || recorded.origin.clinic !== context.organizationId) return null;
      return structuredClone(recorded);
    },
    async unresolvedReservations(context, programId, before) {
      return [...reservations.values()].filter(r => r.clinic === context.organizationId && r.programId === programId
        && Date.parse(r.acceptBefore) <= Date.parse(before) && !committed(r.artifactId)
        && (r.state !== 'abandoned' || r.unresolvedStorage)).map(r => ({ ...r }));
    },
  };
  return ledger;
}
