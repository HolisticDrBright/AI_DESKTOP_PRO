import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createRecordingSegmentUploader, createRecordingSegmentRepository, RecordingUploadError,
  type RecordingSegmentReservation, type RecordingStoredObject } from './recording-segments';
import { createAwsRecordingSegmentStore } from './aws-recording-segment-store';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';

const id = '11111111-1111-4111-8111-111111111111', segmentId = '22222222-2222-4222-8222-222222222222';
const context: ProductionClinicalRequestContext = { actorPersonId: id, organizationId: id, identityPool: 'workforce',
  identitySubject: 'fictional-subject', purpose: 'clinical_data', environment: 'production-clinical',
  dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
const bytes = Buffer.from('FICTIONAL AUDIO BYTES ONLY'), sha256 = createHash('sha256').update(bytes).digest('hex');
const input = { recordingId: id, sessionId: id, captureToken: 'a'.repeat(64), sequence: 0, sha256, bytes: bytes.length };
const now = Date.parse('2026-09-17T00:00:00Z');
function fixture() {
  const reservation: RecordingSegmentReservation = { segmentId, recordingId: id, sessionId: id, sequence: 0, sha256,
    bytes: bytes.length, contentType: 'audio/webm', authorityEpoch: 2, status: 'reserved', objectVersion: null,
    objectKey: `encounter-recordings/${id}/${id}/${id}/0-${sha256}`, acceptBefore: new Date(now + 30000).toISOString(),
    storage: { bucket: 'fictional-recording-storage', expectedBucketOwner: '123456789012', region: 'us-east-2',
      kmsKeyArn: `arn:aws:kms:us-east-2:123456789012:key/${id}`, maxSegmentBytes: 4194304 } };
  const receipt = { segmentId, recordingId: id, sequence: 0, sha256, bytes: bytes.length, authorityEpoch: 2, status: 'stored' as const };
  const head: RecordingStoredObject = { version: 'fictional-version', bytes: bytes.length, contentType: 'audio/webm',
    checksum: Buffer.from(sha256, 'hex').toString('base64'), checksumType: 'FULL_OBJECT', encryption: 'aws:kms', kmsKeyArn: reservation.storage.kmsKeyArn,
    metadata: { 'segment-id': segmentId, 'recording-id': id, 'session-id': id, 'authority-epoch': '2' } };
  const repository = { reserve: vi.fn(async () => reservation), complete: vi.fn(async () => receipt) };
  const storage = { put: vi.fn(async () => ({ version: head.version })), head: vi.fn(async () => head) };
  return { reservation, receipt, head, repository, storage, upload: createRecordingSegmentUploader(repository, storage, () => now) };
}
describe('consent-bound recording upload', () => {
  it('rejects a request MIME type that differs from the qualified capture before touching storage', async () => {
    const f = fixture();
    await expect(f.upload(context, { ...input, contentType: 'audio/mp4' }, bytes)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(f.storage.put).not.toHaveBeenCalled(); expect(f.storage.head).not.toHaveBeenCalled();
  });
  it('verifies actual bytes, stores outside the transaction and returns only a bounded accepted receipt', async () => {
    const f = fixture();
    expect(await f.upload(context, input, bytes)).toEqual(f.receipt);
    expect(f.repository.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.storage.put.mock.invocationCallOrder[0]);
    expect(f.storage.head.mock.invocationCallOrder[0]).toBeLessThan(f.repository.complete.mock.invocationCallOrder[0]);
    expect(f.repository.complete).toHaveBeenCalledWith(context, input, segmentId, 'fictional-version');
  });
  it.each([{ bytes: 0 }, { bytes: 4194305 }, { bytes: bytes.length + 1 }, { sha256: 'b'.repeat(64) },
    { sequence: -1 }, { sequence: 4096 }, { captureToken: '' }, { bucket: 'arbitrary' }, { organizationId: id }])('rejects altered input before database or storage %j', async patch => {
    const f = fixture();
    await expect(f.upload(context, { ...input, ...patch }, bytes)).rejects.toMatchObject({ code: 'request_invalid' });
    expect(f.repository.reserve).not.toHaveBeenCalled(); expect(f.storage.put).not.toHaveBeenCalled();
  });
  it('does not upload when consent authorization refuses', async () => {
    const f = fixture(); f.repository.reserve.mockRejectedValue(new RecordingUploadError('consent_required'));
    await expect(f.upload(context, input, bytes)).rejects.toMatchObject({ code: 'consent_required' });
    expect(f.storage.put).not.toHaveBeenCalled();
  });
  it('recovers a lost PUT response by verifying the existing object and does not issue another PUT', async () => {
    const f = fixture(); f.storage.put.mockRejectedValue(new Error('uncertain secret upstream content'));
    expect(await f.upload(context, input, bytes)).toEqual(f.receipt);
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.storage.head).toHaveBeenCalledWith(f.reservation, undefined, expect.any(AbortSignal));
  });
  it('does not report accepted data when consent changes after upload', async () => {
    const f = fixture(); f.repository.complete.mockRejectedValue(new RecordingUploadError('access_refused'));
    await expect(f.upload(context, input, bytes)).rejects.toMatchObject({ code: 'access_refused' });
    expect(f.storage.put).toHaveBeenCalledTimes(1);
  });
  it.each([{ version: undefined }, { version: 'null' }, { version: 'other-version' }, { checksum: 'wrong' },
    { checksumType: 'COMPOSITE' }, { bytes: 0 }, { contentType: 'text/plain' }, { encryption: 'AES256' },
    { kmsKeyArn: 'other-key' }, { metadata: {} }, { deleteMarker: true }])('rejects unverified S3 evidence %j', async patch => {
    const f = fixture(); f.storage.head.mockResolvedValue({ ...f.head, ...patch });
    await expect(f.upload(context, input, bytes)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it.each(['segment-id', 'recording-id', 'session-id', 'authority-epoch'])('rejects mismatched %s object provenance', async field => {
    const f = fixture(); f.head.metadata![field] = 'other';
    await expect(f.upload(context, input, bytes)).rejects.toMatchObject({ code: 'storage_unverified' });
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
  it.each(['objectKey', 'recordingId', 'sessionId', 'sequence', 'sha256', 'bytes'])('rejects mismatched database reservation %s', async field => {
    const f = fixture();
    Object.assign(f.reservation, { [field]: field === 'sequence' || field === 'bytes' ? 1 : field.endsWith('Id') ? segmentId : 'wrong' });
    await expect(f.upload(context, input, bytes)).rejects.toBeInstanceOf(RecordingUploadError);
    expect(f.storage.put).not.toHaveBeenCalled();
  });
  it('does not rewrite an already accepted object on exact retry, but still revalidates consent', async () => {
    const f = fixture(); f.reservation.status = 'stored'; f.reservation.objectVersion = 'fictional-version';
    expect(await f.upload(context, input, bytes)).toEqual(f.receipt);
    expect(f.storage.put).not.toHaveBeenCalled(); expect(f.storage.head).not.toHaveBeenCalled();
    expect(f.repository.complete).toHaveBeenCalledTimes(1);
  });
  it('withholds an incorrect final receipt', async () => {
    const f = fixture(); f.repository.complete.mockResolvedValue({ ...f.receipt, authorityEpoch: 9 });
    await expect(f.upload(context, input, bytes)).rejects.toMatchObject({ code: 'storage_unverified' });
  });
  it('refuses an expired lease before network I/O and withholds completion after deadline', async () => {
    const f = fixture(); f.reservation.acceptBefore = new Date(now - 1).toISOString();
    await expect(f.upload(context, input, bytes)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(f.storage.put).not.toHaveBeenCalled(); expect(f.storage.head).not.toHaveBeenCalled();
    let clock = now; const g = fixture();
    g.storage.head.mockImplementation(async () => { clock += 21000; return g.head; });
    await expect(createRecordingSegmentUploader(g.repository, g.storage, () => clock)(context, input, bytes)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(g.repository.complete).not.toHaveBeenCalled();
  });
  it('sanitizes storage errors and leaves reconciliation to the durable reservation', async () => {
    const f = fixture(); f.storage.head.mockRejectedValue(new Error('credential and health payload'));
    await expect(f.upload(context, input, bytes)).rejects.toThrow(/^service_unavailable$/);
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
});

describe('recording SQL repository', () => {
  it('uses fixed parameterized commands and decodes Data API JSON', async () => {
    const f = fixture();
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ data: JSON.stringify(f.reservation) }] });
    const db: ClinicalCoreDatabase = { transaction: work => work({ query } as ClinicalCoreTransaction) };
    expect(await createRecordingSegmentRepository(db).reserve(context, input)).toEqual(f.reservation);
    expect(query.mock.calls[1][0]).toContain('$4::integer'); expect(query.mock.calls[1][0]).not.toContain(input.captureToken);
  });
  it('refuses consumer identity before opening a transaction', async () => {
    const transaction = vi.fn();
    await expect(createRecordingSegmentRepository({ transaction }).reserve({ ...context, identityPool: 'consumer' }, input)).rejects.toMatchObject({ code: 'access_refused' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([null, 'not-json', { secret: 'must-not-leak' }])('rejects malformed response %j', async data => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ data }] });
    const db: ClinicalCoreDatabase = { transaction: work => work({ query } as ClinicalCoreTransaction) };
    await expect(createRecordingSegmentRepository(db).reserve(context, input)).rejects.toThrow(/^service_unavailable$/);
  });
  it.each(['consent_required', 'conflict', 'request_invalid', 'identity_refused'] as const)('maps database refusal %s without raw SQL', async category => {
    const db: ClinicalCoreDatabase = { transaction: async () => { throw new ClinicalCoreDatabaseRejection(category); } };
    await expect(createRecordingSegmentRepository(db).reserve(context, input)).rejects.toMatchObject({ code: category === 'identity_refused' ? 'access_refused' : category });
  });
});

describe('AWS conditional object store adapter', () => {
  it('pins bucket owner/KMS/checksum/metadata and uses version-specific checksum HEAD without encryption headers', async () => {
    const f = fixture(), client = new S3Client({ region: 'us-east-2', credentials: { accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
    const send = vi.spyOn(client, 'send');
    send.mockImplementation((async () => ({ VersionId: 'fictional-version', ChecksumType: 'FULL_OBJECT' })) as S3Client['send']);
    const factory = vi.fn(() => client), store = createAwsRecordingSegmentStore(factory), signal = AbortSignal.timeout(1000);
    await store.put(f.reservation, bytes, signal); await store.head(f.reservation, 'fictional-version', signal);
    expect(factory).toHaveBeenCalledTimes(1);
    const put = send.mock.calls[0][0] as PutObjectCommand, head = send.mock.calls[1][0] as HeadObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ IfNoneMatch: '*', ContentLength: bytes.length, ExpectedBucketOwner: '123456789012',
      SSEKMSKeyId: f.reservation.storage.kmsKeyArn, ServerSideEncryption: 'aws:kms', ChecksumSHA256: f.head.checksum });
    expect(put.input.Metadata).toEqual(f.head.metadata);
    expect(head).toBeInstanceOf(HeadObjectCommand);
    expect(head.input).toMatchObject({ VersionId: 'fictional-version', ChecksumMode: 'ENABLED', ExpectedBucketOwner: '123456789012' });
    expect(head.input).not.toHaveProperty('ServerSideEncryption');
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal });
    client.destroy();
  });
});
