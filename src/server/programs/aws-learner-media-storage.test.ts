import { describe, expect, it, vi } from 'vitest';
import { S3Client, HeadObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { createAwsLearnerMediaStorage, learnerMediaSessionPolicy, learnerMediaStorageConfig, type LearnerMediaStorageConfig } from './aws-learner-media-storage';
import { LearnerMediaError, type LearnerMediaObject } from './learner-media';

/**
 * The AWS learner media reader with its two provider calls answered by strict fictional transports:
 * STS (one scoped session) and S3 HEAD (the exact version's metadata). Signing is the real SDK
 * presigner, which is local computation. No network, account or credential is used.
 */
const id = (n: number) => '7e000000-0000-4000-8000-' + String(n).padStart(12, '0');
const sha = 'd'.repeat(64);
const config: LearnerMediaStorageConfig = {
  bucket: 'alp-fictional-lessons', expectedBucketOwner: '588966314750', region: 'us-east-2',
  kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/7e000000-0000-4000-8000-000000000090',
  readerRoleArn: 'arn:aws:iam::588966314750:role/alp-fictional-lesson-reader',
  forbiddenBuckets: ['alp-fictional-recordings'], forbiddenKmsKeyArns: ['arn:aws:kms:us-east-2:588966314750:key/7e000000-0000-4000-8000-000000000091'],
};
const object: LearnerMediaObject = { objectKey: `program-media/${id(1)}/${id(2)}/${id(3)}/${sha}.mp4`, objectVersion: 'fictional-object-version-7', contentType: 'video/mp4', bytes: 2048, sha256: sha, clinic: id(1), programId: id(2), artifactId: id(3) };
const head = (over: Record<string, unknown> = {}) => ({ VersionId: object.objectVersion, ContentLength: 2048, ContentType: 'video/mp4', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.kmsKeyArn,
  ChecksumType: 'FULL_OBJECT', ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64'), Metadata: { 'artifact-id': id(3), 'program-id': id(2), clinic: id(1), purpose: 'educational_media' }, $metadata: {}, ...over });
function harness(answer: (command: unknown) => unknown = () => head(), credentials: Record<string, unknown> = {}) {
  const assumed: AssumeRoleCommand[] = [], heads: HeadObjectCommand[] = [];
  const sts = { send: vi.fn(async (command: AssumeRoleCommand) => { assumed.push(command); return { Credentials: { AccessKeyId: 'ASIAFICTIONALREADER0', SecretAccessKey: 'fictional-secret-not-a-credential', SessionToken: 'fictional-session-token', Expiration: new Date(Date.now() + 900_000), ...credentials } }; }) };
  const clients: S3Client[] = [];
  const s3For = (c: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }) => {
    const client = new S3Client({ region: 'us-east-2', credentials: c, maxAttempts: 1 });
    vi.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
      if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected provider command');
      heads.push(command);
      const out = answer(command);
      if (out instanceof Error) throw out;
      return out as never;
    });
    clients.push(client);
    return client;
  };
  return { storage: createAwsLearnerMediaStorage({ config, sts: sts as never, s3For }), assumed, heads, clients };
}
const issue = (h: ReturnType<typeof harness>, o: LearnerMediaObject = object, signal = new AbortController().signal, live = () => undefined) => h.storage.issue(o, signal, live);

