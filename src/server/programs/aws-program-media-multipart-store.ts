if (typeof window !== 'undefined') throw new Error('aws program media multipart store is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  ListMultipartUploadsCommand, ListPartsCommand, ListObjectVersionsCommand, HeadObjectCommand, GetObjectCommand,
  DeleteObjectCommand, S3ServiceException, type ListObjectVersionsCommandOutput } from '@aws-sdk/client-s3';
import { programMediaArtifact, programMediaExtension, type ProgramMediaArtifact } from '@/contracts/programMedia';
import { issueAwsProgramMediaVersionPreview } from './aws-program-media-preview';
import { ProgramMediaError, ProgramMediaWriteError } from './program-media-authoring';
import { programMediaCompositeChecksum } from './program-media-parts';
import { programMediaMultipartSessionSchema, type ProgramMediaMultipartSession } from './program-media-multipart-ledger';
import { openAwsProgramMediaResourceSource, type AwsProgramMediaStoreConfiguration,
  type ProgramMediaMultipartPolicyReview } from './aws-program-media-store';

/** Actual SDK source only. This port is for the qualified server, NEVER a
 * browser payload. It does not install a host, authorize a workforce session,
 * admit a DB intent, settle an uncertain writer, or issue a deletion receipt.
 * Each mutation requires the first durable ledger admission. The separate
 * resource review must be supplied by the reviewed host, not by the client. */
export type ProgramMediaMultipartAdmission = { admitted: boolean; claimId: string; session: ProgramMediaMultipartSession };
export type ProgramMediaMultipartPartObservation = { partNumber: number; bytes: number; checksum: string; etag: string };
export type ProgramMediaMultipartInventory = { complete: boolean; checkedAt: string;
  uploads: { uploadId: string; initiatedAt: string }[]; versions: { objectVersion: string; deleteMarker: boolean; bytes: number | null }[] };
const id = z.string().uuid(), providerId = z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/);
const objectVersion = providerId.refine(v => v !== 'null');
const invalid = () => new ProgramMediaError('storage_unverified');
const MAX_PAGES = 20, MAX_ITEMS = 1000;
const missingUpload = (e: unknown) => e instanceof S3ServiceException && e.name === 'NoSuchUpload' && e.$metadata.httpStatusCode === 404;

/** Race even an ignored SDK/body abort, without abandoning an unobserved
 * rejection. Aborting an await is NOT evidence that a remote writer stopped. */
