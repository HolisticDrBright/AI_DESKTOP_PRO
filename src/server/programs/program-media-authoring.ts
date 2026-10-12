if (typeof window !== 'undefined') throw new Error('programs/program-media-authoring is server-only.');
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import {
  PROGRAM_MEDIA_REFERENCE_CONTRACT, programMediaAdmitRequest, programMediaArtifact, programMediaExtension, programMediaPrepareRequest,
  programMediaPreview, programMediaReadRequest, programMediaReference, programMediaReferenceStatus, programMediaReservation,
  programMediaStorageSchema, programMediaText, programMediaTextRequest, programMediaVersionRequest, programMediaCleanupReceipt,
  type ProgramMediaArtifact, type ProgramMediaCleanupReceipt, type ProgramMediaFailure, type ProgramMediaPreview,
  type ProgramMediaReference, type ProgramMediaReservation, type ProgramMediaStorage,
} from '@/contracts/programMedia';

/**
 * Authoring of governed lesson media: prepare, admit within bounds, commit with integrity recorded,
 * attach supplied captions or transcripts, preview by a separate read, publish by exact artifact
 * and version, retire, reconcile and clean up. The ledger and the object store are interfaces; the
 * native ledger has an embedded-PostgreSQL restricted-role journey; its candidate is still
 * BLOCKED and uninstalled. The AWS SDK storage source and native request factory are
 * separately tested over fictional network replies, not installed or hosted
 * qualified. Activation is off: `PROGRAM_MEDIA_ACTIVATION.enabled` is false and every operation refuses until a
 * reviewed store and ledger exist. A fictional store proving these journeys certifies nothing hosted.
 *
 * Rules the code keeps:
 *   - educational purpose only: a context that carries PHI is refused, the storage must declare
 *     itself dedicated, and no patient identity is anywhere in the inputs;
 *   - a lost response never duplicates an upload (the reservation is idempotent on the command,
 *     the write is conditional, and a retry proves the existing object instead of writing again)
 *     and never claims a publication (a reference exists only when the ledger recorded it);
 *   - an uncertain write is never deleted; cleanup removes only an object that provably belongs
 *     to an uncommitted reservation, and anything it cannot prove is held for review;
 *   - a caption or transcript is supplied material with its source declared; nothing is generated;
 *   - authoring writes and preview reads are different operations; retirement refuses new
 *     publication and keeps earlier references truthful.
 */
export const PROGRAM_MEDIA_ACTIVATION: Readonly<{ enabled: boolean; reason: string }> = Object.freeze({
  enabled: false,
  reason: 'No reviewed dedicated educational-media store or ledger exists. See docs/program-media-authoring-2026-10-11.md.',
});
export type ProgramMediaActivation = { enabled: boolean; reason: string };

export class ProgramMediaError extends Error {
  constructor(readonly code: ProgramMediaFailure) { super(code); this.name = 'ProgramMediaError'; }
}

/** Only a store adapter that knows a write was rejected before mutation may
 * mark it settled. Timeouts, aborts and lost replies are uncertain by default. */
export class ProgramMediaWriteError extends Error {
  constructor(readonly settled: boolean) { super('program_media_store_write_failed'); }
}

export type ProgramMediaStoredObject = {
  version?: string; bytes?: number; contentType?: string; checksum?: string; checksumType?: string;
  encryption?: string; kmsKeyArn?: string; metadata?: Record<string, string>; deleteMarker?: boolean;
  /** Exact key observed by a complete version listing; mandatory for markers. */
  listedKey?: string;
};
export interface ProgramMediaObjectStore {
  /** Conditional create (If-None-Match: *). Resolves with the stored version; rejects when the key exists or the write fails. */
  put(reservation: ProgramMediaReservation, bytes: Uint8Array, signal: AbortSignal): Promise<{ version?: string }>;
  /** Null when no object exists at the key (and version, when given). */
  head(reservation: ProgramMediaReservation, objectVersion: string | undefined, signal: AbortSignal): Promise<ProgramMediaStoredObject | null>;
  /** Removes exactly the named version. Only cleanup calls it, only for an orphan it proved. */
  remove(reservation: ProgramMediaReservation, objectVersion: string, signal: AbortSignal): Promise<void>;
  /** Complete, exact-key VERSION inventory, not a latest-object HEAD. An
   * incomplete page, denial or ambiguous key is never absence. */
  inventory(reservation: ProgramMediaReservation, signal: AbortSignal): Promise<{ complete: boolean; versions: ProgramMediaStoredObject[] }>;
  /** A short-lived read handle for the author's preview; never the published address. */
  preview(artifact: ProgramMediaArtifact, signal: AbortSignal): Promise<{ token: string; until: string }>;
}

