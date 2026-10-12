if (typeof window !== 'undefined') throw new Error('aws-program-media-store is server-only');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { S3Client, S3ServiceException, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand,
  GetObjectCommand, GetBucketVersioningCommand, GetBucketEncryptionCommand, GetBucketOwnershipControlsCommand,
  GetPublicAccessBlockCommand, GetBucketTaggingCommand, GetBucketPolicyCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { programMediaArtifact, programMediaExtension, programMediaReservation, programMediaStorageSchema,
  type ProgramMediaReservation, type ProgramMediaArtifact } from '@/contracts/programMedia';
import { ProgramMediaError, ProgramMediaWriteError, type ProgramMediaObjectStore, type ProgramMediaStoredObject } from './program-media-authoring';

/** Real SDK source, not an installed runtime, activation receipt or complete
 * authoring factory. The caller must still independently admit current workforce
 * rights and the reviewed release, ledger and prefix-restricted IAM role. The
 * resource readbacks here do not prove those approvals or the role's policy.
 * No ambient credential chain, caller endpoint, shared recording bucket, retry,
 * unversioned delete or multipart fallback. All runtime activation remains off. */
const configurationSchema = z.object({
  storage: programMediaStorageSchema,
  scope: z.object({ clinic: z.uuid(), programId: z.uuid() }).strict(),
  expectedRoleArn: z.string().regex(/^arn:aws:iam::588966314750:role\/[A-Za-z0-9_+=,.@\/-]{1,200}$/),
  credentials: z.object({ accessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/), secretAccessKey: z.string().min(40).max(128),
    sessionToken: z.string().min(10).max(3000), expiration: z.date() }).strict(),
  forbiddenBuckets: z.array(z.string().min(3)).min(1).max(100),
  forbiddenKmsKeyArns: z.array(z.string().min(20)).min(1).max(100),
}).strict();
export type AwsProgramMediaStoreConfiguration = z.infer<typeof configurationSchema>;
const REQUEST_LIFETIME_MS = 30_000, MAX_PAGES = 20, MAX_VERSIONS = 1000;
const version = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== 'null';
const invalid = () => new ProgramMediaError('storage_unverified');

/** Resource reads must finish at withdrawal/deadline even if a transport ignores
 * its abort signal. Promise.race retains the late rejection observer. */
