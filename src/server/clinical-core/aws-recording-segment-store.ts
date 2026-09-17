if (typeof window !== 'undefined') throw new Error('aws-recording-segment-store is server-only');
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { RecordingObjectStore, RecordingSegmentReservation } from './recording-segments';

/** No caller-selected endpoint, presigned public URL, overwrite or delete path. */
export function createAwsRecordingSegmentStore(clientForRegion = (region: string) => new S3Client({
  region, endpoint: `https://s3.${region}.amazonaws.com`, followRegionRedirects: false, maxAttempts: 1,
})): RecordingObjectStore {
  const clients = new Map<string, S3Client>();
  const client = (region: string) => {
    let value = clients.get(region);
    if (!value) { value = clientForRegion(region); clients.set(region, value); }
    return value;
  };
  const base = (r: RecordingSegmentReservation) => ({ Bucket: r.storage.bucket, Key: r.objectKey, ExpectedBucketOwner: r.storage.expectedBucketOwner });
  return {
    async put(r, bytes, signal) {
      const result = await client(r.storage.region).send(new PutObjectCommand({ ...base(r), Body: bytes,
        ContentType: r.contentType, ContentLength: r.bytes, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: Buffer.from(r.sha256, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: r.storage.kmsKeyArn,
        Metadata: { 'segment-id': r.segmentId, 'recording-id': r.recordingId, 'session-id': r.sessionId, 'authority-epoch': String(r.authorityEpoch) },
      }), { abortSignal: signal });
      return { version: result.VersionId };
    },
    async head(r, objectVersion, signal) {
      const result = await client(r.storage.region).send(new HeadObjectCommand({ ...base(r), VersionId: objectVersion, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
      return { version: result.VersionId, bytes: result.ContentLength, contentType: result.ContentType,
        checksum: result.ChecksumSHA256, checksumType: result.ChecksumType, encryption: result.ServerSideEncryption,
        kmsKeyArn: result.SSEKMSKeyId, metadata: result.Metadata, deleteMarker: result.DeleteMarker };
    },
  };
}
