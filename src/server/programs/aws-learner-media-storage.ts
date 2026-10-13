if (typeof window !== 'undefined') throw new Error('learner media storage reader is server-only');
import { randomBytes } from 'node:crypto';
import { HeadObjectCommand, S3Client, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import { issueAwsProgramMediaVersionPreview } from './aws-program-media-preview';
import { LearnerMediaError, type LearnerMediaObject, type LearnerMediaStorage } from './learner-media';

/**
 * The learner media storage reader (installed only from a reviewed host target): for ONE admitted
 * object version it
 *   1. assumes the reviewed learner-reader role with a session policy naming exactly that object
 *      (GetObject/GetObjectVersion on its one key, Decrypt on the one reviewed key), so the
 *      credentials cannot read any other object even if the role could;
 *   2. reads the exact version's metadata (HEAD, checksum mode on) and requires: that version, not a
 *      delete marker, the exact byte count and content type, SSE-KMS under the reviewed key, the
 *      identity metadata the authoring store wrote (artifact, program, clinic, educational purpose)
 *      and the whole-object SHA-256 the ledger admitted (the full-object checksum for a single
 *      upload; the whole-file digest the multipart commit verified, for a composite one);
 *   3. signs a GET of that exact version for five minutes with the existing exact-version signer
 *      (private, no-store; the regional bucket host only).
 * The bytes of an S3 object version are immutable, so step 2 binds the capability to the bytes the
 * ledger admitted. No redirect is followed, no address from the ledger or the browser is fetched,
 * and no provider credential leaves the server: the browser receives one bearer URL.
 *
 * A signed URL is a bearer capability. It cannot be recalled once returned; its exposure is bounded
 * by its five-minute life, the scoped session and the bucket policy. It must never be logged,
 * stored, cached or placed in a curriculum.
 */
const role = z.string().regex(/^arn:aws:iam::588966314750:role\/[A-Za-z0-9_+=,.@/-]{1,120}$/)
  .refine(v => !/admin|root|recording|clinical|patient|voice|author|writer|upload/i.test(v));
export const learnerMediaStorageConfig = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).refine(v => !/(recording|voice|encounter|transcript|phi|patient)/.test(v)),
  expectedBucketOwner: z.literal('588966314750'), region: z.literal('us-east-2'),
  kmsKeyArn: z.string().regex(/^arn:aws:kms:us-east-2:588966314750:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  readerRoleArn: role,
  forbiddenBuckets: z.array(z.string().min(3).max(63)).min(1).max(100),
  forbiddenKmsKeyArns: z.array(z.string().min(20).max(180)).min(1).max(100),
}).strict().superRefine((c, ctx) => {
  if (c.forbiddenBuckets.includes(c.bucket) || c.forbiddenKmsKeyArns.includes(c.kmsKeyArn)) ctx.addIssue({ code: 'custom', message: 'learner_media_storage_forbidden' });
});
export type LearnerMediaStorageConfig = z.infer<typeof learnerMediaStorageConfig>;

const EXTENSIONS: Record<LearnerMediaObject['contentType'], string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const hexOfBase64 = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, 'base64').toString('hex') : null;

/** The session policy for one object: nothing else is readable with the credentials it produces. */
export function learnerMediaSessionPolicy(config: LearnerMediaStorageConfig, objectKey: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: `arn:aws:s3:::${config.bucket}/${objectKey}` },
      { Effect: 'Allow', Action: ['kms:Decrypt'], Resource: config.kmsKeyArn },
    ],
  });
}

export function createAwsLearnerMediaStorage(input: {
  config: LearnerMediaStorageConfig;
  sts?: Pick<STSClient, 'send'>;
  s3For?: (credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }) => S3Client;
}): LearnerMediaStorage {
  const config = learnerMediaStorageConfig.parse(input.config);
  const sts = input.sts ?? new STSClient({ region: config.region, maxAttempts: 1 });
  const s3For = input.s3For ?? (credentials => new S3Client({ region: config.region, credentials, maxAttempts: 1, followRegionRedirects: false }));
  const fail = () => new LearnerMediaError('service_unavailable');
  return {
    async issue(object: LearnerMediaObject, signal: AbortSignal, assertLive: () => void) {
      const live = () => { if (signal.aborted) throw fail(); assertLive(); };
      const extension = EXTENSIONS[object.contentType];
      const key = `program-media/${object.clinic}/${object.programId}/${object.artifactId}/${object.sha256}.${extension}`;
      if (!extension || object.objectKey !== key || !object.objectVersion || object.objectVersion === 'null' || object.objectVersion.length > 1024
        || !/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 1) throw fail();
      live();
      let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
      try {
        const out = await sts.send(new AssumeRoleCommand({
          RoleArn: config.readerRoleArn, RoleSessionName: 'learner-media-' + randomBytes(8).toString('hex'), DurationSeconds: 900,
          Policy: learnerMediaSessionPolicy(config, key),
        }), { abortSignal: signal });
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !(c.Expiration instanceof Date) || c.Expiration.getTime() < Date.now() + 360_000) throw fail();
        credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
      } catch { throw fail(); }
      live();
      const s3 = s3For(credentials);
      try {
        let head: HeadObjectCommandOutput;
        try {
          head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, ExpectedBucketOwner: config.expectedBucketOwner, Key: key, VersionId: object.objectVersion, ChecksumMode: 'ENABLED' }), { abortSignal: signal });
        } catch { throw fail(); }
        live();
        const metadata = (head.Metadata ?? {}) as Record<string, string>;
        const composite = head.ChecksumType === 'COMPOSITE';
        const whole = composite ? metadata['whole-sha256'] : hexOfBase64(head.ChecksumSHA256);
        if (head.VersionId !== object.objectVersion || head.DeleteMarker === true || head.ContentLength !== object.bytes || head.ContentType !== object.contentType
          || head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== config.kmsKeyArn
          || (!composite && head.ChecksumType !== 'FULL_OBJECT') || whole !== object.sha256
          || metadata['artifact-id'] !== object.artifactId || metadata['program-id'] !== object.programId || metadata.clinic !== object.clinic
          || metadata.purpose !== 'educational_media') throw fail();
        const signed = await issueAwsProgramMediaVersionPreview({ s3, bucket: config.bucket, objectKey: key, objectVersion: object.objectVersion, contentType: object.contentType, signal, assertLive: live });
        live();
        return { url: signed.token, expiresAt: signed.until };
      } catch (error) { throw error instanceof LearnerMediaError ? error : fail(); }
      finally { s3.destroy(); }
    },
  };
}
