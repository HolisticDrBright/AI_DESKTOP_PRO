if (typeof window !== 'undefined') throw new Error('programs/program-media-authoring is server-only.');
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import {
  PROGRAM_MEDIA_REFERENCE_CONTRACT, programMediaAdmitRequest, programMediaArtifact, programMediaExtension, programMediaPrepareRequest,
  programMediaPreview, programMediaReadRequest, programMediaReference, programMediaReferenceStatus, programMediaReservation,
  programMediaStorageSchema, programMediaText, programMediaTextRequest, programMediaVersionRequest,
  type ProgramMediaArtifact, type ProgramMediaCleanupReceipt, type ProgramMediaFailure, type ProgramMediaLease, type ProgramMediaPreview,
  type ProgramMediaReference, type ProgramMediaReservation, type ProgramMediaStorage,
} from '@/contracts/programMedia';

/**
 * Authoring of governed lesson media: prepare, admit within bounds, commit with integrity recorded,
 * attach supplied captions or transcripts, preview by a separate read, publish by exact artifact
 * and version, retire, reconcile and clean up. The ledger and the object store are interfaces; the
 * only implementations in this repository are fictional (program-media-fictional.ts). Activation is
 * off: `PROGRAM_MEDIA_ACTIVATION.enabled` is false and the runtime refuses every operation until a
 * reviewed store and ledger exist. A fictional store proving these journeys certifies nothing hosted.
 *
 * The fence. Every party that may touch a reservation's object holds a durable lease recorded in
 * the ledger: a writer (`admit`, `reconcile`) holds `writing`, cleanup holds `cleaning`, and the
 * ledger grants a lease only when no unexpired lease of the other kind exists and the artifact is
 * not committed. A commit must present the writer's lease token; the ledger refuses a commit whose
 * lease was lost. No SQL lock is held across a store call: the lease is a row the ledger writes
 * before the call and checks after it. A writer that finds its lease gone after the store wrote
 * marks the reservation's storage unresolved, so a late write is never hidden. Cleanup certifies a
 * removal only after reading the exact version back absent, with no delete marker; anything else
 * stays unresolved. An expired acceptance window stops new writes and nothing else: existing bytes
 * are inspected and either recovered or proven absent, never assumed gone.
 *
 * Rules the code keeps:
 *   - educational purpose only: a context that carries PHI is refused, the storage must declare
 *     itself dedicated, and no patient identity is anywhere in the inputs;
 *   - a lost response never duplicates an upload and never claims a publication;
 *   - an uncertain write is never deleted; cleanup removes only an object proven to belong to an
 *     uncommitted reservation it holds the lease on, and certifies only what it read back;
 *   - a caption or transcript is supplied material with its source declared; nothing is generated;
 *   - a reference is a recorded publication, found by its identity and compared whole; a caller's
 *     plausible copy is not one;
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

export type ProgramMediaStoredObject = {
  version?: string; bytes?: number; contentType?: string; checksum?: string; checksumType?: string;
  encryption?: string; kmsKeyArn?: string; metadata?: Record<string, string>; deleteMarker?: boolean;
};
export interface ProgramMediaObjectStore {
  /** Conditional create (If-None-Match: *). Resolves with the stored version; rejects when the key exists or the write fails. */
  put(reservation: ProgramMediaReservation, bytes: Uint8Array, signal: AbortSignal): Promise<{ version?: string }>;
  /** Null when nothing exists at the key (and version, when given); a delete marker is reported as an object with `deleteMarker: true`. Rejects on a store error. */
  head(reservation: ProgramMediaReservation, objectVersion: string | undefined, signal: AbortSignal): Promise<ProgramMediaStoredObject | null>;
  /** Removes exactly the named version. Only cleanup calls it, only under its lease, and its return proves nothing by itself. */
  remove(reservation: ProgramMediaReservation, objectVersion: string, signal: AbortSignal): Promise<void>;
  /** A short-lived read handle for the author's preview; never the published address. */
  preview(artifact: ProgramMediaArtifact, signal: AbortSignal): Promise<{ token: string; until: string }>;
}

export type ProgramMediaWriterSettlement =
  | { state: 'reserved' | 'error'; failure: string | null; unresolvedStorage: boolean }
  | { state: 'abandoned'; failure: string; absenceProvenAt: string }
  | { state: 'held'; failure: string };
export type ProgramMediaCleanupSettlement =
  | { state: 'abandoned'; failure: string; absenceProvenAt: string }
  | { state: 'error' | 'reserved'; failure: string; unresolvedStorage: boolean }
  | { state: 'held'; failure: string };

