import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import type { ProgramMediaReservation } from '@/contracts/programMedia';
import { ProgramMediaWriteError } from './program-media-authoring';
import { createAwsProgramMediaStoreSource, type AwsProgramMediaStoreConfiguration } from './aws-program-media-store';

// Actual SDK commands, clients and signer, but every network send is fictional.
// This file proves request construction and response/failure semantics, NOT AWS.
const ACCOUNT = '588966314750', REGION = 'us-east-2';
const KMS = `arn:aws:kms:${REGION}:${ACCOUNT}:key/c13ec29d-0e47-4c02-9136-f371bcbb7900`;
const CLINICAL_KMS = `arn:aws:kms:${REGION}:${ACCOUNT}:key/10000000-0000-4000-8000-000000000000`;
const CLINIC = '40000000-0000-4000-8000-000000000001', PROGRAM = '40000000-0000-4000-8000-000000000010';
const NOW = new Date('2026-10-11T22:00:00Z');
const bytes = new TextEncoder().encode('fictional educational bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const reservation: ProgramMediaReservation = { artifactId: '40000000-0000-4000-8000-000000000020',
  clinic: CLINIC, programId: PROGRAM, commandId: '40000000-0000-4000-8000-000000000030', kind: 'image', contentType: 'image/png',
  bytes: bytes.length, sha256: digest, objectKey: `program-media/${CLINIC}/${PROGRAM}/40000000-0000-4000-8000-000000000020/${digest}.png`,
  state: 'reserved', acceptBefore: '2026-10-11T22:15:00Z', createdAt: NOW.toISOString(), replayed: false, failure: null };