export interface ProgramMediaLedger {
  /** Whether this workforce actor may author media for this program in this clinic. */
  authorize(context: ClinicalRequestContext, programId: string): Promise<boolean>;
  /** Idempotent on (clinic, programId, commandId): the same command returns the earlier reservation with `replayed: true`; a different payload under the same command conflicts. */
  reserve(context: ClinicalRequestContext, reservation: Omit<ProgramMediaReservation, 'replayed'>): Promise<ProgramMediaReservation>;
  reservation(context: ClinicalRequestContext, artifactId: string): Promise<ProgramMediaReservation | null>;
  artifact(context: ClinicalRequestContext, artifactId: string): Promise<ProgramMediaArtifact | null>;
  /** reserved|error -> ready with the proven object version. Idempotent for the same version; a different version conflicts. */
  commit(context: ClinicalRequestContext, artifactId: string, objectVersion: string, committedAt: string, claimId: string): Promise<ProgramMediaArtifact>;
  settle(context: ClinicalRequestContext, artifactId: string, state: 'held' | 'error' | 'abandoned', failure: string, claimId?: string): Promise<void>;
  /** These are atomic DURABLE ledger operations. Multiple writers may admit;
   * cleanup may seal the artifact only after every writer is settled. Unknown
   * writers never expire automatically. Commit checks the same claim in its
   * transaction. This is not a process-local mutex or an HTTP proof. */
  beginWriter(context: ClinicalRequestContext, artifactId: string, claimId: string, mode: 'admit' | 'reconcile', at: string): Promise<boolean>;
  finishWriter(context: ClinicalRequestContext, artifactId: string, claimId: string, outcome: 'settled' | 'uncertain'): Promise<void>;
  beginCleanup(context: ClinicalRequestContext, artifactId: string, claimId: string, at: string): Promise<boolean>;
  certifyCleanup(context: ClinicalRequestContext, artifactId: string, claimId: string, proof: ProgramMediaAbsenceProof): Promise<void>;
  attachText(context: ClinicalRequestContext, artifactId: string, expectedVersion: number, slot: 'caption' | 'transcript', text: ProgramMediaArtifact['caption']): Promise<ProgramMediaArtifact>;
  retire(context: ClinicalRequestContext, artifactId: string, expectedVersion: number, retiredAt: string): Promise<ProgramMediaArtifact>;
  recordPublication(context: ClinicalRequestContext, reference: ProgramMediaReference): Promise<void>;
  hasPublication(context: ClinicalRequestContext, reference: ProgramMediaReference): Promise<boolean>;
  expiredReservations(context: ClinicalRequestContext, programId: string, before: string): Promise<ProgramMediaReservation[]>;
}

export type ProgramMediaAbsenceProof = { artifactId: string; claimId: string; objectKey: string;
  checkedAt: string; complete: true; remainingVersions: 0; removedVersions: string[] };

const ACCEPT_WINDOW_MS = 15 * 60 * 1000;
const STORE_TIMEOUT_MS = 20_000;