export interface ProgramMediaLedger {
  /** Whether this workforce actor may author media for this program in this clinic. */
  authorize(context: ClinicalRequestContext, programId: string): Promise<boolean>;
  /** Idempotent on (clinic, programId, commandId): the same command returns the earlier reservation with `replayed: true`; a different payload under the same command conflicts. */
  reserve(context: ClinicalRequestContext, reservation: Omit<ProgramMediaReservation, 'replayed'>): Promise<ProgramMediaReservation>;
  reservation(context: ClinicalRequestContext, artifactId: string): Promise<ProgramMediaReservation | null>;
  artifact(context: ClinicalRequestContext, artifactId: string): Promise<ProgramMediaArtifact | null>;
  /** Take the writer lease: refused (null) while cleanup holds an unexpired lease, while another writer does, or once the artifact is committed, held or proven absent. */
  beginWrite(context: ClinicalRequestContext, artifactId: string, lease: ProgramMediaLease): Promise<ProgramMediaReservation | null>;
  /** reserved|writing|error -> ready with the proven object version, only for the writer whose lease token this is and only while it is unexpired. Idempotent for the same version. */
  commit(context: ClinicalRequestContext, artifactId: string, token: string, objectVersion: string, committedAt: string): Promise<ProgramMediaArtifact>;
  /** Release the writer lease with the outcome. A token that no longer holds the lease is refused. */
  endWrite(context: ClinicalRequestContext, artifactId: string, token: string, settlement: ProgramMediaWriterSettlement): Promise<void>;
  /** Take the cleanup lease: refused (null) while a writer holds an unexpired lease, while another cleanup does, or once the artifact is committed, held or proven absent. */
  claimCleanup(context: ClinicalRequestContext, artifactId: string, lease: ProgramMediaLease): Promise<ProgramMediaReservation | null>;
  /** Release the cleanup lease with what was proven. A token that no longer holds the lease is refused. */
  settleCleanup(context: ClinicalRequestContext, artifactId: string, token: string, settlement: ProgramMediaCleanupSettlement): Promise<void>;
  /** Record that bytes may exist that nothing accounts for (a write that landed after its lease was lost). Never clears. */
  markUnresolved(context: ClinicalRequestContext, artifactId: string, reason: string): Promise<void>;
  /** The artifact is held for review; its object is never deleted by cleanup. Usable without a lease when a proof failed. */
  hold(context: ClinicalRequestContext, artifactId: string, failure: string): Promise<void>;
  attachText(context: ClinicalRequestContext, artifactId: string, expectedVersion: number, slot: 'caption' | 'transcript', text: ProgramMediaArtifact['caption']): Promise<ProgramMediaArtifact>;
  retire(context: ClinicalRequestContext, artifactId: string, expectedVersion: number, retiredAt: string): Promise<ProgramMediaArtifact>;
  recordPublication(context: ClinicalRequestContext, reference: ProgramMediaReference): Promise<void>;
  /** The publication exactly as recorded, by its identity, or null. */
  publication(context: ClinicalRequestContext, artifactId: string, publicationId: string): Promise<ProgramMediaReference | null>;
  /** Reservations past their acceptance window whose storage is not accounted for: not committed, not held, not proven absent. Includes expired leases and abandoned rows with unresolved storage. */
  unresolvedReservations(context: ClinicalRequestContext, programId: string, before: string): Promise<ProgramMediaReservation[]>;
}

const ACCEPT_WINDOW_MS = 15 * 60 * 1000;
const STORE_TIMEOUT_MS = 20_000;
const LEASE_MS = 90_000;