const configuration = (): AwsProgramMediaStoreConfiguration => ({
  storage: { purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-program-media',
    expectedBucketOwner: ACCOUNT, region: REGION, kmsKeyArn: KMS, maxImageBytes: 1024, maxVideoBytes: 4096,
    publicOrigin: 'https://media.fictional.example/' },
  scope: { clinic: CLINIC, programId: PROGRAM }, expectedRoleArn: `arn:aws:iam::${ACCOUNT}:role/ALPProgramMediaQualification`,
  credentials: { accessKeyId: 'ASIA' + 'F'.repeat(16), secretAccessKey: 'F'.repeat(40), sessionToken: 'fictional-session-token',
    expiration: new Date('2026-10-11T23:00:00Z') },
  forbiddenBuckets: ['alp-fictional-recording-store'], forbiddenKmsKeyArns: [CLINICAL_KMS],
});
type Sent = { name: string; input: Record<string, unknown>; signal?: AbortSignal };
let sent: Sent[], response: (command: Sent) => unknown | Promise<unknown>;
let close: (() => void) | undefined;
const signal = () => new AbortController().signal;
const metadata = () => ({ 'artifact-id': reservation.artifactId, 'program-id': PROGRAM, clinic: CLINIC, purpose: 'educational_media' });
const head = (version = 'fictional-v1') => ({ VersionId: version, ContentLength: bytes.length, ContentType: 'image/png',
  ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'), ChecksumType: 'FULL_OBJECT', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS, Metadata: metadata() });
const policy = () => ({ Statement: [
  { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: ['arn:aws:s3:::alp-fictional-program-media', 'arn:aws:s3:::alp-fictional-program-media/*'], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
  ...[['s3:x-amz-server-side-encryption', 'aws:kms'], ['s3:x-amz-server-side-encryption-aws-kms-key-id', KMS]].map(([key, value]) => ({ Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: 'arn:aws:s3:::alp-fictional-program-media/*', Condition: { StringNotEquals: { [key]: value } } })),
] });
function ordinary(c: Sent): unknown {
  switch (c.name) {
    case 'GetCallerIdentityCommand': return { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ALPProgramMediaQualification/fictional-session` };
    case 'GetBucketVersioningCommand': return { Status: 'Enabled' };
    case 'GetBucketEncryptionCommand': return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KMS } }] } };
    case 'GetPublicAccessBlockCommand': return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
    case 'GetBucketOwnershipControlsCommand': return { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } };
    case 'GetBucketTaggingCommand': return { TagSet: [{ Key: 'alp:purpose', Value: 'educational_media' }, { Key: 'alp:classification', Value: 'synthetic_only' }, { Key: 'alp:phi-allowed', Value: 'false' }, { Key: 'alp:dedicated', Value: 'true' }] };
    case 'GetBucketPolicyCommand': return { Policy: JSON.stringify(policy()) };
    case 'PutObjectCommand': return { VersionId: 'fictional-v1' };
    case 'HeadObjectCommand': return head(c.input.VersionId as string | undefined);
    case 'ListObjectVersionsCommand': return { IsTruncated: false, Versions: [], DeleteMarkers: [] };
    case 'DeleteObjectCommand': return { VersionId: c.input.VersionId };
    default: throw new Error('unexpected SDK command');
  }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); sent = []; response = ordinary;
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => {
    const c = { name: command.constructor.name, input: command.input, signal: options?.abortSignal }; sent.push(c); return response(c);
  };
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(send as never);
  vi.spyOn(STSClient.prototype, 'send').mockImplementation(send as never);
});
afterEach(() => { close?.(); close = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
async function store(config = configuration(), requestSignal = signal()) {
  const result = await createAwsProgramMediaStoreSource(config, requestSignal); close = result.close; sent = []; return result.store;
}
function serviceError(name: string, status: number) { return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status }, message: 'fictional provider detail must not escape' }); }

describe('native program media source over fictional SDK sends', () => {
  it('copies a Node Buffer before passing upload bytes to the asynchronous SDK',async()=>{
    const opened=await createAwsProgramMediaStoreSource(configuration(),signal());close=opened.close;
    const mutable=Buffer.from(bytes),upload=opened.store.put(reservation,mutable,signal());mutable.fill(0);await upload;
    const body=sent.find(c=>c.name==='PutObjectCommand')!.input.Body as Uint8Array;
    expect(Buffer.from(body)).toEqual(Buffer.from(bytes));
  });
  it.each([
    ['production account', (c: AwsProgramMediaStoreConfiguration) => { c.storage.expectedBucketOwner = '173535830222'; }],
    ['wrong region', (c: AwsProgramMediaStoreConfiguration) => { c.storage.region = 'us-east-1'; }],
    ['clinical bucket', (c: AwsProgramMediaStoreConfiguration) => { c.storage.bucket = 'alp-clinical-recording'; }],
    ['shared bucket', (c: AwsProgramMediaStoreConfiguration) => { c.forbiddenBuckets.push(c.storage.bucket); }],
    ['shared KMS', (c: AwsProgramMediaStoreConfiguration) => { c.forbiddenKmsKeyArns.push(KMS); }],
    ['ambient or long-lived credentials', (c: AwsProgramMediaStoreConfiguration) => { c.credentials.accessKeyId = 'AKIA' + 'F'.repeat(16); }],
    ['expired credentials', (c: AwsProgramMediaStoreConfiguration) => { c.credentials.expiration = new Date(NOW); }],
    ['overlong session', (c: AwsProgramMediaStoreConfiguration) => { c.credentials.expiration = new Date(NOW.getTime() + 13 * 60 * 60_000); }],
    ['admin role', (c: AwsProgramMediaStoreConfiguration) => { c.expectedRoleArn = `arn:aws:iam::${ACCOUNT}:role/AdministratorAccess`; }],
    ['missing separation inventory', (c: AwsProgramMediaStoreConfiguration) => { c.forbiddenKmsKeyArns = []; }],
  ])('refuses %s at construction before SDK I/O', async (_name, change) => {
    const c = configuration(); change(c); await expect(createAwsProgramMediaStoreSource(c, signal())).rejects.toThrow('storage_unverified');
    expect(sent).toHaveLength(0);
  });
  it.each([
    ['caller account', 'GetCallerIdentityCommand', { Account: '173535830222', Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ALPProgramMediaQualification/session` }],
    ['caller role', 'GetCallerIdentityCommand', { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/OtherRole/session` }],
    ['malformed session', 'GetCallerIdentityCommand', { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/ALPProgramMediaQualification/session/other` }],
    ['versioning suspension', 'GetBucketVersioningCommand', { Status: 'Suspended' }],
    ['missing encryption', 'GetBucketEncryptionCommand', {}],
    ['wrong encryption key', 'GetBucketEncryptionCommand', { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: CLINICAL_KMS } }] } }],
    ['missing public blocks', 'GetPublicAccessBlockCommand', {}],
    ['public policy', 'GetPublicAccessBlockCommand', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: true } }],
    ['object ownership', 'GetBucketOwnershipControlsCommand', { OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] } }],
    ['missing purpose tags', 'GetBucketTaggingCommand', { TagSet: [] }],
    ['invalid denial policy', 'GetBucketPolicyCommand', { Policy: '{}' }],
  ])('refuses observed %s before exposing the store', async (_name, name, result) => {
    response = c => c.name === name ? result : ordinary(c);
    await expect(createAwsProgramMediaStoreSource(configuration(), signal())).rejects.toThrow('storage_unverified');
    expect(sent.every(c => !['PutObjectCommand', 'DeleteObjectCommand'].includes(c.name))).toBe(true);
  });
  it('requires independent TLS, encryption-mode and exact-key denial statements, not a combined AND condition', async () => {
    const p = policy(); p.Statement = [p.Statement[0], { Effect: 'Deny', Principal: '*', Action: 's3:PutObject',
      Resource: 'arn:aws:s3:::alp-fictional-program-media/*', Condition: { StringNotEquals: {
        's3:x-amz-server-side-encryption': 'aws:kms', 's3:x-amz-server-side-encryption-aws-kms-key-id': KMS } } }];
    response = c => c.name === 'GetBucketPolicyCommand' ? { Policy: JSON.stringify(p) } : ordinary(c);
    await expect(createAwsProgramMediaStoreSource(configuration(), signal())).rejects.toThrow('storage_unverified');
  });
  it('conditionally writes exact bytes with checksum, KMS, owner and educational metadata', async () => {
    const value = await store(); expect(await value.put(reservation, bytes, signal())).toEqual({ version: 'fictional-v1' });
    expect(sent).toHaveLength(1); expect(sent[0].input).toMatchObject({ Bucket: configuration().storage.bucket, Key: reservation.objectKey,
      ExpectedBucketOwner: ACCOUNT, ContentLength: bytes.length, ContentType: 'image/png', IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS, Metadata: metadata() });
    expect(sent[0].signal).toBeInstanceOf(AbortSignal);
  });
  it('reads exact versions with checksum mode and never calls 403 absence', async () => {
    const value = await store(); expect(await value.head(reservation, 'fictional-v1', signal())).toMatchObject({ version: 'fictional-v1', checksumType: 'FULL_OBJECT', bytes: bytes.length });
    expect(sent[0].input).toMatchObject({ VersionId: 'fictional-v1', ChecksumMode: 'ENABLED', ExpectedBucketOwner: ACCOUNT });
    response = () => { throw serviceError('AccessDenied', 403); }; await expect(value.head(reservation, undefined, signal())).rejects.toThrow('service_unavailable');
    response = () => { throw serviceError('NotFound', 404); }; expect(await value.head(reservation, undefined, signal())).toBeNull();
  });
  it('classifies only a definite provider rejection as settled; lost replies and missing versions stay uncertain', async () => {
    const value = await store(); response = () => { throw serviceError('PreconditionFailed', 412); };
    await expect(value.put(reservation, bytes, signal())).rejects.toMatchObject({ settled: true });
    response = () => { throw new Error('lost reply'); }; await expect(value.put(reservation, bytes, signal())).rejects.toMatchObject({ settled: false });
    response = () => ({ VersionId: 'null' }); await expect(value.put(reservation, bytes, signal())).rejects.toMatchObject({ settled: false });
  });
  it('lists both continuation markers, exact keys and delete markers before claiming completeness', async () => {
    const value = await store(); let pages = 0;
    response = c => c.name === 'ListObjectVersionsCommand'
      ? ++pages === 1 ? { IsTruncated: true, Versions: [{ Key: reservation.objectKey, VersionId: 'fictional-v1', Size: bytes.length }], NextKeyMarker: reservation.objectKey, NextVersionIdMarker: 'fictional-v1' }
        : { IsTruncated: false, Versions: [{ Key: reservation.objectKey + '.neighbour', VersionId: 'foreign' }], DeleteMarkers: [{ Key: reservation.objectKey, VersionId: 'fictional-marker' }] }
      : ordinary(c);
    const found = await value.inventory(reservation, signal()); expect(found.complete).toBe(true); expect(found.versions).toHaveLength(2);
    expect(found.versions[1]).toMatchObject({ version: 'fictional-marker', deleteMarker: true, listedKey: reservation.objectKey });
    const listings = sent.filter(c => c.name === 'ListObjectVersionsCommand');
    expect(listings[1].input).toMatchObject({ KeyMarker: reservation.objectKey, VersionIdMarker: 'fictional-v1', Prefix: reservation.objectKey });
    expect(sent.filter(c => c.name === 'HeadObjectCommand')).toHaveLength(1);
  });
  it('refuses incomplete, looping, malformed or disappearing version inventories', async () => {
    const value = await store();
    response = () => ({ IsTruncated: true, Versions: [], NextKeyMarker: reservation.objectKey, NextVersionIdMarker: 'v1' });
    expect((await value.inventory(reservation, signal())).complete).toBe(false);
    response = () => ({ Versions: [] }); expect((await value.inventory(reservation, signal())).complete).toBe(false);
    response = c => c.name === 'ListObjectVersionsCommand' ? { IsTruncated: false, Versions: [{ Key: reservation.objectKey, VersionId: 'null' }] } : ordinary(c);
    expect((await value.inventory(reservation, signal())).complete).toBe(false);
    response = c => { if (c.name === 'HeadObjectCommand') throw serviceError('NotFound', 404); return { IsTruncated: false, Versions: [{ Key: reservation.objectKey, VersionId: 'v1', Size: bytes.length }] }; };
    expect((await value.inventory(reservation, signal())).complete).toBe(false);
  });
  it('handles a page boundary between neighbouring keys without inventing a version marker', async () => {
    const value = await store(); let page = 0;
    response = c => c.name === 'ListObjectVersionsCommand' ? ++page === 1
      ? { IsTruncated: true, Versions: [], NextKeyMarker: reservation.objectKey + '.neighbour' }
      : { IsTruncated: false, Versions: [] } : ordinary(c);
    expect(await value.inventory(reservation, signal())).toEqual({ complete: true, versions: [] });
    expect(sent[1].input).toMatchObject({ KeyMarker: reservation.objectKey + '.neighbour', VersionIdMarker: undefined });
  });
  it('refuses duplicate version ids across data and markers and an unbounded listing', async () => {
    const value = await store(); response = () => ({ IsTruncated: false, Versions: [{ Key: reservation.objectKey, VersionId: 'v1' }], DeleteMarkers: [{ Key: reservation.objectKey, VersionId: 'v1' }] });
    expect((await value.inventory(reservation, signal())).complete).toBe(false);
    response = c => c.name === 'ListObjectVersionsCommand' ? { IsTruncated: false, DeleteMarkers: Array.from({ length: 1001 }, (_, n) => ({ Key: reservation.objectKey, VersionId: 'marker-' + n })) } : ordinary(c);
    expect((await value.inventory(reservation, signal())).complete).toBe(false);
  });
  it('keeps writes uncertain after an ignored operation abort or late request boundary; never leaks provider detail', async () => {
    const value = await store(), operation = new AbortController();
    response = c => { if (c.name === 'PutObjectCommand') operation.abort(); return ordinary(c); };
    await expect(value.put(reservation, bytes, operation.signal)).rejects.toMatchObject({ settled: false, message: 'program_media_store_write_failed' });
    response = c => { if (c.name === 'PutObjectCommand') vi.setSystemTime(new Date(NOW.getTime() + 31_000)); return ordinary(c); };
    await expect(value.put(reservation, bytes, signal())).rejects.toMatchObject({ settled: false });
    const calls = sent.length; await expect(value.put(reservation, bytes, signal())).rejects.toMatchObject({ settled: true }); expect(sent).toHaveLength(calls);
  });
  it('never marks an aborted or denied inventory complete, including when the provider ignores the abort', async () => {
    const value = await store(), op = new AbortController(); response = () => { op.abort(); return { IsTruncated: false, Versions: [] }; };
    expect((await value.inventory(reservation, op.signal)).complete).toBe(false);
    response = () => { throw serviceError('AccessDenied', 403); }; expect((await value.inventory(reservation, signal())).complete).toBe(false);
  });
  it('copies input bytes and captures credentials/scope rather than observing later caller mutations', async () => {
    const c = configuration(), value = await store(c); c.credentials.accessKeyId = 'ASIA' + 'Z'.repeat(16); c.scope.clinic = PROGRAM;
    c.credentials.expiration.setTime(0); const inputBytes = bytes.slice(); const writing = value.put(reservation, inputBytes, signal()); inputBytes.fill(0);
    await writing; expect(sent[0].input.Body).toEqual(bytes); expect(sent[0].input.Body).not.toBe(inputBytes);
    expect(await value.head(reservation, undefined, signal())).toMatchObject({ version: 'fictional-v1' });
  });
  it('deletes only an explicit version and treats denial as failure, never receipt', async () => {
    const value = await store(); await value.remove(reservation, 'fictional-v1', signal());
    expect(sent[0].input).toMatchObject({ Key: reservation.objectKey, VersionId: 'fictional-v1', ExpectedBucketOwner: ACCOUNT });
    await expect(value.remove(reservation, 'null', signal())).rejects.toThrow();
    response = () => { throw serviceError('AccessDenied', 403); }; await expect(value.remove(reservation, 'fictional-v1', signal())).rejects.toThrow('service_unavailable');
  });
  it('refuses cross-program, substituted keys, mismatched bytes and post-close operations before I/O', async () => {
    const value = await store();
    await expect(value.put({ ...reservation, programId: CLINIC }, bytes, signal())).rejects.toBeInstanceOf(ProgramMediaWriteError);
    await expect(value.put({ ...reservation, objectKey: 'program-media/another' }, bytes, signal())).rejects.toMatchObject({ settled: true });
    await expect(value.put(reservation, new Uint8Array(bytes.length), signal())).rejects.toMatchObject({ settled: true });
    expect(sent).toHaveLength(0); close?.(); await expect(value.head(reservation, undefined, signal())).rejects.toThrow(); expect(sent).toHaveLength(0);
  });
  it('signs an exact-version read with a five-minute cap, no published origin and no write', async () => {
    const value = await store(); const artifact = { artifactId: reservation.artifactId, clinic: CLINIC, programId: PROGRAM,
      kind: reservation.kind, contentType: reservation.contentType, bytes: bytes.length, sha256: digest, objectKey: reservation.objectKey,
      version: 1, state: 'ready' as const, objectVersion: 'fictional-v1', failure: null,
      committedAt: NOW.toISOString(), retiredAt: null, caption: null, transcript: null };
    const preview = await value.preview(artifact, signal()); const url = new URL(preview.token);
    expect(url.hostname).toBe('alp-fictional-program-media.s3.us-east-2.amazonaws.com');
    expect(url.searchParams.get('versionId')).toBe('fictional-v1'); expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(preview.until).toBe('2026-10-11T22:05:00.000Z'); expect(sent.every(c => c.name !== 'PutObjectCommand')).toBe(true);
  });
});