async function resourceRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); throw invalid(); }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(invalid()); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function validDenialPolicy(raw: string | undefined, bucket: string, kms: string): boolean {
  try {
    const doc: unknown = JSON.parse(raw ?? '');
    const schema = z.object({ Statement: z.array(z.record(z.string(), z.unknown())).min(1) }).passthrough();
    const statements = schema.parse(doc).Statement;
    const list = (value: unknown) => typeof value === 'string' ? [value] : z.array(z.string()).parse(value);
    const deny = (row: Record<string, unknown>, action: string, resources: string[], condition: unknown) => {
      const principal = row.Principal === '*' || JSON.stringify(row.Principal) === JSON.stringify({ AWS: '*' });
      const actions = list(row.Action), named = list(row.Resource);
      return row.Effect === 'Deny' && principal && (actions.includes('s3:*') || actions.includes(action))
        && resources.every(r => named.includes(r)) && JSON.stringify(row.Condition) === JSON.stringify(condition)
        && !('NotAction' in row) && !('NotResource' in row) && !('NotPrincipal' in row);
    };
    const arn = `arn:aws:s3:::${bucket}`, objects = `${arn}/*`;
    return statements.some(r => deny(r, 's3:*', [arn, objects], { Bool: { 'aws:SecureTransport': 'false' } }))
      && statements.some(r => deny(r, 's3:PutObject', [objects], { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } }))
      && statements.some(r => deny(r, 's3:PutObject', [objects], { StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': kms } }));
  } catch { return false; }
}

/** Multipart review is distinct from the single-PUT encryption-header policy.
 * The exact observed policy bytes must match the separately reviewed hash.
 * Missing encryption headers on parts inherit the independently checked bucket
 * default; an explicit override is denied. Completed objects must be create-only.
 * This minimum policy check is NOT verification of the role's effective IAM. */
export type ProgramMediaMultipartPolicyReview = { contract: 'program-media-multipart-resource-review/1'; policySha256: string; evidenceSha256: string };
function validMultipartPolicy(raw: string | undefined, bucket: string, kms: string, review: ProgramMediaMultipartPolicyReview): boolean {
  try {
    if (!z.object({ contract: z.literal('program-media-multipart-resource-review/1'), policySha256: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(review).success
      || !raw || Buffer.byteLength(raw) > 262144 || createHash('sha256').update(raw, 'utf8').digest('hex') !== review.policySha256) return false;
    const statements = z.object({ Statement: z.array(z.record(z.string(), z.unknown())).min(1) }).passthrough().parse(JSON.parse(raw)).Statement;
    const arn = `arn:aws:s3:::${bucket}`, objects = `${arn}/*`;
    const list = (v: unknown) => typeof v === 'string' ? [v] : z.array(z.string()).parse(v);
    const deny = (r: Record<string, unknown>, action: string, resources: string[], condition: unknown) => r.Effect === 'Deny'
      && (r.Principal === '*' || JSON.stringify(r.Principal) === JSON.stringify({ AWS: '*' }))
      && (list(r.Action).includes(action) || list(r.Action).includes('s3:*')) && resources.every(v => list(r.Resource).includes(v))
      && JSON.stringify(r.Condition) === JSON.stringify(condition) && !['NotAction', 'NotResource', 'NotPrincipal'].some(k => k in r);
    return statements.some(r => deny(r, 's3:*', [arn, objects], { Bool: { 'aws:SecureTransport': 'false' } }))
      && [['s3:x-amz-server-side-encryption', 'aws:kms'], ['s3:x-amz-server-side-encryption-aws-kms-key-id', kms]].every(([key, value]) =>
        statements.some(r => deny(r, 's3:PutObject', [objects], { StringNotEquals: { [key]: value }, Null: { [key]: 'false' } })))
      && statements.some(r => deny(r, 's3:PutObject', [objects], { StringNotEquals: { 's3:if-none-match': '*' }, Bool: { 's3:ObjectCreationOperation': 'true' } }))
      // Blanket missing-header denial would make UploadPart/Complete unusable.
      && !statements.some(r => ['s3:x-amz-server-side-encryption', 's3:x-amz-server-side-encryption-aws-kms-key-id'].some(key =>
        deny(r, 's3:PutObject', [objects], { StringNotEquals: { [key]: key.endsWith('key-id') ? kms : 'aws:kms' } })));
  } catch { return false; }
}

/** Shared server-only resource opener. No ambient credentials, installed host,
 * activation or patient authority is supplied by this helper. New multipart
 * callers must provide their separately reviewed policy identity. */
export async function openAwsProgramMediaResourceSource(input: AwsProgramMediaStoreConfiguration, requestSignal: AbortSignal,
  multipartReview?: ProgramMediaMultipartPolicyReview) {
  let config: AwsProgramMediaStoreConfiguration;
  let reviewedPolicy: ProgramMediaMultipartPolicyReview | undefined;
  try {
    config = configurationSchema.parse(input);
    reviewedPolicy = multipartReview === undefined ? undefined : Object.freeze(z.object({
      contract: z.literal('program-media-multipart-resource-review/1'), policySha256: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(multipartReview));
    if (!(requestSignal instanceof AbortSignal) || requestSignal.aborted
      || config.storage.expectedBucketOwner !== '588966314750' || config.storage.region !== 'us-east-2'
      || config.forbiddenBuckets.includes(config.storage.bucket) || config.forbiddenKmsKeyArns.includes(config.storage.kmsKeyArn)
      || /admin|root|recording|clinical|patient|voice/i.test(config.expectedRoleArn)
      || !Number.isFinite(config.credentials.expiration.getTime())
      || config.credentials.expiration.getTime() <= Date.now() + 10 * 60_000
      || config.credentials.expiration.getTime() > Date.now() + 12 * 60 * 60_000) throw invalid();
  } catch { throw invalid(); }
  const storage = Object.freeze({ ...config.storage }), scope = Object.freeze({ ...config.scope });
  const credentials = Object.freeze({ ...config.credentials, expiration: new Date(config.credentials.expiration.getTime()) });
  const expectedRole = config.expectedRoleArn.split('/').at(-1)!;
  const callerPattern = new RegExp(`^arn:aws:sts::588966314750:assumed-role/${expectedRole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9_+=,.@-]{2,64}$`);
  const deadline = Date.now() + REQUEST_LIFETIME_MS, closed = new AbortController();
  // Explicit temporary credentials only. Endpoints are code constants, never
  // environment URLs or fields from the configuration/body.
  // SDK middleware annotates its returned identity. Keep the authoritative
  // captured values frozen, but give it a fresh private copy rather than the
  // input object (or an immutable object the SDK cannot annotate).
  const common = { region: storage.region, credentials: async () => ({ ...credentials,
    expiration: new Date(credentials.expiration.getTime()) }), maxAttempts: 1 };
  const s3 = new S3Client({ ...common, endpoint: 'https://s3.us-east-2.amazonaws.com', followRegionRedirects: false,
    forcePathStyle: false, useAccelerateEndpoint: false, useDualstackEndpoint: false });
  const sts = new STSClient({ ...common, endpoint: 'https://sts.us-east-2.amazonaws.com' });
  const close = () => { closed.abort(); s3.destroy(); sts.destroy(); };
  const live = () => {
    if (requestSignal.aborted || closed.signal.aborted || Date.now() >= deadline || Date.now() >= credentials.expiration.getTime())
      throw new ProgramMediaError('access_refused');
  };
  const after = (signal: AbortSignal) => { live(); if (signal.aborted) throw new ProgramMediaError('access_refused'); };
  const bounded = (signal: AbortSignal) => {
    live(); if (!(signal instanceof AbortSignal) || signal.aborted) throw new ProgramMediaError('access_refused');
    return AbortSignal.any([signal, requestSignal, closed.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
  };
  const bucket = { Bucket: storage.bucket, ExpectedBucketOwner: storage.expectedBucketOwner };
  try {
    const initial = bounded(requestSignal);
    const caller = await resourceRead(sts.send(new GetCallerIdentityCommand({}), { abortSignal: initial }), initial); live();
    if (caller.Account !== storage.expectedBucketOwner
      || typeof caller.Arn !== 'string' || !callerPattern.test(caller.Arn)) throw invalid();
    const versioning = await resourceRead(s3.send(new GetBucketVersioningCommand(bucket), { abortSignal: initial }), initial); live();
    const encryption = await resourceRead(s3.send(new GetBucketEncryptionCommand(bucket), { abortSignal: initial }), initial); live();
    const access = await resourceRead(s3.send(new GetPublicAccessBlockCommand(bucket), { abortSignal: initial }), initial); live();
    const ownership = await resourceRead(s3.send(new GetBucketOwnershipControlsCommand(bucket), { abortSignal: initial }), initial); live();
    const tags = await resourceRead(s3.send(new GetBucketTaggingCommand(bucket), { abortSignal: initial }), initial); live();
    const policy = await resourceRead(s3.send(new GetBucketPolicyCommand(bucket), { abortSignal: initial }), initial); live();
    const rule = encryption.ServerSideEncryptionConfiguration?.Rules;
    const block = access.PublicAccessBlockConfiguration;
    const tag = (key: string, value: string) => tags.TagSet?.filter(t => t.Key === key).length === 1 && tags.TagSet?.some(t => t.Key === key && t.Value === value);
    if (versioning.Status !== 'Enabled' || rule?.length !== 1 || rule[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'aws:kms'
      || rule[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID !== storage.kmsKeyArn
      || !block || [block.BlockPublicAcls, block.IgnorePublicAcls, block.BlockPublicPolicy, block.RestrictPublicBuckets].some(v => v !== true)
      || ownership.OwnershipControls?.Rules?.length !== 1 || ownership.OwnershipControls.Rules[0].ObjectOwnership !== 'BucketOwnerEnforced'
      || !tag('alp:purpose', 'educational_media') || !tag('alp:classification', 'synthetic_only') || !tag('alp:phi-allowed', 'false') || !tag('alp:dedicated', 'true')
      || !(reviewedPolicy ? validMultipartPolicy(policy.Policy, storage.bucket, storage.kmsKeyArn, reviewedPolicy)
        : validDenialPolicy(policy.Policy, storage.bucket, storage.kmsKeyArn))) throw invalid();
  } catch { close(); throw invalid(); }

  return Object.freeze({ storage, scope, s3, bucket: Object.freeze(bucket), live, after, bounded, close });
}

export async function createAwsProgramMediaStoreSource(input: AwsProgramMediaStoreConfiguration, requestSignal: AbortSignal):
Promise<{ store: ProgramMediaObjectStore; close(): void }> {
  const { storage, scope, s3, bucket, live, after, bounded, close } = await openAwsProgramMediaResourceSource(input, requestSignal);

  function checked(value: ProgramMediaReservation | ProgramMediaArtifact) {
    live();
    let r: ProgramMediaReservation | ProgramMediaArtifact;
    try { r = 'objectVersion' in value ? programMediaArtifact.parse(value) : programMediaReservation.parse(value); }
    catch { throw invalid(); }
    const expected = `program-media/${r.clinic}/${r.programId}/${r.artifactId}/${r.sha256}.${programMediaExtension(r.kind, r.contentType)}`;
    if (r.clinic !== scope.clinic || r.programId !== scope.programId || r.objectKey !== expected
      || r.bytes > (r.kind === 'image' ? storage.maxImageBytes : storage.maxVideoBytes)
      || programMediaExtension(r.kind, r.contentType) === null) throw invalid();
    return r;
  }
  const base = (r: ProgramMediaReservation | ProgramMediaArtifact) => ({ ...bucket, Key: r.objectKey });
  const readHead = async (r: ProgramMediaReservation | ProgramMediaArtifact, objectVersion: string | undefined, signal: AbortSignal): Promise<ProgramMediaStoredObject | null> => {
    if (objectVersion !== undefined && !version(objectVersion)) throw invalid();
    try {
      const out = await s3.send(new HeadObjectCommand({ ...base(r), VersionId: objectVersion, ChecksumMode: 'ENABLED' }), { abortSignal: bounded(signal) }); after(signal);
      if (!version(out.VersionId) || (objectVersion !== undefined && out.VersionId !== objectVersion)) throw invalid();
      return { version: out.VersionId, bytes: out.ContentLength, contentType: out.ContentType, checksum: out.ChecksumSHA256,
        checksumType: out.ChecksumType, encryption: out.ServerSideEncryption, kmsKeyArn: out.SSEKMSKeyId,
        metadata: out.Metadata ? { ...out.Metadata } : undefined, deleteMarker: out.DeleteMarker, listedKey: r.objectKey };
    } catch (error) {
      after(signal);
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404
        && ['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(error.name)) return null;
      throw new ProgramMediaError('service_unavailable');
    }
  };
  const store: ProgramMediaObjectStore = {
    async put(value, bytes, signal) {
      let r: ProgramMediaReservation | ProgramMediaArtifact, accepted: Uint8Array;
      try {
        r = checked(value); bounded(signal);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== r.bytes) throw invalid();
        accepted = new Uint8Array(bytes);
        if (createHash('sha256').update(accepted).digest('hex') !== r.sha256) throw invalid();
      } catch { throw new ProgramMediaWriteError(true); }
      try {
        const out = await s3.send(new PutObjectCommand({ ...base(r), Body: accepted, ContentLength: r.bytes, ContentType: r.contentType,
          IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ChecksumSHA256: Buffer.from(r.sha256, 'hex').toString('base64'),
          ServerSideEncryption: 'aws:kms', SSEKMSKeyId: storage.kmsKeyArn, CacheControl: 'private, no-store',
          Metadata: { 'artifact-id': r.artifactId, 'program-id': r.programId, clinic: r.clinic, purpose: 'educational_media' },
        }), { abortSignal: bounded(signal) }); after(signal);
        if (!version(out.VersionId)) throw new ProgramMediaWriteError(false);
        return { version: out.VersionId };
      } catch (error) {
        // No retry. Only an authenticated, explicit precondition rejection is
        // definite. All lost replies, aborts, 5xx and malformed success are uncertain.
        const rejected = error instanceof S3ServiceException && error.name === 'PreconditionFailed' && error.$metadata.httpStatusCode === 412;
        throw new ProgramMediaWriteError(rejected);
      }
    },
    head: async (value, v, signal) => readHead(checked(value), v, signal),
    async remove(value, v, signal) {
      const r = checked(value); if (!version(v)) throw invalid();
      try { await s3.send(new DeleteObjectCommand({ ...base(r), VersionId: v }), { abortSignal: bounded(signal) }); after(signal); }
      catch { throw new ProgramMediaError('service_unavailable'); }
      // Deliberately returns no absence claim; caller must inventory afterwards.
    },
    async inventory(value, signal) {
      const r = checked(value), versions: ProgramMediaStoredObject[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let keyMarker: string | undefined, versionMarker: string | undefined;
      const incomplete = () => ({ complete: false, versions });
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const out = await s3.send(new ListObjectVersionsCommand({ ...bucket, Prefix: r.objectKey, MaxKeys: 100,
            KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: bounded(signal) }); after(signal);
          if (typeof out.IsTruncated !== 'boolean' || (out.CommonPrefixes?.length ?? 0) !== 0) return incomplete();
          for (const item of [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])]) {
            if (typeof item.Key !== 'string' || !item.Key.startsWith(r.objectKey)) return incomplete();
            if (item.Key !== r.objectKey) continue; // Prefix is not exact-key equality.
            if (!version(item.VersionId) || seen.has(item.VersionId) || seen.size >= MAX_VERSIONS) return incomplete();
            seen.add(item.VersionId);
          }
          for (const item of out.Versions ?? []) {
            if (item.Key !== r.objectKey) continue;
            const head = await readHead(r, item.VersionId!, signal);
            if (!head || head.deleteMarker === true || (item.Size !== undefined && head.bytes !== item.Size)) return incomplete();
            versions.push(head);
          }
          for (const item of out.DeleteMarkers ?? []) {
            if (item.Key === r.objectKey) versions.push({ version: item.VersionId, deleteMarker: true, listedKey: r.objectKey });
          }
          if (!out.IsTruncated) return { complete: true, versions };
          if (typeof out.NextKeyMarker !== 'string' || !out.NextKeyMarker.startsWith(r.objectKey)
            || (out.NextVersionIdMarker !== undefined && (typeof out.NextVersionIdMarker !== 'string' || !out.NextVersionIdMarker || out.NextVersionIdMarker.length > 1024))
            || (out.NextKeyMarker === r.objectKey && !version(out.NextVersionIdMarker))) return incomplete();
          const cursor = JSON.stringify([out.NextKeyMarker, out.NextVersionIdMarker]);
          if (cursors.has(cursor)) return incomplete();
          cursors.add(cursor); keyMarker = out.NextKeyMarker; versionMarker = out.NextVersionIdMarker;
        }
        return incomplete();
      } catch { return incomplete(); } // Never turn failed/aborted listing into absence.
    },
    async preview(value, signal) {
      const artifact = checked(value);
      if (!('objectVersion' in artifact) || !version(artifact.objectVersion) || !['ready', 'retired'].includes(artifact.state)) throw invalid();
      bounded(signal);
      const observed = await readHead(artifact, artifact.objectVersion, signal);
      if (!observed || observed.deleteMarker === true || observed.checksum !== Buffer.from(artifact.sha256, 'hex').toString('base64')
        || observed.checksumType !== 'FULL_OBJECT' || observed.bytes !== artifact.bytes || observed.contentType !== artifact.contentType
        || observed.encryption !== 'aws:kms' || observed.kmsKeyArn !== storage.kmsKeyArn
        || observed.metadata?.['artifact-id'] !== artifact.artifactId || observed.metadata?.['program-id'] !== artifact.programId
        || observed.metadata?.clinic !== artifact.clinic || observed.metadata?.purpose !== 'educational_media') throw invalid();
      const issued = new Date();
      try {
        const token = await getSignedUrl(s3, new GetObjectCommand({ ...base(artifact), VersionId: artifact.objectVersion,
          ResponseCacheControl: 'private, no-store', ResponseContentType: artifact.contentType }), { expiresIn: 300, signingDate: issued });
        after(signal);
        const url = new URL(token);
        if (url.protocol !== 'https:' || url.hostname !== `${storage.bucket}.s3.us-east-2.amazonaws.com` || url.username || url.password || url.hash
          || decodeURIComponent(url.pathname.slice(1)) !== artifact.objectKey || url.searchParams.get('versionId') !== artifact.objectVersion
          || url.searchParams.get('X-Amz-Expires') !== '300' || url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') throw invalid();
        return { token, until: new Date(issued.getTime() + 300_000).toISOString() };
      } catch { throw new ProgramMediaError('service_unavailable'); }
    },
  };
  return Object.freeze({ store: Object.freeze(store), close });
}