export function createProgramMediaAuthoring(input: {
  ledger: ProgramMediaLedger;
  store: ProgramMediaObjectStore;
  storage: ProgramMediaStorage;
  activation?: ProgramMediaActivation;
  now?: () => Date;
  newId?: () => string;
}) {
  const { ledger, store } = input;
  const activation = input.activation ?? PROGRAM_MEDIA_ACTIVATION;
  const storage = programMediaStorageSchema.parse(input.storage);
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? randomUUID;
  const signal = () => AbortSignal.timeout(STORE_TIMEOUT_MS);
  const lease = (holder: ProgramMediaLease['holder']): ProgramMediaLease => ({ holder, token: randomBytes(24).toString('hex'), until: new Date(now().getTime() + LEASE_MS).toISOString() });
  const expired = (reservation: ProgramMediaReservation) => Date.parse(reservation.acceptBefore) <= now().getTime();

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
    return typeof head.version === 'string' && head.version.length > 0 && head.deleteMarker !== true
      && head.bytes === reservation.bytes && head.contentType === reservation.contentType
      && head.checksum === expectedChecksum(reservation.sha256) && head.checksumType === 'FULL_OBJECT'
      && head.encryption === 'aws:kms' && head.kmsKeyArn === storage.kmsKeyArn
      && head.metadata?.['artifact-id'] === reservation.artifactId && head.metadata?.['program-id'] === reservation.programId
      && head.metadata?.['clinic'] === reservation.clinic && head.metadata?.['purpose'] === 'educational_media';
  }
  /** Absence of the exact key: nothing at the named version and nothing (no object, no delete marker) as the latest. Errors are not absence. */
  async function provenAbsent(reservation: ProgramMediaReservation, version: string | null): Promise<boolean> {
    if (version !== null && (await store.head(reservation, version, signal())) !== null) return false;
    return (await store.head(reservation, undefined, signal())) === null;
  }
  function referenceFor(artifact: ProgramMediaArtifact, publishedAt: string): ProgramMediaReference {
    return programMediaReference.parse({
      contractVersion: PROGRAM_MEDIA_REFERENCE_CONTRACT, publicationId: newId(),
      artifactId: artifact.artifactId, version: artifact.version, sha256: artifact.sha256, kind: artifact.kind, contentType: artifact.contentType, bytes: artifact.bytes,
      origin: { clinic: artifact.clinic, programId: artifact.programId },
      url: storage.publicOrigin.replace(/\/$/, '') + '/' + artifact.objectKey,
      publishedAt,
      caption: artifact.caption ? { source: artifact.caption.source, sha256: artifact.caption.sha256 } : null,
      transcript: artifact.transcript ? { source: artifact.transcript.source, sha256: artifact.transcript.sha256, format: artifact.transcript.format } : null,
    });
  }

  /**
   * Under a writer lease: prove the object at the key (or at the version the writer just stored) and commit it.
   * `storedVersion` is what the writer's own put returned, when it returned; otherwise the latest is proven.
   */
  async function proveAndCommit(context: ClinicalRequestContext, reservation: ProgramMediaReservation, token: string, storedVersion: string | undefined, afterFailedPut = false): Promise<ProgramMediaArtifact> {
    let head: ProgramMediaStoredObject | null;
    try { head = await store.head(reservation, storedVersion, signal()); }
    catch {
      await ledger.endWrite(context, reservation.artifactId, token, { state: 'error', failure: 'store_unproven', unresolvedStorage: true });
      throw new ProgramMediaError('service_unavailable');
    }
    if (!head) {
      // Nothing readable: after a failed put that is a failed write; after a put that reported a version it is bytes the
      // store will not show us, which stays unresolved. Neither is ready, neither is proven absent for good.
      await ledger.endWrite(context, reservation.artifactId, token, afterFailedPut
        ? { state: 'error', failure: 'store_write_failed', unresolvedStorage: reservation.unresolvedStorage }
        : { state: 'error', failure: 'store_unproven', unresolvedStorage: true });
      throw new ProgramMediaError('service_unavailable');
    }
    if (!objectMatches(head, reservation)) {
      await ledger.endWrite(context, reservation.artifactId, token, { state: 'held', failure: 'storage_unverified' });
      throw new ProgramMediaError('storage_unverified');
    }
    try {
      return programMediaArtifact.parse(await ledger.commit(context, reservation.artifactId, token, head.version!, now().toISOString()));
    } catch {
      // The lease was lost between the store call and the commit: bytes exist that the ledger does not account for.
      await ledger.markUnresolved(context, reservation.artifactId, 'commit_refused_after_write');
      throw new ProgramMediaError('conflict');
    }
  }

  /** The writer's path once it holds the lease: inspect, recover, write within the window, or prove absence. */
  async function writeUnderLease(context: ClinicalRequestContext, reservation: ProgramMediaReservation, token: string, bytes: Uint8Array | null): Promise<ProgramMediaArtifact> {
    let present: ProgramMediaStoredObject | null;
    try { present = await store.head(reservation, undefined, signal()); }
    catch {
      await ledger.endWrite(context, reservation.artifactId, token, { state: 'error', failure: 'store_unreachable', unresolvedStorage: reservation.unresolvedStorage });
      throw new ProgramMediaError('service_unavailable');
    }
    if (present) {
      // Bytes already there, from an earlier write whose reply was lost: prove them, never write over them.
      return proveAndCommit(context, reservation, token, undefined);
    }
    if (bytes === null || expired(reservation)) {
      // Nothing stored. Past the window no new write is admitted; absence has just been proven, so the reservation may rest.
      if (expired(reservation)) {
        await ledger.endWrite(context, reservation.artifactId, token, { state: 'abandoned', failure: 'reservation_expired', absenceProvenAt: now().toISOString() });
        throw new ProgramMediaError('reservation_expired');
      }
      await ledger.endWrite(context, reservation.artifactId, token, { state: 'reserved', failure: null, unresolvedStorage: false });
      throw new ProgramMediaError('not_ready');
    }
    let version: string | undefined;
    try {
      version = (await store.put(reservation, bytes, signal())).version;
    } catch {
      // A conditional conflict or a lost response: the object may now exist. Prove the latest; never assume, never overwrite.
      return proveAndCommit(context, reservation, token, undefined, true);
    }
    return proveAndCommit(context, reservation, token, version);
  }

  async function takeWriterLease(context: ClinicalRequestContext, reservation: ProgramMediaReservation): Promise<{ token: string; reservation: ProgramMediaReservation }> {
    const held = lease('writer');
    const granted = await ledger.beginWrite(context, reservation.artifactId, held);
    if (!granted) throw new ProgramMediaError('conflict');
    return { token: held.token, reservation: granted };
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
        lease: null, absenceProvenAt: null, unresolvedStorage: false,
      });
      return programMediaReservation.parse(reservation);
    },

    /**
     * Admit the bytes for a reservation under the writer lease. A retry after a lost response proves the existing
     * object; it never writes twice. Past the acceptance window nothing new is written, but bytes already there are
     * recovered and only a proven-empty key lets the reservation rest.
     */
    async admit(context: ClinicalRequestContext, request: unknown, bytes: Uint8Array): Promise<ProgramMediaArtifact> {
      const parsed = programMediaAdmitRequest.safeParse(request);
      if (!parsed.success || !(bytes instanceof Uint8Array) || bytes.byteLength !== parsed.data.bytes
        || createHash('sha256').update(bytes).digest('hex') !== parsed.data.sha256) throw new ProgramMediaError('request_invalid');
      const reservation = await owned(context, () => ledger.reservation(context, parsed.data.artifactId));
      if (reservation.sha256 !== parsed.data.sha256 || reservation.bytes !== parsed.data.bytes) throw new ProgramMediaError('request_invalid');
      const existing = await ledger.artifact(context, reservation.artifactId);
      if (existing && existing.state === 'ready') return existing;
      if (existing && (existing.state === 'retired' || existing.state === 'held')) throw new ProgramMediaError('conflict');
      if (reservation.state === 'abandoned' && !reservation.unresolvedStorage) throw new ProgramMediaError('reservation_expired');
      const held = await takeWriterLease(context, reservation);
      return writeUnderLease(context, held.reservation, held.token, expired(held.reservation) ? null : bytes);
    },

    /** Settle a reservation whose outcome was lost, under the writer lease: commit a proven object, prove absence, hold a mismatch. */
    async reconcile(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaArtifact | ProgramMediaReservation> {
      const parsed = programMediaReadRequest.safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const reservation = await owned(context, () => ledger.reservation(context, parsed.data.artifactId));
      const existing = await ledger.artifact(context, reservation.artifactId);
      if (existing && (existing.state === 'ready' || existing.state === 'retired' || existing.state === 'held')) return existing;
      if (reservation.state === 'abandoned' && !reservation.unresolvedStorage) return reservation;
      const held = await takeWriterLease(context, reservation);
      try {
        return await writeUnderLease(context, held.reservation, held.token, null);
      } catch (error) {
        if (error instanceof ProgramMediaError && (error.code === 'not_ready' || error.code === 'reservation_expired')) {
          return programMediaReservation.parse(await ledger.reservation(context, reservation.artifactId));
        }
        throw error;
      }
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

    /**
     * What a reference means now. The reference is looked up by its publication identity and compared whole with what
     * the ledger recorded: a copy that differs in any field (address, origin, bytes, text provenance, time) is not a
     * publication and is refused. The recorded publication is returned, never the caller's copy.
     */
    async describeReference(context: ClinicalRequestContext, value: unknown) {
      const parsed = programMediaReference.safeParse(value);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      const artifact = await owned(context, () => ledger.artifact(context, parsed.data.artifactId));
      const recorded = await ledger.publication(context, artifact.artifactId, parsed.data.publicationId);
      if (!recorded || JSON.stringify(recorded) !== JSON.stringify(programMediaReference.parse(parsed.data))) throw new ProgramMediaError('not_found');
      return programMediaReferenceStatus.parse({
        reference: recorded,
        historical: artifact.state === 'retired',
        superseded: artifact.version !== recorded.version,
        current: artifact.state === 'ready' && artifact.version === recorded.version && artifact.sha256 === recorded.sha256 && artifact.objectVersion !== null,
      });
    },

    /**
     * Orphan cleanup for one program, under the cleanup lease per reservation. A removal is certified only after the
     * exact version is read back absent with nothing (no object, no delete marker) remaining at the key; a denied,
     * uncertain or still-present outcome leaves the reservation unresolved and says so.
     */
    async cleanupOrphans(context: ClinicalRequestContext, request: unknown): Promise<ProgramMediaCleanupReceipt> {
      const parsed = programMediaReadRequest.omit({ artifactId: true }).extend({ programId: programMediaReadRequest.shape.artifactId }).strict().safeParse(request);
      if (!parsed.success) throw new ProgramMediaError('request_invalid');
      await authorize(context, parsed.data.programId);
      const checkedAt = now().toISOString();
      const actions: ProgramMediaCleanupReceipt['actions'] = [];
      const act = (artifactId: string, outcome: ProgramMediaCleanupReceipt['actions'][number]['outcome'], detail: string | null = null, proof: ProgramMediaCleanupReceipt['actions'][number]['proof'] = null) =>
        actions.push({ artifactId, outcome, proof, detail });
      for (const listed of await ledger.unresolvedReservations(context, parsed.data.programId, checkedAt)) {
        if (listed.clinic !== context.organizationId || listed.programId !== parsed.data.programId) continue;
        const held = lease('cleanup');
        const reservation = await ledger.claimCleanup(context, listed.artifactId, held);
        if (!reservation) {
          const artifact = await ledger.artifact(context, listed.artifactId);
          if (artifact && (artifact.state === 'ready' || artifact.state === 'retired' || artifact.state === 'held')) act(listed.artifactId, 'kept_pending', artifact.state);
          else act(listed.artifactId, 'claim_refused', 'a writer holds the reservation or the lease could not be taken');
          continue;
        }
        const token = held.token;
        let head: ProgramMediaStoredObject | null;
        try { head = await store.head(reservation, undefined, signal()); }
        catch {
          await ledger.settleCleanup(context, reservation.artifactId, token, { state: 'error', failure: 'store_unreachable', unresolvedStorage: true });
          act(reservation.artifactId, 'removal_unproven', 'the store could not be read');
          continue;
        }
        if (!head) {
          const absenceProvenAt = now().toISOString();
          await ledger.settleCleanup(context, reservation.artifactId, token, { state: 'abandoned', failure: 'reservation_expired', absenceProvenAt });
          act(reservation.artifactId, 'abandoned_no_object', null, { removedVersion: null, absenceProvenAt });
          continue;
        }
        if (!objectMatches(head, reservation)) {
          await ledger.settleCleanup(context, reservation.artifactId, token, { state: 'held', failure: 'storage_unverified' });
          act(reservation.artifactId, 'held_object_mismatch', head.deleteMarker ? 'a delete marker stands at the key' : 'an object is present that is not this reservation\'s');
          continue;
        }
        // The bytes are exactly the reservation's and nothing was committed against them while we hold the lease.
        const version = head.version!;
        let absent = false;
        let detail = 'the exact version still stands after the delete call';
        try {
          await store.remove(reservation, version, signal());
          absent = await provenAbsent(reservation, version);
          if (!absent) {
            const latest = await store.head(reservation, undefined, signal());
            if (latest?.deleteMarker) detail = 'a delete marker stands at the key; versions may remain beneath it';
          }
        } catch {
          absent = false;
          detail = 'the delete or the read-back failed';
        }
        if (!absent) {
          await ledger.settleCleanup(context, reservation.artifactId, token, { state: 'error', failure: 'removal_unproven', unresolvedStorage: true });
          act(reservation.artifactId, 'removal_unproven', detail);
          continue;
        }
        const absenceProvenAt = now().toISOString();
        await ledger.settleCleanup(context, reservation.artifactId, token, { state: 'abandoned', failure: 'orphan_removed', absenceProvenAt });
        act(reservation.artifactId, 'abandoned_object_removed', null, { removedVersion: version, absenceProvenAt });
      }
      return { programId: parsed.data.programId, checkedAt, actions };
    },
  };
}
export type ProgramMediaAuthoring = ReturnType<typeof createProgramMediaAuthoring>;
