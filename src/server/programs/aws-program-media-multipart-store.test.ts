import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { Readable } from 'node:stream';
import { createAwsProgramMediaMultipartStoreSource, type ProgramMediaMultipartAdmission } from './aws-program-media-multipart-store';
import { type AwsProgramMediaStoreConfiguration, type ProgramMediaMultipartPolicyReview } from './aws-program-media-store';
import { type ProgramMediaMultipartSession } from './program-media-multipart-ledger';
import { programMediaCompositeChecksum, PROGRAM_MEDIA_PART_BYTES } from './program-media-parts';
import { programMediaPreview, type ProgramMediaArtifact } from '@/contracts/programMedia';

// Actual SDK clients and command types; every network send is intercepted.
// These are source/failure tests, not real S3/KMS/IAM qualification.
const id = (n: number) => '76000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ACCOUNT = '588966314750', BUCKET = 'alp-fictional-education-multipart', KMS = `arn:aws:kms:us-east-2:${ACCOUNT}:key/${id(99)}`;
const NOW = new Date('2026-10-11T22:00:00Z'), bytes = Buffer.from('ALP!');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const manifest = { totalBytes: bytes.length, parts: [{ partNumber: 1, bytes: bytes.length, sha256: sha(bytes) }] };
const config = (): AwsProgramMediaStoreConfiguration => ({
  storage: { purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: BUCKET, expectedBucketOwner: ACCOUNT,
    region: 'us-east-2', kmsKeyArn: KMS, maxImageBytes: 16_777_216, maxVideoBytes: 268_435_456, publicOrigin: 'https://lessons.fictional.example/' },
  scope: { clinic: id(1), programId: id(2) }, expectedRoleArn: `arn:aws:iam::${ACCOUNT}:role/ALPProgramMediaQualification`,
  credentials: { accessKeyId: 'ASIA' + 'F'.repeat(16), secretAccessKey: 'F'.repeat(40), sessionToken: 'fictional-session', expiration: new Date('2026-10-11T23:00:00Z') },
  forbiddenBuckets: ['alp-fictional-recording'], forbiddenKmsKeyArns: [`arn:aws:kms:us-east-2:${ACCOUNT}:key/${id(98)}`],
});
const session = (): ProgramMediaMultipartSession => ({ artifactId: id(3), clinic: id(1), programId: id(2), actorId: id(4), writerClaimId: id(5),
  kind: 'video', contentType: 'video/mp4', sha256: sha(bytes), totalBytes: bytes.length,
  objectKey: `program-media/${id(1)}/${id(2)}/${id(3)}/${sha(bytes)}.mp4`, acceptBefore: '2026-10-11T22:15:00Z',
  manifest: structuredClone(manifest), checksum: programMediaCompositeChecksum(manifest), uploadId: 'fictional-upload', objectVersion: null,
  state: 'uploading', parts: [], pending: [] });
const metadata = (s = session()) => ({ 'artifact-id': s.artifactId, 'program-id': s.programId, clinic: s.clinic, purpose: 'educational_media',
  'writer-claim-id': s.writerClaimId, 'whole-sha256': s.sha256 });