async function interruptible<T>(work: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  const observed = work.then(value => {
    if (signal.aborted) { discard?.(value); throw new ProgramMediaError('access_refused'); }
    return value;
  });
  if (signal.aborted) { void observed.catch(() => undefined); throw new ProgramMediaError('access_refused'); }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([observed, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ProgramMediaError('access_refused'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** A GetObject response can arrive after its caller stopped waiting. Dispose
 * that body too; cancellation is resource cleanup, never settlement evidence. */
function discardBody(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const stream = body as { destroy?: () => void; cancel?: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
  try { stream.destroy?.(); } catch { /* best effort, no provider detail escapes */ }
  try {
    if (typeof stream.cancel === 'function') void Promise.resolve(stream.cancel()).catch(() => undefined);
    else {
      const iterator = stream[Symbol.asyncIterator]?.();
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  } catch { /* a throwing cancellation cannot replace the refusal */ }
}

export async function createAwsProgramMediaMultipartStoreSource(input: AwsProgramMediaStoreConfiguration,
  requestSignal: AbortSignal, review: ProgramMediaMultipartPolicyReview, currentActorId: string) {
  if (!id.safeParse(currentActorId).success || !review) throw invalid();
  const actorId = currentActorId;
  const opened = await openAwsProgramMediaResourceSource(input, requestSignal, review);
  const { s3, scope, storage, bucket, live, bounded, after, close } = opened;
  const consumed = new Set<string>();
  function checked(value: unknown): ProgramMediaMultipartSession {
    live();
    const parsed = programMediaMultipartSessionSchema.safeParse(value);
    if (!parsed.success) throw invalid();
    const s = parsed.data;
    if (s.actorId !== actorId || s.clinic !== scope.clinic || s.programId !== scope.programId
      || s.totalBytes !== s.manifest.totalBytes || s.totalBytes > storage.maxVideoBytes
      || s.checksum !== programMediaCompositeChecksum(s.manifest)
      || s.objectKey !== `program-media/${s.clinic}/${s.programId}/${s.artifactId}/${s.sha256}.${programMediaExtension(s.kind, s.contentType)}`) throw invalid();
    const seen = new Set<number>();
    for (const p of s.parts) {
      const expected = s.manifest.parts[p.partNumber - 1];
      if (!expected || seen.has(p.partNumber) || p.sha256 !== expected.sha256 || p.bytes !== expected.bytes
        || p.checksum !== Buffer.from(expected.sha256, 'hex').toString('base64') || !providerId.safeParse(p.etag).success) throw invalid();
      seen.add(p.partNumber);
    }
    return s;
  }
  const base = (s: ProgramMediaMultipartSession) => ({ ...bucket, Key: s.objectKey });
  const metadata = (s: ProgramMediaMultipartSession) => ({ 'artifact-id': s.artifactId, 'program-id': s.programId, clinic: s.clinic,
    purpose: 'educational_media', 'writer-claim-id': s.writerClaimId, 'whole-sha256': s.sha256 });
  function admission(value: ProgramMediaMultipartAdmission, kind: 'creation' | 'part' | 'completion', partNumber: number | null) {
    const s = checked(value.session);
    const state = kind === 'creation' ? 'creation_admitted' : kind === 'part' ? 'uploading' : 'completion_admitted';
    if (value.admitted !== true || !id.safeParse(value.claimId).success || consumed.has(value.claimId)
      || s.state !== state || s.objectVersion !== null
      || !s.pending.some(p => p.claimId === value.claimId && p.kind === kind && p.partNumber === partNumber && p.state === 'open')
      || (kind === 'creation' && (s.uploadId !== null || s.parts.length !== 0 || s.pending.length !== 1))
      || (kind !== 'creation' && !providerId.safeParse(s.uploadId).success)
      || (kind === 'part' && (!s.manifest.parts[(partNumber ?? 0) - 1] || s.parts.some(p => p.partNumber === partNumber)))
      || (kind === 'completion' && (s.parts.length !== s.manifest.parts.length || s.pending.length !== 1))) throw invalid();
    // This process-local fence supplements, never substitutes for, the ledger's
    // first-admission rule across processes. No retry is made by this port.
    consumed.add(value.claimId);
    return s;
  }
  async function mutate<T>(prepare: () => { session: ProgramMediaMultipartSession; send(signal: AbortSignal): Promise<unknown> },
    decode: (out: unknown, session: ProgramMediaMultipartSession) => T, signal: AbortSignal): Promise<T> {
    let prepared: ReturnType<typeof prepare>, bound: AbortSignal;
    try { bound = bounded(signal); prepared = prepare(); } catch { throw new ProgramMediaWriteError(true); }
    try {
      const out = await interruptible(prepared.send(bound), bound); after(signal);
      return decode(out, prepared.session);
    } catch (error) {
      const rejected = error instanceof S3ServiceException && error.name === 'PreconditionFailed' && error.$metadata.httpStatusCode === 412;
      throw new ProgramMediaWriteError(rejected);
    }
  }
  async function parts(value: ProgramMediaMultipartSession, signal: AbortSignal) {
    const s = checked(value), result: ProgramMediaMultipartPartObservation[] = [], cursors = new Set<string>(), seen = new Set<number>();
    if (!providerId.safeParse(s.uploadId).success) throw invalid();
    let marker: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const bound = bounded(signal);
        const out = await interruptible(s3.send(new ListPartsCommand({ ...base(s), UploadId: s.uploadId!, MaxParts: 100, PartNumberMarker: marker }), { abortSignal: bound }), bound); after(signal);
        if (out.Bucket !== storage.bucket || out.Key !== s.objectKey || out.UploadId !== s.uploadId || typeof out.IsTruncated !== 'boolean'
          || out.ChecksumAlgorithm !== 'SHA256' || out.ChecksumType !== 'COMPOSITE'
          || (out.Parts !== undefined && (!Array.isArray(out.Parts) || out.Parts.length > 100))) return { complete: false, parts: result };
        for (const p of out.Parts ?? []) {
          const expected = typeof p.PartNumber === 'number' ? s.manifest.parts[p.PartNumber - 1] : undefined;
          if (!expected || seen.has(p.PartNumber!) || p.Size !== expected.bytes || p.ChecksumSHA256 !== Buffer.from(expected.sha256, 'hex').toString('base64')
            || !providerId.safeParse(p.ETag).success) return { complete: false, parts: result };
          seen.add(p.PartNumber!); result.push({ partNumber: p.PartNumber!, bytes: p.Size!, checksum: p.ChecksumSHA256!, etag: p.ETag! });
        }
        if (!out.IsTruncated) return { complete: true, parts: result.sort((a, b) => a.partNumber - b.partNumber) };
        const next = out.NextPartNumberMarker;
        if (typeof next !== 'string' || !/^[1-9][0-9]?$/.test(next) || Number(next) <= Number(marker ?? '0')
          || Number(next) > s.manifest.parts.length || cursors.has(next)) break;
        marker = next; cursors.add(marker);
      }
    } catch { /* Failed/aborted listing is not a missing upload or absence. */ }
    return { complete: false, parts: result };
  }
  async function inventory(value: ProgramMediaMultipartSession, signal: AbortSignal): Promise<ProgramMediaMultipartInventory> {
    const s = checked(value), uploads: ProgramMediaMultipartInventory['uploads'] = [], versions: ProgramMediaMultipartInventory['versions'] = [];
    const incomplete = () => ({ complete: false, checkedAt: new Date().toISOString(), uploads, versions });
    try {
      let keyMarker: string | undefined, uploadMarker: string | undefined;
      const cursors = new Set<string>(), seen = new Set<string>(); let uploadsDone = false, observedUploads = 0, observedVersions = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const bound = bounded(signal);
        const out = await interruptible(s3.send(new ListMultipartUploadsCommand({ ...bucket, Prefix: s.objectKey, MaxUploads: 100,
          KeyMarker: keyMarker, UploadIdMarker: uploadMarker }), { abortSignal: bound }), bound); after(signal);
        if (out.Bucket !== storage.bucket || typeof out.IsTruncated !== 'boolean' || (out.CommonPrefixes?.length ?? 0) > 0
          || (out.Uploads !== undefined && (!Array.isArray(out.Uploads) || out.Uploads.length > 100))) return incomplete();
        observedUploads += out.Uploads?.length ?? 0; if (observedUploads > MAX_ITEMS) return incomplete();
        for (const u of out.Uploads ?? []) {
          if (typeof u.Key !== 'string' || !u.Key.startsWith(s.objectKey)) return incomplete();
          if (u.Key !== s.objectKey) continue;
          if (!providerId.safeParse(u.UploadId).success || !(u.Initiated instanceof Date) || !Number.isFinite(u.Initiated.getTime())
            || seen.has(u.UploadId!) || seen.size >= MAX_ITEMS) return incomplete();
          seen.add(u.UploadId!); uploads.push({ uploadId: u.UploadId!, initiatedAt: u.Initiated.toISOString() });
        }
        if (!out.IsTruncated) { uploadsDone = true; break; }
        if (typeof out.NextKeyMarker !== 'string' || !out.NextKeyMarker.startsWith(s.objectKey)
          || (out.NextUploadIdMarker !== undefined && !providerId.safeParse(out.NextUploadIdMarker).success)
          || (out.NextKeyMarker === s.objectKey && !providerId.safeParse(out.NextUploadIdMarker).success)) return incomplete();
        const cursor = JSON.stringify([out.NextKeyMarker, out.NextUploadIdMarker]);
        if (cursors.has(cursor)) return incomplete(); cursors.add(cursor); keyMarker = out.NextKeyMarker; uploadMarker = out.NextUploadIdMarker;
      }
      if (!uploadsDone) return incomplete();
      keyMarker = undefined; let versionMarker: string | undefined; cursors.clear(); seen.clear();
      for (let page = 0; page < MAX_PAGES; page++) {
        const bound = bounded(signal);
        const out: ListObjectVersionsCommandOutput = await interruptible(s3.send(new ListObjectVersionsCommand({ ...bucket, Prefix: s.objectKey, MaxKeys: 100,
          KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: bound }), bound); after(signal);
        if (typeof out.IsTruncated !== 'boolean' || (out.CommonPrefixes?.length ?? 0) > 0
          || (out.Versions !== undefined && !Array.isArray(out.Versions))
          || (out.DeleteMarkers !== undefined && !Array.isArray(out.DeleteMarkers))) return incomplete();
        const count = (out.Versions?.length ?? 0) + (out.DeleteMarkers?.length ?? 0);
        observedVersions += count; if (count > 100 || observedVersions > MAX_ITEMS) return incomplete();
        for (const [items, deleteMarker] of [[out.Versions ?? [], false], [out.DeleteMarkers ?? [], true]] as const) {
          for (const v of items) {
            if (typeof v.Key !== 'string' || !v.Key.startsWith(s.objectKey)) return incomplete();
            if (v.Key !== s.objectKey) continue;
            const size = 'Size' in v ? v.Size : null;
            if (!objectVersion.safeParse(v.VersionId).success || seen.has(v.VersionId!) || seen.size >= MAX_ITEMS
              || (!deleteMarker && (!Number.isSafeInteger(size) || (size as number) < 0))) return incomplete();
            seen.add(v.VersionId!); versions.push({ objectVersion: v.VersionId!, deleteMarker, bytes: deleteMarker ? null : size as number });
          }
        }
        if (!out.IsTruncated) return { complete: true, checkedAt: new Date().toISOString(), uploads, versions };
        if (typeof out.NextKeyMarker !== 'string' || !out.NextKeyMarker.startsWith(s.objectKey)
          || (out.NextVersionIdMarker !== undefined && !objectVersion.safeParse(out.NextVersionIdMarker).success)
          || (out.NextKeyMarker === s.objectKey && !objectVersion.safeParse(out.NextVersionIdMarker).success)) return incomplete();
        const cursor = JSON.stringify([out.NextKeyMarker, out.NextVersionIdMarker]);
        if (cursors.has(cursor)) return incomplete(); cursors.add(cursor); keyMarker = out.NextKeyMarker; versionMarker = out.NextVersionIdMarker;
      }
    } catch { /* No denied, interrupted, looping or malformed inventory is absence. */ }
    return incomplete();
  }
  function validObject(out: Record<string, unknown>, s: ProgramMediaMultipartSession) {
    const observed = out.Metadata as Record<string, unknown> | undefined;
    return out.VersionId === s.objectVersion && out.ContentLength === s.totalBytes && out.ContentType === s.contentType
      && out.DeleteMarker !== true && out.ChecksumType === 'COMPOSITE' && out.ChecksumSHA256 === s.checksum
      && out.ServerSideEncryption === 'aws:kms' && out.SSEKMSKeyId === storage.kmsKeyArn
      && observed && Object.entries(metadata(s)).every(([k, v]) => observed[k] === v);
  }
  async function verifySession(s: ProgramMediaMultipartSession, signal: AbortSignal) {
    if (!objectVersion.safeParse(s.objectVersion).success || !['verifying', 'committed', 'abort_requested'].includes(s.state)) throw invalid();
    let stop: (() => void) | undefined;
    try {
      const bound = bounded(signal);
      const head = await interruptible(s3.send(new HeadObjectCommand({ ...base(s), VersionId: s.objectVersion!, ChecksumMode: 'ENABLED' }), { abortSignal: bound }), bound); after(signal);
      if (!validObject(head as unknown as Record<string, unknown>, s)) throw invalid();
      const out = await interruptible(s3.send(new GetObjectCommand({ ...base(s), VersionId: s.objectVersion!, ChecksumMode: 'ENABLED' }), { abortSignal: bound }), bound,
        discarded => discardBody(discarded.Body));
      const body = out.Body;
      if (!body) throw invalid();
      stop = () => discardBody(body);
      // SDK Node streams are async iterable. Web streams are adapted without
      // buffering the whole 256 MiB file; neither toArray nor transformToByteArray.
      const stream = body as unknown as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>; getReader?: () => ReadableStreamDefaultReader<Uint8Array>; destroy?: () => void };
      const reader = typeof stream.getReader === 'function' ? stream.getReader() : null;
      const iterator = reader ? null : stream[Symbol.asyncIterator]?.();
      stop = () => { try { stream.destroy?.(); } catch { /* cancel best effort, never proof */ }
        try {
          if (reader) void Promise.resolve(reader.cancel()).catch(() => undefined);
          else if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch { /* cancellation cannot replace the refusal with provider details */ } };
      after(signal);
      if (!validObject(out as unknown as Record<string, unknown>, s) || (!reader && !iterator)) throw invalid();
      let received = 0, partIndex = 0, partBytes = 0;
      const whole = createHash('sha256'); let partHash = createHash('sha256');
      while (true) {
        const next = await interruptible(reader ? reader.read() : iterator!.next(), bound); after(signal);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || received + next.value.byteLength > s.totalBytes) throw invalid();
        whole.update(next.value); received += next.value.byteLength;
        let offset = 0;
        while (offset < next.value.byteLength) {
          const expected = s.manifest.parts[partIndex];
          if (!expected) throw invalid();
          const count = Math.min(expected.bytes - partBytes, next.value.byteLength - offset);
          partHash.update(next.value.subarray(offset, offset + count)); offset += count; partBytes += count;
          if (partBytes === expected.bytes) {
            if (partHash.digest('hex') !== expected.sha256) throw invalid();
            partIndex++; partBytes = 0; partHash = createHash('sha256');
          }
        }
      }
      if (received !== s.totalBytes || partBytes !== 0 || partIndex !== s.manifest.parts.length || whole.digest('hex') !== s.sha256) throw invalid();
      return { objectVersion: s.objectVersion!, checksum: s.checksum, sha256: s.sha256, bytes: received };
    } catch { throw new ProgramMediaError('service_unavailable'); }
    finally { stop?.(); }
  }
  const store = {
    create(value: ProgramMediaMultipartAdmission, signal: AbortSignal) {
      return mutate(() => {
        const s = admission(value, 'creation', null);
        const command = new CreateMultipartUploadCommand({ ...base(s), ContentType: s.contentType, CacheControl: 'private, no-store',
          ServerSideEncryption: 'aws:kms', SSEKMSKeyId: storage.kmsKeyArn, ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE', Metadata: metadata(s) });
        return { session: s, send: (signal: AbortSignal) => s3.send(command, { abortSignal: signal }) };
      }, (raw, s) => {
        const out = raw as Record<string, unknown>;
        if (out.Bucket !== storage.bucket || out.Key !== s.objectKey || !providerId.safeParse(out.UploadId).success
          || out.ChecksumAlgorithm !== 'SHA256' || out.ChecksumType !== 'COMPOSITE' || out.ServerSideEncryption !== 'aws:kms' || out.SSEKMSKeyId !== storage.kmsKeyArn) throw invalid();
        return { uploadId: out.UploadId as string };
      }, signal);
    },
    part(value: ProgramMediaMultipartAdmission, partNumber: number, bytes: Uint8Array, signal: AbortSignal) {
      return mutate(() => {
        const s = admission(value, 'part', partNumber), expected = s.manifest.parts[partNumber - 1];
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected.bytes) throw invalid();
        const captured = new Uint8Array(bytes);
        if (createHash('sha256').update(captured).digest('hex') !== expected.sha256) throw invalid();
        const command = new UploadPartCommand({ ...base(s), UploadId: s.uploadId!, PartNumber: partNumber, Body: captured,
          ContentLength: expected.bytes, ChecksumAlgorithm: 'SHA256', ChecksumSHA256: Buffer.from(expected.sha256, 'hex').toString('base64') });
        return { session: s, send: (signal: AbortSignal) => s3.send(command, { abortSignal: signal }) };
      }, (raw, s) => {
        const out = raw as Record<string, unknown>, expected = s.manifest.parts[partNumber - 1], checksum = Buffer.from(expected.sha256, 'hex').toString('base64');
        if (!providerId.safeParse(out.ETag).success || out.ChecksumSHA256 !== checksum || out.ServerSideEncryption !== 'aws:kms' || out.SSEKMSKeyId !== storage.kmsKeyArn) throw invalid();
        return { partNumber, bytes: expected.bytes, checksum, etag: out.ETag as string };
      }, signal);
    },
    complete(value: ProgramMediaMultipartAdmission, signal: AbortSignal) {
      return mutate(() => {
        const s = admission(value, 'completion', null);
        const command = new CompleteMultipartUploadCommand({ ...base(s), UploadId: s.uploadId!, IfNoneMatch: '*',
          ChecksumType: 'COMPOSITE', ChecksumSHA256: s.checksum, MpuObjectSize: s.totalBytes,
          MultipartUpload: { Parts: [...s.parts].sort((a, b) => a.partNumber - b.partNumber).map(p => ({ PartNumber: p.partNumber, ETag: p.etag, ChecksumSHA256: p.checksum })) } });
        return { session: s, send: (signal: AbortSignal) => s3.send(command, { abortSignal: signal }) };
      }, (raw, s) => {
        const out = raw as Record<string, unknown>;
        if (out.Bucket !== storage.bucket || out.Key !== s.objectKey || !objectVersion.safeParse(out.VersionId).success
          || out.ChecksumType !== 'COMPOSITE' || out.ChecksumSHA256 !== s.checksum || out.ServerSideEncryption !== 'aws:kms' || out.SSEKMSKeyId !== storage.kmsKeyArn) throw invalid();
        return { objectVersion: out.VersionId as string, checksum: s.checksum };
      }, signal);
    },
    parts, inventory,
    verify: (value: ProgramMediaMultipartSession, signal: AbortSignal) => verifySession(checked(value), signal),
    /** A trusted SQL reader must independently authorize the CURRENT original
     * author and return the exact committed artifact/session. This preserves
     * the ledger's writer restriction; team/learner reads need a distinct role.
     * Stream-verify the whole file AND each part before signing its version. */
    async preview(value: ProgramMediaMultipartSession, rawArtifact: ProgramMediaArtifact, signal: AbortSignal) {
      const s = checked(value), artifact = programMediaArtifact.parse(rawArtifact);
      if (s.state !== 'committed' || s.pending.length !== 0 || s.parts.length !== s.manifest.parts.length
        || !['ready', 'retired'].includes(artifact.state) || artifact.objectVersion !== s.objectVersion
        || artifact.artifactId !== s.artifactId || artifact.clinic !== s.clinic || artifact.programId !== s.programId
        || artifact.kind !== s.kind || artifact.contentType !== s.contentType || artifact.objectKey !== s.objectKey
        || artifact.bytes !== s.totalBytes || artifact.sha256 !== s.sha256) throw invalid();
      await verifySession(s, signal); after(signal);
      return issueAwsProgramMediaVersionPreview({ s3, bucket: storage.bucket, objectKey: s.objectKey,
        objectVersion: s.objectVersion!, contentType: s.contentType, signal: bounded(signal), assertLive: () => after(signal) });
    },
    async abort(value: ProgramMediaMultipartSession, uploadId: string, signal: AbortSignal) {
      const s = checked(value);
      if (s.state !== 'abort_requested' || !providerId.safeParse(uploadId).success) throw invalid();
      try {
        const bound = bounded(signal);
        await interruptible(s3.send(new AbortMultipartUploadCommand({ ...base(s), UploadId: uploadId }), { abortSignal: bound }), bound); after(signal);
      } catch (error) { after(signal); if (!missingUpload(error)) throw new ProgramMediaError('service_unavailable'); }
      // A 204/NoSuchUpload is not absence proof and settles no admitted writer.
    },
    async removeVersion(value: ProgramMediaMultipartSession, version: string, signal: AbortSignal) {
      const s = checked(value);
      if (s.state !== 'abort_requested' || !objectVersion.safeParse(version).success) throw invalid();
      try {
        const bound = bounded(signal);
        await interruptible(s3.send(new DeleteObjectCommand({ ...base(s), VersionId: version }), { abortSignal: bound }), bound); after(signal);
      } catch { throw new ProgramMediaError('service_unavailable'); }
      // Only a subsequent complete inventory after ledger settlement can prove absence.
    },
  };
  return Object.freeze({ store: Object.freeze(store), close });
}
export type AwsProgramMediaMultipartStore = Awaited<ReturnType<typeof createAwsProgramMediaMultipartStoreSource>>['store'];
