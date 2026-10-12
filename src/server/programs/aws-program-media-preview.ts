if (typeof window !== 'undefined') throw new Error('program media preview signer is server-only');
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH } from '@/contracts/programMedia';
import { ProgramMediaError } from './program-media-authoring';

/** Sign only AFTER the caller's exact-version integrity check. This shared
 * issuer does not authorize an author or learner, accept browser destinations,
 * certify bytes or expose a write. Its short-lived bearer URL is never a
 * publication reference and must not enter logs or persistent curriculum. */
export async function issueAwsProgramMediaVersionPreview(input: {
  s3: S3Client; bucket: string; objectKey: string; objectVersion: string; contentType: string;
  signal: AbortSignal; assertLive(): void;
}) {
  const { s3, bucket, objectKey, objectVersion, contentType, signal, assertLive } = input;
  const fail = () => new ProgramMediaError('service_unavailable');
  const live = () => { assertLive(); if (signal.aborted) throw fail(); };
  let abort: (() => void) | undefined;
  try {
    live();
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !objectKey.startsWith('program-media/')
      || objectKey.length > 512 || !objectVersion || objectVersion === 'null' || objectVersion.length > 1024
      || !['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw fail();
    const issued = new Date();
    const signed = getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, ExpectedBucketOwner: '588966314750', Key: objectKey,
      VersionId: objectVersion, ResponseCacheControl: 'private, no-store', ResponseContentType: contentType }), { expiresIn: 300, signingDate: issued });
    // Even an ignored signing/credential await stops returning at withdrawal.
    // The raced promise remains observed; no remote mutation is admitted here.
    const token = await Promise.race([signed.then(value => { live(); return value; }), new Promise<never>((_resolve, reject) => {
      abort = () => reject(fail()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    })]);
    live();
    if (typeof token !== 'string' || token.length > PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH) throw fail();
    const url = new URL(token), query = url.searchParams;
    const one = (key: string, expected: string) => query.getAll(key).length === 1 && query.get(key) === expected;
    if (url.protocol !== 'https:' || url.hostname !== `${bucket}.s3.us-east-2.amazonaws.com` || url.port
      || url.username || url.password || url.hash || decodeURIComponent(url.pathname.slice(1)) !== objectKey
      || !one('versionId', objectVersion) || !one('X-Amz-Expires', '300') || !one('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
      || !one('X-Amz-Date', issued.toISOString().replace(/[-:]|\.\d{3}/g, ''))
      || !one('response-cache-control', 'private, no-store') || !one('response-content-type', contentType)
      || query.getAll('X-Amz-Signature').length !== 1 || !/^[a-f0-9]{64}$/.test(query.get('X-Amz-Signature') ?? '')) throw fail();
    return { token, until: new Date(issued.getTime() + 300_000).toISOString() };
  } catch { throw fail(); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}
