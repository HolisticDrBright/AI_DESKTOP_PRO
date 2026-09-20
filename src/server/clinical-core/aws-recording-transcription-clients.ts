if (typeof window !== 'undefined') throw new Error('aws-recording-transcription-clients is server-only');
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetTranscriptionJobCommand, StartTranscriptionJobCommand, TranscribeClient } from '@aws-sdk/client-transcribe';
import type { TranscriptionMediaStore, TranscriptionProvider } from './recording-transcription';

const MEDIA_FORMAT: Record<string, 'webm' | 'ogg' | 'wav' | 'mp4' | 'mp3'> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3' };
/** Region-pinned, owner-checked, create-only object access; no delete or list. */
export function createAwsTranscriptionMediaStore(clientForRegion = (region: string) => new S3Client({
  region, endpoint: `https://s3.${region}.amazonaws.com`, followRegionRedirects: false, maxAttempts: 1 })): TranscriptionMediaStore {
  const clients = new Map<string, S3Client>();
  const client = (region: string) => { let v = clients.get(region); if (!v) { v = clientForRegion(region); clients.set(region, v); } return v; };
  return {
    async get(storage, key, version, maxBytes) {
      const result = await client(storage.region).send(new GetObjectCommand({ Bucket: storage.bucket, Key: key, VersionId: version,
        ExpectedBucketOwner: storage.expectedBucketOwner, Range: `bytes=0-${maxBytes}` }));
      const bytes = await result.Body!.transformToByteArray();
      if (bytes.length > maxBytes) throw new Error('media_too_large');
      return bytes;
    },
    async put(storage, key, bytes, contentType) {
      await client(storage.region).send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: contentType,
        ContentLength: bytes.length, IfNoneMatch: '*', ExpectedBucketOwner: storage.expectedBucketOwner,
        ServerSideEncryption: 'aws:kms', SSEKMSKeyId: storage.kmsKeyArn }));
    },
  };
}
export function createAwsTranscriptionProvider(clientForRegion = (region: string) => new TranscribeClient({ region, maxAttempts: 1 })): TranscriptionProvider {
  const clients = new Map<string, TranscribeClient>();
  const client = (region: string) => { let v = clients.get(region); if (!v) { v = clientForRegion(region); clients.set(region, v); } return v; };
  return {
    async start(input) {
      const format = MEDIA_FORMAT[input.contentType];
      if (!format) throw new Error('media_format_unsupported');
      await client(input.storage.region).send(new StartTranscriptionJobCommand({ TranscriptionJobName: input.jobName, LanguageCode: input.languageCode as never,
        MediaFormat: format, Media: { MediaFileUri: `s3://${input.storage.bucket}/${input.mediaKey}` },
        OutputBucketName: input.storage.bucket, OutputKey: input.outputKey, OutputEncryptionKMSKeyId: input.storage.kmsKeyArn,
        // Speaker labels only; no vocabulary filtering, content redaction toggles or custom models are configured here.
        Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 4 } }));
    },
    async status(jobName, storage) {
      const result = await client(storage.region).send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
      const status = result.TranscriptionJob?.TranscriptionJobStatus;
      return { state: status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : status === 'QUEUED' ? 'queued' : 'processing',
        failure: result.TranscriptionJob?.FailureReason?.slice(0, 80) };
    },
  };
}