export function createProgramMediaAuthoring(input: {
  ledger: ProgramMediaLedger;
  store: ProgramMediaObjectStore;
  storage: ProgramMediaStorage;
  activation?: ProgramMediaActivation;
  now?: () => Date;
  newId?: () => string;
}) {
  const { ledger, store } = input;
  const activation = Object.freeze({ ...(input.activation ?? PROGRAM_MEDIA_ACTIVATION) });
  const storage = programMediaStorageSchema.parse(input.storage);
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? randomUUID;
  const signal = () => AbortSignal.timeout(STORE_TIMEOUT_MS);

  async function authorize(context: ClinicalRequestContext, programId: string) {
    if (!activation.enabled) throw new ProgramMediaError('program_media_disabled');
    // Educational media is never clinical data: a context that carries PHI, or is not a workforce member of a clinic, is refused.
    if (context.identityPool !== 'workforce' || context.containsPhi !== false || context.realPatientData !== false
      || context.environment !== 'synthetic-staging' || context.dataClassification !== 'synthetic_only') throw new ProgramMediaError('access_refused');
    if (!(await ledger.authorize(context, programId))) throw new ProgramMediaError('access_refused');
  }
  async function owned<T extends { clinic: string; programId: string }>(context: ClinicalRequestContext, lookup: () => Promise<T | null>): Promise<T> {
    if (!activation.enabled) throw new ProgramMediaError('program_media_disabled');
    const record = await lookup();
    if (!record || record.clinic !== context.organizationId) throw new ProgramMediaError('not_found');
    await authorize(context, record.programId);
    return record;
  }
  function expectedChecksum(sha256: string) { return Buffer.from(sha256, 'hex').toString('base64'); }
  function objectMatches(head: ProgramMediaStoredObject, reservation: ProgramMediaReservation): boolean {
    return typeof head.version === 'string' && head.version.length > 0 && head.version !== 'null' && head.deleteMarker !== true
      && head.bytes === reservation.bytes && head.contentType === reservation.contentType
      && head.checksum === expectedChecksum(reservation.sha256) && head.checksumType === 'FULL_OBJECT'
      && head.encryption === 'aws:kms' && head.kmsKeyArn === storage.kmsKeyArn
      && head.metadata?.['artifact-id'] === reservation.artifactId && head.metadata?.['program-id'] === reservation.programId
      && head.metadata?.['clinic'] === reservation.clinic && head.metadata?.['purpose'] === 'educational_media';
  }
  async function proveAndCommit(context: ClinicalRequestContext, reservation: ProgramMediaReservation, version: string | undefined, claimId: string): Promise<ProgramMediaArtifact> {
    const head = await store.head(reservation, version, signal());
    if (!head) throw new ProgramMediaError('service_unavailable');
    if (!objectMatches(head, reservation)) {
      await ledger.settle(context, reservation.artifactId, 'held', 'storage_unverified', claimId);
      throw new ProgramMediaError('storage_unverified');
    }
    return programMediaArtifact.parse(await ledger.commit(context, reservation.artifactId, head.version!, now().toISOString(), claimId));
  }
  function referenceFor(artifact: ProgramMediaArtifact, publishedAt: string): ProgramMediaReference {
    return programMediaReference.parse({
      contractVersion: PROGRAM_MEDIA_REFERENCE_CONTRACT,
      artifactId: artifact.artifactId, version: artifact.version, sha256: artifact.sha256, kind: artifact.kind, contentType: artifact.contentType, bytes: artifact.bytes,
      origin: { clinic: artifact.clinic, programId: artifact.programId },
      url: storage.publicOrigin.replace(/\/$/, '') + '/' + artifact.objectKey,
      publishedAt,
      caption: artifact.caption ? { source: artifact.caption.source, sha256: artifact.caption.sha256 } : null,
      transcript: artifact.transcript ? { source: artifact.transcript.source, sha256: artifact.transcript.sha256, format: artifact.transcript.format } : null,
    });
  }

  return {
    activation: () => ({ ...activation }),

    /** Reserve an artifact for exactly these bytes. Repeating the command returns the same reservation; it never makes a second one. */
    async prepare(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaReservation> {
      const parsed = programMediaPrepareRequest.safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const r = parsed.data;
      await authorize(context, r.programId);
      const limit = r.kind === 'image' ? storage.maxImageBytes : storage.maxVideoBytes;
      if (r.bytes > limit) throw new ProgramMediaError('request_invalid');
      const artifactId = newId();
      const created = now();
      const reservation = await ledger.reserve(context, {
        artifactId, clinic: context.organizationId, programId: r.programId, commandId: r.commandId, kind: r.kind, contentType: r.contentType,
        bytes: r.bytes, sha256: r.sha256,
        objectKey: `program-media/${context.organizationId}/${r.programId}/${artifactId}/${r.sha256}.${programMediaExtension(r.kind, r.contentType)}`,
        state: 'reserved', acceptBefore: new Date(created.getTime() + ACCEPT_WINDOW_MS).toISOString(), createdAt: created.toISOString(), failure: null,
      });
      return programMediaReservation.parse(reservation);
    },

    /** Admit the bytes for a reservation. A retry after a lost response proves the existing object; it never writes twice. */
    async admit(context: ClinicalRequestContext, request: unknown, bytes: Uint8Array): Promise<ProgramMediaArtifact> {
      const parsed = programMediaAdmitRequest.safeParse(request);
      if (!parsed.success || !(bytes instanceof Uint8Array) || bytes.byteLength !== parsed.data.bytes
        || bytes.byteLength > Math.max(storage.maxImageBytes, storage.maxVideoBytes)) throw new ProgramMediaError('request_invalid');
      const admittedBytes = new Uint8Array(bytes);
      if (createHash('sha256').update(admittedBytes).digest('hex') !== parsed.data.sha256) throw new ProgramMediaError('request_invalid');
      const reservation = await owned(context, () => ledger.reservation(context, parsed.data.artifactId));
      if (reservation.sha256 !== parsed.data.sha256 || reservation.bytes !== parsed.data.bytes) throw new ProgramMediaError('request_invalid');
      const existing = await ledger.artifact(context, reservation.artifactId);
      if (existing && existing.state === 'ready') return existing;
      if (existing && (existing.state === 'retired' || existing.state === 'held')) throw new ProgramMediaError('conflict');
      if (reservation.state === 'abandoned') throw new ProgramMediaError('reservation_expired');
      if (Date.parse(reservation.acceptBefore) <= now().getTime()) {
        await ledger.settle(context, reservation.artifactId, 'abandoned', 'reservation_expired');
        throw new ProgramMediaError('reservation_expired');
      }
      const claimId = newId();
      if (!await ledger.beginWriter(context, reservation.artifactId, claimId, 'admit', now().toISOString())) throw new ProgramMediaError('conflict');
      let uncertain = false;
      try {
        let version: string | undefined;
        try {
          version = (await store.put(reservation, admittedBytes, signal())).version;
        } catch (error) {
          uncertain = !(error instanceof ProgramMediaWriteError && error.settled);
          // A conditional conflict or a lost response: prove, never overwrite.
          const head = await store.head(reservation, undefined, signal()).catch(() => null);
          if (!head) { await ledger.settle(context, reservation.artifactId, 'error', 'store_write_failed', claimId); throw new ProgramMediaError('service_unavailable'); }
        }
        try {
          return await proveAndCommit(context, reservation, version, claimId);
        } catch (error) {
          if (error instanceof ProgramMediaError) {
            if (error.code === 'service_unavailable') await ledger.settle(context, reservation.artifactId, 'error', 'store_unproven', claimId);
            throw error;
          }
          await ledger.settle(context, reservation.artifactId, 'error', 'commit_failed', claimId);
          throw new ProgramMediaError('service_unavailable');
        }
      } finally {
        await ledger.finishWriter(context, reservation.artifactId, claimId, uncertain ? 'uncertain' : 'settled');
      }
    },

    /** Recover a proven object under writer admission. Expiry alone certifies no absence. */
    async reconcile(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaArtifact | ProgramMediaReservation> {
      const parsed = programMediaReadRequest.safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const reservation = await owned(context, () => ledger.reservation(context, parsed.data.artifactId));
      const existing = await ledger.artifact(context, reservation.artifactId);
      if (existing && existing.state !== 'error' && existing.state !== 'reserved') return existing;
      if (reservation.state === 'abandoned') return reservation;
      const claimId = newId();
      if (!await ledger.beginWriter(context, reservation.artifactId, claimId, 'reconcile', now().toISOString())) throw new ProgramMediaError('conflict');
      try {
        const head = await store.head(reservation, undefined, signal());
        if (head) return await proveAndCommit(context, reservation, undefined, claimId);
        return reservation;
      } finally { await ledger.finishWriter(context, reservation.artifactId, claimId, 'settled'); }
    },

    /** Attach a supplied caption or transcript. The source is declared by the author; a generated one has no admissible source. */
    async attachText(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaArtifact> {
      const parsed = programMediaTextRequest.safeParse(request);
      if (!parsed.success) {
        const source = typeof request === 'object' && request !== null ? (request as { source?: unknown }).source : undefined;
        throw new ProgramMediaError(typeof source === 'string' && !['supplied_by_author', 'supplied_vendor_file'].includes(source) ? 'text_source_refused' : 'request_invalid');
      }
      const r = parsed.data;
      const artifact = await owned(context, () => ledger.artifact(context, r.artifactId));
      if (artifact.state === 'retired') throw new ProgramMediaError('retired');
      if (artifact.state !== 'ready') throw new ProgramMediaError('not_ready');
      if (artifact.version !== r.expectedVersion) throw new ProgramMediaError('conflict');
      if (r.slot === 'transcript' && artifact.kind !== 'video') throw new ProgramMediaError('request_invalid');
      if (r.slot === 'caption' && artifact.kind !== 'video' && r.format !== 'plain') throw new ProgramMediaError('request_invalid');
      const text = programMediaText.parse({ text: r.text, source: r.source, format: r.format, sha256: createHash('sha256').update(r.text).digest('hex') });
      return programMediaArtifact.parse(await ledger.attachText(context, artifact.artifactId, r.expectedVersion, r.slot, text));
    },

    /** A read for the author's preview: a short-lived handle from the store, never the published address, never a write. */
    async preview(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaPreview> {
      const parsed = programMediaReadRequest.safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const artifact = await owned(context, () => ledger.artifact(context, parsed.data.artifactId));
      if (artifact.state !== 'ready' && artifact.state !== 'retired') throw new ProgramMediaError('not_ready');
      const handle = await store.preview(artifact, signal());
      return programMediaPreview.parse({
        artifactId: artifact.artifactId, version: artifact.version, state: artifact.state, kind: artifact.kind, contentType: artifact.contentType,
        bytes: artifact.bytes, sha256: artifact.sha256, previewToken: handle.token, previewUntil: handle.until, historical: artifact.state === 'retired',
      });
    },

    /** Publish exactly this artifact at exactly this version. A retired artifact is never newly published. */
    async publish(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaReference> {
      const parsed = programMediaVersionRequest.safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const artifact = await owned(context, () => ledger.artifact(context, parsed.data.artifactId));
      if (artifact.state === 'retired') throw new ProgramMediaError('retired');
      if (artifact.state !== 'ready') throw new ProgramMediaError('not_ready');
      if (artifact.version !== parsed.data.expectedVersion) throw new ProgramMediaError('conflict');
      const reference = referenceFor(artifact, now().toISOString());
      await ledger.recordPublication(context, reference);
      return reference;
    },

    /** Retire: no new publication, no new text; earlier references stay what they were. */
    async retire(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaArtifact> {
      const parsed = programMediaVersionRequest.safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const artifact = await owned(context, () => ledger.artifact(context, parsed.data.artifactId));
      if (artifact.state === 'retired') return artifact;
      if (artifact.state !== 'ready') throw new ProgramMediaError('not_ready');
      if (artifact.version !== parsed.data.expectedVersion) throw new ProgramMediaError('conflict');
      return programMediaArtifact.parse(await ledger.retire(context, artifact.artifactId, parsed.data.expectedVersion, now().toISOString()));
    },

    /** What an earlier reference means now: exact as published, and honest about retirement or a changed artifact. */
    async describeReference(context: ClinicalRequestContext, value: unknown) {
      const parsed = programMediaReference.safeParse(value);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const artifact = await owned(context, () => ledger.artifact(context, parsed.data.artifactId));
      const recorded = await ledger.hasPublication(context, parsed.data);
      return programMediaReferenceStatus.parse({
        reference: parsed.data,
        historical: recorded && artifact.state === 'retired',
        current: recorded && artifact.state === 'ready' && artifact.objectVersion !== null
          && JSON.stringify(referenceFor(artifact, parsed.data.publishedAt)) === JSON.stringify(parsed.data),
      });
    },

    /** Orphan cleanup for one program: removes only an object that provably belongs to an expired, uncommitted reservation. */
    async cleanupOrphans(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaCleanupReceipt> {
      const parsed = programMediaReadRequest.omit({ artifactId: true }).extend({ programId: programMediaReadRequest.shape.artifactId }).strict().safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      await authorize(context, parsed.data.programId);
      const checkedAt = now().toISOString();
      const actions: ProgramMediaCleanupReceipt['actions'] = [];
      const proofs: ProgramMediaAbsenceProof[] = [];
      for (const reservation of (await ledger.expiredReservations(context, parsed.data.programId, checkedAt)).slice(0, 1000)) {
        if (reservation.clinic !== context.organizationId || reservation.programId !== parsed.data.programId) continue;
        const artifact = await ledger.artifact(context, reservation.artifactId);
        if (artifact && (artifact.state === 'ready' || artifact.state === 'retired' || artifact.state === 'held')) { actions.push({ artifactId: reservation.artifactId, outcome: 'kept_pending' }); continue; }
        // This preliminary read admits no deletion. A competing reconciliation
        // can win here; the subsequent atomic ledger seal must then refuse.
        try { await store.head(reservation, undefined, signal()); }
        catch { actions.push({ artifactId: reservation.artifactId, outcome: 'kept_pending' }); continue; }
        const claimId = newId();
        if (!await ledger.beginCleanup(context, reservation.artifactId, claimId, now().toISOString())) {
          const latest = await ledger.artifact(context, reservation.artifactId);
          actions.push({ artifactId: reservation.artifactId, outcome: latest?.state === 'ready' ? 'recovered_ready' : 'kept_pending' }); continue;
        }
        try {
          const before = await store.inventory(reservation, signal());
          if (!before.complete || new Set(before.versions.map(v => v.version)).size !== before.versions.length) {
            actions.push({ artifactId: reservation.artifactId, outcome: 'kept_pending' }); continue;
          }
          if (before.versions.some(v => v.deleteMarker === true
            ? typeof v.version !== 'string' || !v.version || v.version === 'null' || v.listedKey !== reservation.objectKey
            : !objectMatches(v, reservation))) {
            await ledger.settle(context, reservation.artifactId, 'held', 'storage_unverified', claimId);
            actions.push({ artifactId: reservation.artifactId, outcome: 'held_object_mismatch' }); continue;
          }
          for (const version of before.versions) await store.remove(reservation, version.version!, signal());
          const after = await store.inventory(reservation, signal());
          if (!after.complete || after.versions.length !== 0) {
            actions.push({ artifactId: reservation.artifactId, outcome: 'kept_pending' }); continue;
          }
          const proof: ProgramMediaAbsenceProof = { artifactId: reservation.artifactId, claimId, objectKey: reservation.objectKey,
            checkedAt: now().toISOString(), complete: true, remainingVersions: 0, removedVersions: before.versions.map(v => v.version!) };
          await ledger.certifyCleanup(context, reservation.artifactId, claimId, proof);
          proofs.push(proof);
          actions.push({ artifactId: reservation.artifactId, outcome: before.versions.length ? 'abandoned_object_removed' : 'abandoned_no_object' });
        } catch { actions.push({ artifactId: reservation.artifactId, outcome: 'kept_pending' }); }
      }
      return programMediaCleanupReceipt.parse({ programId: parsed.data.programId, checkedAt, actions, proofs });
    },
  };
}
export type ProgramMediaAuthoring = ReturnType<typeof createProgramMediaAuthoring>;