const encryption = { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS };
const part = () => ({ partNumber: 1, bytes: bytes.length, sha256: sha(bytes), checksum: Buffer.from(sha(bytes), 'hex').toString('base64'), etag: '"fictional-etag"' });
function admitted(kind: 'creation' | 'part' | 'completion', claimId = id(6)): ProgramMediaMultipartAdmission {
  const s = session();
  s.state = kind === 'creation' ? 'creation_admitted' : kind === 'part' ? 'uploading' : 'completion_admitted';
  if (kind === 'creation') s.uploadId = null;
  if (kind === 'completion') s.parts = [part()];
  s.pending = [{ claimId, kind, partNumber: kind === 'part' ? 1 : null, state: 'open' }];
  return { admitted: true, claimId, session: s };
}
const policy = (): { Statement: Record<string, unknown>[] } => ({ Statement: [
  { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
  ...[['s3:x-amz-server-side-encryption', 'aws:kms'], ['s3:x-amz-server-side-encryption-aws-kms-key-id', KMS]].map(([key, value]) => ({
    Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: `arn:aws:s3:::${BUCKET}/*`, Condition: { StringNotEquals: { [key]: value }, Null: { [key]: 'false' } },
  })),
  { Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: `arn:aws:s3:::${BUCKET}/*`, Condition: { StringNotEquals: { 's3:if-none-match': '*' }, Bool: { 's3:ObjectCreationOperation': 'true' } } },
] });
const review = (): ProgramMediaMultipartPolicyReview => ({ contract: 'program-media-multipart-resource-review/1', policySha256: sha(JSON.stringify(policy())), evidenceSha256: 'a'.repeat(64) });
type Sent = { name: string; input: Record<string, unknown>; signal?: AbortSignal };
let sent: Sent[], respond: (command: Sent) => unknown | Promise<unknown>, close: (() => void) | undefined;
const signal = () => new AbortController().signal;
const stored = (s = session()) => ({ VersionId: s.objectVersion ?? 'fictional-version', ContentLength: s.totalBytes, ContentType: s.contentType,
  ChecksumSHA256: s.checksum, ChecksumType: 'COMPOSITE', ...encryption, Metadata: metadata(s) });
function ordinary(c: Sent): unknown {
  switch (c.name) {
    case 'GetCallerIdentityCommand': return { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ALPProgramMediaQualification/fictional-session` };
    case 'GetBucketVersioningCommand': return { Status: 'Enabled' };
    case 'GetBucketEncryptionCommand': return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KMS } }] } };
    case 'GetPublicAccessBlockCommand': return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
    case 'GetBucketOwnershipControlsCommand': return { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } };
    case 'GetBucketTaggingCommand': return { TagSet: [{ Key: 'alp:purpose', Value: 'educational_media' }, { Key: 'alp:classification', Value: 'synthetic_only' }, { Key: 'alp:phi-allowed', Value: 'false' }, { Key: 'alp:dedicated', Value: 'true' }] };
    case 'GetBucketPolicyCommand': return { Policy: JSON.stringify(policy()) };
    case 'CreateMultipartUploadCommand': return { Bucket: BUCKET, Key: session().objectKey, UploadId: 'fictional-upload', ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE', ...encryption };
    case 'UploadPartCommand': return { ETag: part().etag, ChecksumSHA256: part().checksum, ...encryption };
    case 'CompleteMultipartUploadCommand': return { Bucket: BUCKET, Key: session().objectKey, VersionId: 'fictional-version', ChecksumSHA256: session().checksum, ChecksumType: 'COMPOSITE', ...encryption };
    case 'ListPartsCommand': return { Bucket: BUCKET, Key: session().objectKey, UploadId: 'fictional-upload', ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE', IsTruncated: false,
      Parts: [{ PartNumber: 1, Size: bytes.length, ChecksumSHA256: part().checksum, ETag: part().etag }] };
    case 'ListMultipartUploadsCommand': return { Bucket: BUCKET, IsTruncated: false, Uploads: [] };
    case 'ListObjectVersionsCommand': return { IsTruncated: false, Versions: [], DeleteMarkers: [] };
    case 'HeadObjectCommand': return stored();
    case 'GetObjectCommand': return { ...stored(), Body: Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]) };
    case 'AbortMultipartUploadCommand': case 'DeleteObjectCommand': return {};
    default: throw new Error('unexpected fictional command');
  }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); sent = []; respond = ordinary;
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => {
    const c = { name: command.constructor.name, input: command.input, signal: options?.abortSignal }; sent.push(c); return respond(c);
  };
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(send as never);
  vi.spyOn(STSClient.prototype, 'send').mockImplementation(send as never);
});
afterEach(() => { close?.(); close = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
async function open(c = config(), r = review(), requestSignal = signal()) {
  const result = await createAwsProgramMediaMultipartStoreSource(c, requestSignal, r, id(4)); close = result.close; sent = []; return result.store;
}
const failure = (name: string, status: number) => new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status }, message: 'fictional detail must not escape' });

describe('qualified multipart SDK source with fictional network', () => {
  it('refuses bucket-wide KMS context instead of broadening a program-scoped key grant', async () => {
    respond = c => c.name === 'GetBucketEncryptionCommand' ? { ServerSideEncryptionConfiguration: { Rules: [{ BucketKeyEnabled: true,
      ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KMS } }] } } : ordinary(c);
    await expect(open()).rejects.toThrow('storage_unverified'); expect(sent.some(c => /CreateMultipart|UploadPart|CompleteMultipart/.test(c.name))).toBe(false);
  });
  it.each(['missing', 'wrong', 'drift', 'old policy', 'conditional denial missing'])('refuses %s multipart review or policy before mutation', async what => {
    let r = review();
    if (what === 'missing') r = undefined as never;
    if (what === 'wrong') r = { ...r, evidenceSha256: '' };
    if (what === 'drift') r.policySha256 = 'f'.repeat(64);
    if (what === 'old policy') {
      const p = policy(); p.Statement[1].Condition = { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } };
      const raw = JSON.stringify(p); r.policySha256 = sha(raw); respond = c => c.name === 'GetBucketPolicyCommand' ? { Policy: raw } : ordinary(c);
    }
    if (what === 'conditional denial missing') {
      const p = policy(); p.Statement.pop(); const raw = JSON.stringify(p); r.policySha256 = sha(raw); respond = c => c.name === 'GetBucketPolicyCommand' ? { Policy: raw } : ordinary(c);
    }
    await expect(createAwsProgramMediaMultipartStoreSource(config(), signal(), r, id(4))).rejects.toThrow('storage_unverified');
    expect(sent.some(c => /CreateMultipart|UploadPart|CompleteMultipart/.test(c.name))).toBe(false);
  });
  it('opens only with explicit temporary credentials, the exact actor and the pinned synthetic resource', async () => {
    const c = config(); c.credentials.accessKeyId = 'AKIA' + 'F'.repeat(16);
    await expect(open(c)).rejects.toThrow('storage_unverified'); expect(sent).toHaveLength(0);
    await expect(createAwsProgramMediaMultipartStoreSource(config(), signal(), review(), 'browser-name')).rejects.toThrow('storage_unverified');
    respond = c => c.name === 'GetCallerIdentityCommand' ? { Account: '173535830222', Arn: 'untrusted' } : ordinary(c);
    await expect(open()).rejects.toThrow('storage_unverified');
  });
  it.each(['GetCallerIdentityCommand', 'GetBucketPolicyCommand'])('refuses a %s resource read that ignores request withdrawal', async name => {
    const request = new AbortController();
    respond = c => {
      if (c.name === name) { request.abort(); return new Promise(() => undefined); }
      return ordinary(c);
    };
    await expect(createAwsProgramMediaMultipartStoreSource(config(), request.signal, review(), id(4))).rejects.toThrow('storage_unverified');
    expect(sent.some(c => /CreateMultipart|UploadPart|CompleteMultipart/.test(c.name))).toBe(false);
  });
  it('requires the first exact durable admission and consumes it once locally', async () => {
    const store = await open(), a = admitted('creation');
    await expect(store.create({ ...a, admitted: false }, signal())).rejects.toMatchObject({ settled: true }); expect(sent).toHaveLength(0);
    await expect(store.create({ ...a, session: { ...a.session, actorId: id(88) } }, signal())).rejects.toMatchObject({ settled: true }); expect(sent).toHaveLength(0);
    expect(await store.create(a, signal())).toEqual({ uploadId: 'fictional-upload' });
    await expect(store.create(a, signal())).rejects.toMatchObject({ settled: true }); expect(sent).toHaveLength(1);
  });
  it('creates with exact encryption, educational metadata and composite checksum semantics', async () => {
    const store = await open(); await store.create(admitted('creation'), signal());
    expect(sent[0]).toMatchObject({ name: 'CreateMultipartUploadCommand', input: { Bucket: BUCKET, Key: session().objectKey, ExpectedBucketOwner: ACCOUNT,
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS, ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE', Metadata: metadata() } });
  });
  it('copies Buffer parts, refuses measured-byte disagreement and binds the receipt', async () => {
    const store = await open(), mutable = Buffer.from(bytes), a = admitted('part');
    const work = store.part(a, 1, mutable, signal()); mutable.fill(0);
    expect(await work).toEqual({ partNumber: 1, bytes: bytes.length, checksum: part().checksum, etag: part().etag });
    expect(sent[0].input).toMatchObject({ UploadId: 'fictional-upload', PartNumber: 1, ContentLength: bytes.length, ChecksumSHA256: part().checksum });
    expect(Buffer.from(sent[0].input.Body as Uint8Array)).toEqual(bytes);
    expect(sent[0].input).not.toHaveProperty('ServerSideEncryption');
    await expect(store.part(admitted('part', id(7)), 1, Buffer.from('bad!'), signal())).rejects.toMatchObject({ settled: true }); expect(sent).toHaveLength(1);
  });
  it.each([{ ChecksumSHA256: 'substitution' }, { ETag: '' }, { SSEKMSKeyId: 'other-key' }])('keeps a malformed part success uncertain: %j', async change => {
    const store = await open(); respond = c => c.name === 'UploadPartCommand' ? { ...ordinary(c) as object, ...change } : ordinary(c);
    await expect(store.part(admitted('part'), 1, bytes, signal())).rejects.toMatchObject({ settled: false });
  });
  it('completes create-only from the exact ordered receipts and never equates composite with whole SHA', async () => {
    const store = await open(); expect(await store.complete(admitted('completion'), signal())).toEqual({ objectVersion: 'fictional-version', checksum: session().checksum });
    expect(sent[0].input).toMatchObject({ IfNoneMatch: '*', ChecksumType: 'COMPOSITE', ChecksumSHA256: session().checksum,
      MpuObjectSize: bytes.length, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part().etag, ChecksumSHA256: part().checksum }] } });
    expect(session().checksum).not.toBe(Buffer.from(sha(bytes), 'hex').toString('base64'));
  });
  it.each([{ VersionId: 'null' }, { ChecksumSHA256: 'wrong' }, { ChecksumType: 'FULL_OBJECT' }, { Bucket: 'other' }, { Key: 'other' }])('refuses an unbound completion without settling its writer: %j', async change => {
    const store = await open(); respond = c => c.name === 'CompleteMultipartUploadCommand' ? { ...ordinary(c) as object, ...change } : ordinary(c);
    await expect(store.complete(admitted('completion'), signal())).rejects.toMatchObject({ settled: false });
  });
  it('makes no retries and only an explicit 412 is a definite provider rejection', async () => {
    const store = await open(); respond = () => { throw failure('PreconditionFailed', 412); };
    await expect(store.complete(admitted('completion'), signal())).rejects.toMatchObject({ settled: true });
    respond = () => { throw failure('InternalError', 500); };
    await expect(store.complete(admitted('completion', id(7)), signal())).rejects.toMatchObject({ settled: false }); expect(sent).toHaveLength(2);
  });
  it('aborts an ignored SDK await and keeps the remote writer uncertain', async () => {
    const store = await open(), op = new AbortController(); respond = () => new Promise(() => undefined);
    const work = store.create(admitted('creation'), op.signal); op.abort();
    await expect(work).rejects.toMatchObject({ settled: false, message: 'program_media_store_write_failed' }); expect(sent).toHaveLength(1);
  });
  it('captures release policy bytes before asynchronous resource reads', async () => {
    const r = review(); respond = c => { if (c.name === 'GetCallerIdentityCommand') r.policySha256 = 'f'.repeat(64); return ordinary(c); };
    const store = await open(config(), r); expect(await store.create(admitted('creation'), signal())).toEqual({ uploadId: 'fictional-upload' });
  });
  it('lists the exact upload parts and never interprets a denied/malformed listing as complete', async () => {
    const store = await open(); expect(await store.parts(session(), signal())).toEqual({ complete: true,
      parts: [{ partNumber: 1, bytes: bytes.length, checksum: part().checksum, etag: part().etag }] });
  });
  it.each([{ IsTruncated: undefined }, { UploadId: 'other' }, { Parts: [{ PartNumber: 1, Size: 5, ETag: part().etag, ChecksumSHA256: part().checksum }] },
    { Parts: [{ PartNumber: 2, Size: 4, ETag: part().etag, ChecksumSHA256: part().checksum }] }, { IsTruncated: true, NextPartNumberMarker: 0 }])('refuses inconsistent/looping parts: %j', async change => {
    const store = await open(); respond = c => c.name === 'ListPartsCommand' ? { ...ordinary(c) as object, ...change } : ordinary(c);
    expect((await store.parts(session(), signal())).complete).toBe(false);
  });
  it('inventories uploads and versions with both markers, skipping neighbouring exact keys', async () => {
    const store = await open(); let page = 0;
    respond = c => c.name === 'ListMultipartUploadsCommand' ? ++page === 1
      ? { Bucket: BUCKET, IsTruncated: true, Uploads: [{ Key: session().objectKey, UploadId: 'found-upload', Initiated: NOW }], NextKeyMarker: session().objectKey, NextUploadIdMarker: 'found-upload' }
      : { Bucket: BUCKET, IsTruncated: false, Uploads: [{ Key: session().objectKey + '.neighbor', UploadId: 'other' }] }
      : c.name === 'ListObjectVersionsCommand' ? { IsTruncated: false, Versions: [{ Key: session().objectKey, VersionId: 'v1', Size: 4 }], DeleteMarkers: [{ Key: session().objectKey, VersionId: 'marker' }] } : ordinary(c);
    const observed = await store.inventory(session(), signal()); expect(observed).toMatchObject({ complete: true, uploads: [{ uploadId: 'found-upload', initiatedAt: NOW.toISOString() }],
      versions: [{ objectVersion: 'v1', deleteMarker: false, bytes: 4 }, { objectVersion: 'marker', deleteMarker: true, bytes: null }] });
    expect(sent[1].input).toMatchObject({ KeyMarker: session().objectKey, UploadIdMarker: 'found-upload', Prefix: session().objectKey });
    expect(sent.some(c => c.name === 'HeadObjectCommand')).toBe(false);
  });
  it('never certifies failed/looping uploads, duplicate versions or a forbidden version as absence', async () => {
    const store = await open(); respond = () => { throw failure('AccessDenied', 403); };
    expect((await store.inventory(session(), signal())).complete).toBe(false);
    respond = c => c.name === 'ListMultipartUploadsCommand' ? { Bucket: BUCKET, IsTruncated: true, NextKeyMarker: session().objectKey, NextUploadIdMarker: 'repeat' } : ordinary(c);
    expect((await store.inventory(session(), signal())).complete).toBe(false);
    respond = c => c.name === 'ListObjectVersionsCommand' ? { IsTruncated: false, Versions: [{ Key: session().objectKey, VersionId: 'null', Size: 4 }] } : ordinary(c);
    expect((await store.inventory(session(), signal())).complete).toBe(false);
  });
  it.each(['parts', 'uploads', 'versions'])('refuses an oversized %s page before inspecting neighbouring entries', async kind => {
    const store = await open();
    respond = c => kind === 'parts' && c.name === 'ListPartsCommand' ? { ...ordinary(c) as object, Parts: Array.from({ length: 101 }, () => ({})) }
      : kind === 'uploads' && c.name === 'ListMultipartUploadsCommand' ? { Bucket: BUCKET, IsTruncated: false,
        Uploads: Array.from({ length: 101 }, () => ({ Key: session().objectKey + '.neighbor' })) }
      : kind === 'versions' && c.name === 'ListObjectVersionsCommand' ? { IsTruncated: false,
        Versions: Array.from({ length: 101 }, () => ({ Key: session().objectKey + '.neighbor' })) } : ordinary(c);
    expect((await (kind === 'parts' ? store.parts(session(), signal()) : store.inventory(session(), signal()))).complete).toBe(false);
  });
  it('uses the SDK string part marker and verifies every page of the exact manifest', async () => {
    const store = await open(), first = Buffer.alloc(PROGRAM_MEDIA_PART_BYTES, 1);
    const s = { ...session(), totalBytes: first.length + bytes.length,
      manifest: { totalBytes: first.length + bytes.length, parts: [{ partNumber: 1, bytes: first.length, sha256: sha(first) },
        { partNumber: 2, bytes: bytes.length, sha256: sha(bytes) }] } };
    s.checksum = programMediaCompositeChecksum(s.manifest);
    let page = 0;
    respond = c => c.name === 'ListPartsCommand' ? { ...ordinary(c) as object, IsTruncated: ++page === 1,
      ...(page === 1 ? { NextPartNumberMarker: '1' } : {}), Parts: [{ PartNumber: page, Size: page === 1 ? first.length : bytes.length,
        ChecksumSHA256: Buffer.from(s.manifest.parts[page - 1].sha256, 'hex').toString('base64'), ETag: `"part-${page}"` }] } : ordinary(c);
    const observed = await store.parts(s, signal());
    expect(observed.complete).toBe(true); expect(observed.parts.map(p => p.partNumber)).toEqual([1, 2]);
    expect(sent[1].input.PartNumberMarker).toBe('1');
  });
  it('verifies the exact version by streaming both whole and every part digest', async () => {
    const store = await open(), s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version', parts: [part()] };
    expect(await store.verify(s, signal())).toEqual({ objectVersion: s.objectVersion, checksum: s.checksum, sha256: s.sha256, bytes: bytes.length });
    expect(sent.map(c => c.name)).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    expect(sent[1].input).toMatchObject({ VersionId: 'fictional-version', ChecksumMode: 'ENABLED', ExpectedBucketOwner: ACCOUNT });
  });
  it.each(['long', 'short', 'wrong', 'wrong part'])('cancels a %s exact-version body without a verification proof', async what => {
    const store = await open(); const s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version' };
    let body: Readable | undefined;
    if (what === 'wrong part') { s.manifest.parts[0].sha256 = sha('different'); s.checksum = programMediaCompositeChecksum(s.manifest); }
    respond = c => c.name === 'GetObjectCommand' ? { ...stored(s), Body: body = Readable.from([what === 'long' ? Buffer.concat([bytes, bytes]) : what === 'short' ? bytes.subarray(0, 2) : what === 'wrong' ? Buffer.from('bad!') : bytes]) }
      : c.name === 'HeadObjectCommand' ? stored(s) : ordinary(c);
    await expect(store.verify(s, signal())).rejects.toThrow('service_unavailable'); expect(body!.destroyed).toBe(true);
  });
  it('refuses an exact-version header substitution before reading and does not treat 403 as missing', async () => {
    const store = await open(), s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version' };
    respond = c => c.name === 'HeadObjectCommand' ? { ...stored(), ChecksumType: 'FULL_OBJECT' } : ordinary(c);
    await expect(store.verify(s, signal())).rejects.toThrow('service_unavailable'); expect(sent).toHaveLength(1);
    respond = () => { throw failure('AccessDenied', 403); }; await expect(store.verify(s, signal())).rejects.toThrow('service_unavailable');
  });
  it('cancels a hanging web stream when request authority is withdrawn', async () => {
    const store = await open(), op = new AbortController(), cancel = vi.fn();
    const s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version' };
    respond = c => c.name === 'GetObjectCommand' ? { ...stored(), Body: new ReadableStream<Uint8Array>({ pull() { op.abort(); }, cancel }) } : ordinary(c);
    await expect(store.verify(s, op.signal)).rejects.toThrow('service_unavailable'); expect(cancel).toHaveBeenCalled();
  });
  it('disposes a GetObject body arriving after an ignored request abort', async () => {
    const store = await open(), op = new AbortController(), cancel = vi.fn();
    const s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version' };
    let deliver: ((value: unknown) => void) | undefined;
    respond = c => c.name === 'GetObjectCommand' ? new Promise(resolve => { deliver = resolve; }) : ordinary(c);
    const work = store.verify(s, op.signal);
    await vi.waitFor(() => expect(deliver).toBeDefined()); op.abort();
    await expect(work).rejects.toThrow('service_unavailable');
    deliver!({ ...stored(), Body: new ReadableStream<Uint8Array>({ cancel }) });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });
  it('cancels an acquired web reader on a hanging read', async () => {
    const store = await open(), op = new AbortController(), cancel = vi.fn(); let reading = false;
    const s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version' };
    respond = c => c.name === 'GetObjectCommand' ? { ...stored(), Body: { getReader: () => ({
      read: () => { reading = true; return new Promise(() => undefined); }, cancel,
    }) } } : ordinary(c);
    const work = store.verify(s, op.signal); await vi.waitFor(() => expect(reading).toBe(true)); op.abort();
    await expect(work).rejects.toThrow('service_unavailable'); expect(cancel).toHaveBeenCalled();
  });
  it('keeps a throwing iterator cancellation private and cannot return a proof for substituted bytes', async () => {
    const store = await open(), returned = vi.fn(() => { throw new Error('private provider detail'); });
    const s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version' };
    respond = c => c.name === 'GetObjectCommand' ? { ...stored(), Body: {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: Buffer.from('bad!') }), return: returned }),
    } } : ordinary(c);
    await expect(store.verify(s, signal())).rejects.toThrow('service_unavailable'); expect(returned).toHaveBeenCalled();
  });
  it('checks a stream chunk crossing an 8 MiB part boundary without whole-file allocation', async () => {
    const store = await open(), first = Buffer.alloc(PROGRAM_MEDIA_PART_BYTES, 1), last = bytes;
    const recipe = { totalBytes: first.length + last.length, parts: [{ partNumber: 1, bytes: first.length, sha256: sha(first) }, { partNumber: 2, bytes: last.length, sha256: sha(last) }] };
    const s = { ...session(), state: 'verifying' as const, objectVersion: 'fictional-version', manifest: recipe, totalBytes: recipe.totalBytes,
      sha256: createHash('sha256').update(first).update(last).digest('hex'), checksum: programMediaCompositeChecksum(recipe) };
    s.objectKey = `program-media/${s.clinic}/${s.programId}/${s.artifactId}/${s.sha256}.mp4`;
    respond = c => c.name === 'HeadObjectCommand' ? stored(s) : c.name === 'GetObjectCommand' ? { ...stored(s), Body: Readable.from([first.subarray(0, first.length - 2), Buffer.concat([first.subarray(first.length - 2), last])]) } : ordinary(c);
    expect(await store.verify(s, signal())).toMatchObject({ bytes: recipe.totalBytes, sha256: s.sha256 });
  });
  it('abort/delete return no absence receipt, keep exact key/version and reject denial', async () => {
    const store = await open(), s = { ...session(), state: 'abort_requested' as const };
    expect(await store.abort(s, 'fictional-upload', signal())).toBeUndefined();
    expect(await store.removeVersion(s, 'v1', signal())).toBeUndefined();
    expect(sent[0].input).toMatchObject({ Key: s.objectKey, UploadId: 'fictional-upload', ExpectedBucketOwner: ACCOUNT });
    expect(sent[1].input).toMatchObject({ Key: s.objectKey, VersionId: 'v1', ExpectedBucketOwner: ACCOUNT });
    respond = () => { throw failure('AccessDenied', 403); }; await expect(store.abort(s, 'fictional-upload', signal())).rejects.toThrow('service_unavailable');
    await expect(store.removeVersion(s, 'v1', signal())).rejects.toThrow('service_unavailable');
    await expect(store.removeVersion(s, 'null', signal())).rejects.toThrow('storage_unverified');
  });
  function committed() {
    const s = { ...session(), state: 'committed' as const, objectVersion: 'fictional-version', parts: [part()] };
    const artifact: ProgramMediaArtifact = { artifactId: s.artifactId, clinic: s.clinic, programId: s.programId, kind: s.kind, contentType: s.contentType,
      bytes: s.totalBytes, sha256: s.sha256, objectKey: s.objectKey, version: 1, state: 'ready', objectVersion: s.objectVersion,
      failure: null, committedAt: NOW.toISOString(), retiredAt: null, caption: null, transcript: null };
    return { s, artifact };
  }
  it('stream-verifies a committed multipart video before issuing its exact-version five-minute preview', async () => {
    const store = await open(), { s, artifact } = committed(), preview = await store.preview(s, artifact, signal());
    const url = new URL(preview.token);
    expect(sent.map(c => c.name)).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
    expect(url.searchParams.get('versionId')).toBe(s.objectVersion); expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(programMediaPreview.safeParse({ artifactId: artifact.artifactId, version: 1, state: 'ready', kind: 'video', contentType: s.contentType,
      bytes: s.totalBytes, sha256: s.sha256, previewToken: preview.token, previewUntil: preview.until, historical: false }).success).toBe(true);
  });
  it.each(['prepared', 'creation_admitted', 'uploading', 'completion_admitted', 'verifying', 'abort_requested', 'aborted'] as const)
    ('never previews %s sessions', async state => {
      const store = await open(), { s, artifact } = committed();
      await expect(store.preview({ ...s, state }, artifact, signal())).rejects.toThrow(); expect(sent).toHaveLength(0);
    });
  it.each(['pending', 'missing part', 'other author', 'other version', 'other artifact', 'other digest', 'held'])
    ('refuses preview of %s before the first object read', async kind => {
      const store = await open(), { s, artifact } = committed();
      if (kind === 'pending') s.pending = [{ claimId: id(8), kind: 'completion', partNumber: null, state: 'uncertain' }];
      if (kind === 'missing part') s.parts = [];
      if (kind === 'other author') s.actorId = id(88);
      if (kind === 'other version') artifact.objectVersion = 'different';
      if (kind === 'other artifact') artifact.artifactId = id(88);
      if (kind === 'other digest') artifact.sha256 = 'd'.repeat(64);
      if (kind === 'held') { artifact.state = 'held'; artifact.objectVersion = null; artifact.committedAt = null; }
      await expect(store.preview(s, artifact, signal())).rejects.toThrow(); expect(sent).toHaveLength(0);
    });
  it.each(['writer metadata', 'whole bytes', 'part digest', 'FULL_OBJECT'])
    ('refuses a preview when %s does not verify', async kind => {
      const store = await open(), { s, artifact } = committed();
      if (kind === 'part digest') {
        s.manifest.parts[0].sha256 = sha('bad!'); s.parts = [{ ...part(), sha256: sha('bad!'), checksum: Buffer.from(sha('bad!'), 'hex').toString('base64') }];
        s.checksum = programMediaCompositeChecksum(s.manifest);
      }
      respond = c => c.name === 'HeadObjectCommand' ? { ...stored(s),
        ...(kind === 'writer metadata' ? { Metadata: { ...metadata(s), 'writer-claim-id': id(88) } } : {}),
        ...(kind === 'FULL_OBJECT' ? { ChecksumType: 'FULL_OBJECT' } : {}) }
        : c.name === 'GetObjectCommand' ? { ...stored(s), Body: Readable.from([kind === 'whole bytes' ? Buffer.from('bad!') : bytes]) } : ordinary(c);
      await expect(store.preview(s, artifact, signal())).rejects.toThrow('service_unavailable');
      expect(sent.every(c => ['HeadObjectCommand', 'GetObjectCommand'].includes(c.name))).toBe(true);
    });
});