describe('AWS learner media reader', () => {
  it('assumes the reader role scoped to exactly one object, reads the exact version, and signs only that version for five minutes', async () => {
    const h = harness();
    const out = await issue(h);
    expect(h.assumed).toHaveLength(1);
    const input = h.assumed[0]!.input;
    expect(input.RoleArn).toBe(config.readerRoleArn);
    expect(input.DurationSeconds).toBe(900);
    expect(JSON.parse(input.Policy!)).toEqual({ Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: `arn:aws:s3:::alp-fictional-lessons/${object.objectKey}` },
      { Effect: 'Allow', Action: ['kms:Decrypt'], Resource: config.kmsKeyArn },
    ] });
    expect(h.heads[0]!.input).toEqual({ Bucket: 'alp-fictional-lessons', ExpectedBucketOwner: '588966314750', Key: object.objectKey, VersionId: object.objectVersion, ChecksumMode: 'ENABLED' });
    const url = new URL(out.url);
    expect(url.hostname).toBe('alp-fictional-lessons.s3.us-east-2.amazonaws.com');
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(object.objectKey);
    expect(url.searchParams.get('versionId')).toBe(object.objectVersion);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIAFICTIONALREADER0\//);
    expect(Date.parse(out.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(learnerMediaSessionPolicy(config, object.objectKey)).not.toContain('*');
  });
  it('accepts a composite multipart object only with the whole-file digest its commit recorded', async () => {
    const composite = { ChecksumType: 'COMPOSITE', ChecksumSHA256: 'AAAA-3', Metadata: { ...head().Metadata, 'writer-claim-id': id(9), 'whole-sha256': sha } };
    await expect(issue(harness(() => head(composite)))).resolves.toMatchObject({ url: expect.any(String) });
    await expect(issue(harness(() => head({ ...composite, Metadata: { ...composite.Metadata, 'whole-sha256': 'e'.repeat(64) } })))).rejects.toBeInstanceOf(LearnerMediaError);
  });
  it('refuses every mismatch between the object and the admitted identity, and issues nothing', async () => {
    const mismatches: Record<string, Record<string, unknown>> = {
      'another version': { VersionId: 'another-version' }, 'a delete marker': { DeleteMarker: true }, 'oversized bytes': { ContentLength: 4096 }, 'truncated bytes': { ContentLength: 10 },
      'another type': { ContentType: 'text/html' }, 'unencrypted': { ServerSideEncryption: 'AES256' }, 'another key': { SSEKMSKeyId: config.forbiddenKmsKeyArns[0] },
      'corrupt bytes': { ChecksumSHA256: Buffer.from('e'.repeat(64), 'hex').toString('base64') }, 'no checksum': { ChecksumSHA256: undefined, ChecksumType: undefined },
      'another clinic': { Metadata: { ...head().Metadata, clinic: id(8) } }, 'another purpose': { Metadata: { ...head().Metadata, purpose: 'recording' } },
    };
    for (const [label, over] of Object.entries(mismatches)) {
      await expect(issue(harness(() => head(over))), label).rejects.toMatchObject({ category: 'service_unavailable' });
    }
  });
  it('treats a missing object, a provider error, an STS failure and short-lived credentials as an outage', async () => {
    const missing = new S3ServiceException({ name: 'NotFound', $fault: 'client', $metadata: { httpStatusCode: 404 }, message: 'Not Found' });
    await expect(issue(harness(() => missing))).rejects.toMatchObject({ category: 'service_unavailable' });
    await expect(issue(harness(() => new Error('socket hang up')))).rejects.toMatchObject({ category: 'service_unavailable' });
    await expect(issue(harness(undefined, { Expiration: new Date(Date.now() + 60_000) }))).rejects.toMatchObject({ category: 'service_unavailable' });
    await expect(issue(harness(undefined, { SessionToken: undefined }))).rejects.toMatchObject({ category: 'service_unavailable' });
    const h = harness();
    h.storage.issue = createAwsLearnerMediaStorage({ config, sts: { send: async () => { throw new Error('AccessDenied'); } } as never, s3For: () => { throw new Error('never built'); } }).issue;
    await expect(issue(h)).rejects.toMatchObject({ category: 'service_unavailable' });
  });
  it('refuses an object key that is not the identity\'s own, before any provider call', async () => {
    const h = harness();
    for (const o of [{ ...object, objectKey: `program-media/${id(1)}/${id(2)}/${id(4)}/${sha}.mp4` }, { ...object, contentType: 'video/webm' as const }, { ...object, objectVersion: 'null' }, { ...object, clinic: id(8) }]) {
      await expect(issue(h, o)).rejects.toMatchObject({ category: 'service_unavailable' });
    }
    expect(h.assumed).toHaveLength(0);
  });
  it('stops at withdrawal: an aborted read or a lapsed session issues nothing', async () => {
    const controller = new AbortController();
    const h = harness(() => { controller.abort(); return head(); });
    await expect(issue(h, object, controller.signal)).rejects.toMatchObject({ category: 'service_unavailable' });
    let calls = 0;
    await expect(issue(harness(), object, new AbortController().signal, () => { calls += 1; if (calls > 1) throw new LearnerMediaError('identity_refused'); })).rejects.toBeInstanceOf(LearnerMediaError);
  });
  it('refuses a configuration that names a recording bucket or key, an author role, or another account', () => {
    expect(learnerMediaStorageConfig.safeParse({ ...config, bucket: 'alp-fictional-recordings' }).success).toBe(false);
    expect(learnerMediaStorageConfig.safeParse({ ...config, kmsKeyArn: config.forbiddenKmsKeyArns[0] }).success).toBe(false);
    expect(learnerMediaStorageConfig.safeParse({ ...config, readerRoleArn: 'arn:aws:iam::588966314750:role/alp-media-author-upload' }).success).toBe(false);
    expect(learnerMediaStorageConfig.safeParse({ ...config, readerRoleArn: 'arn:aws:iam::111111111111:role/alp-fictional-lesson-reader' }).success).toBe(false);
    expect(learnerMediaStorageConfig.safeParse({ ...config, expectedBucketOwner: '111111111111' }).success).toBe(false);
  });
});
