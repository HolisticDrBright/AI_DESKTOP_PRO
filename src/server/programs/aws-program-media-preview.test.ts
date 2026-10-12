import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { programMediaPreview, PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH } from '@/contracts/programMedia';
import { issueAwsProgramMediaVersionPreview } from './aws-program-media-preview';

vi.mock('@aws-sdk/s3-request-presigner', async load => {
  const actual = await load<typeof import('@aws-sdk/s3-request-presigner')>();
  return { ...actual, getSignedUrl: vi.fn(actual.getSignedUrl) };
});
const NOW = new Date('2026-10-11T22:00:00Z'), bucket = 'alp-fictional-program-media-preview';
const id = '81000000-0000-4000-8000-000000000001', objectKey = `program-media/${id}/${id}/${id}/${'a'.repeat(64)}.mp4`;
let client: S3Client;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  client = new S3Client({ region: 'us-east-2', endpoint: 'https://s3.us-east-2.amazonaws.com', maxAttempts: 1,
    credentials: { accessKeyId: 'ASIA' + 'F'.repeat(16), secretAccessKey: 'F'.repeat(40), sessionToken: '+/='.repeat(1000) } });
});
afterEach(() => { client.destroy(); vi.mocked(getSignedUrl).mockClear(); vi.useRealTimers(); });
const inputs = () => ({ s3: client, bucket, objectKey, objectVersion: 'fictional-exact-version', contentType: 'video/mp4',
  signal: new AbortController().signal, assertLive: vi.fn() });
const read = () => issueAwsProgramMediaVersionPreview(inputs());

describe('bounded exact-version preview signing with the actual SDK and no network', () => {
  it('admits a real signed URL with the maximum configured, URL-encoded temporary token', async () => {
    const out = await read(); expect(out.token.length).toBeGreaterThan(9000); expect(out.token.length).toBeLessThan(PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH);
    const url = new URL(out.token); expect(url.searchParams.get('versionId')).toBe('fictional-exact-version');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300'); expect(out.until).toBe('2026-10-11T22:05:00.000Z');
    expect(programMediaPreview.safeParse({ artifactId: id, version: 1, state: 'ready', kind: 'video', contentType: 'video/mp4',
      bytes: 4, sha256: 'a'.repeat(64), previewToken: out.token, previewUntil: out.until, historical: false }).success).toBe(true);
  });
  it('keeps the wire capability bounded', async () => {
    const out = await read();
    expect(programMediaPreview.safeParse({ artifactId: id, version: 1, state: 'ready', kind: 'video', contentType: 'video/mp4', bytes: 4,
      sha256: 'a'.repeat(64), previewToken: 'x'.repeat(PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH + 1), previewUntil: out.until, historical: false }).success).toBe(false);
  });
  it.each(['host', 'scheme', 'port', 'path', 'version', 'duplicate version', 'fragment', 'expiry', 'algorithm', 'date', 'cache', 'type', 'signature', 'oversized'])
    ('refuses a signed-looking reply with changed %s', async kind => {
      const good = await read(), url = new URL(good.token);
      if (kind === 'host') url.hostname = 'unreviewed.example';
      if (kind === 'scheme') url.protocol = 'http:';
      if (kind === 'port') url.port = '444';
      if (kind === 'path') url.pathname = '/program-media/other.mp4';
      if (kind === 'version') url.searchParams.set('versionId', 'other');
      if (kind === 'duplicate version') url.searchParams.append('versionId', 'other');
      if (kind === 'fragment') url.hash = 'other';
      if (kind === 'expiry') url.searchParams.set('X-Amz-Expires', '301');
      if (kind === 'algorithm') url.searchParams.set('X-Amz-Algorithm', 'other');
      if (kind === 'date') url.searchParams.set('X-Amz-Date', '20260101T000000Z');
      if (kind === 'cache') url.searchParams.delete('response-cache-control');
      if (kind === 'type') url.searchParams.set('response-content-type', 'text/html');
      if (kind === 'signature') url.searchParams.delete('X-Amz-Signature');
      vi.mocked(getSignedUrl).mockResolvedValueOnce(kind === 'oversized' ? 'x'.repeat(PROGRAM_MEDIA_PREVIEW_MAX_TOKEN_LENGTH + 1) : url.toString());
      await expect(read()).rejects.toThrow('service_unavailable');
    });
  it('stops an ignored signing wait on withdrawal and observes its late rejection', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(getSignedUrl).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const i = inputs(), cancel = new AbortController(); i.signal = cancel.signal;
    const work = issueAwsProgramMediaVersionPreview(i); cancel.abort();
    await expect(work).rejects.toThrow('service_unavailable'); fail(new Error('fictional secret-bearing provider error'));
    await Promise.resolve();
  });
  it('does not sign before a live caller check', async () => {
    const i = inputs(); i.assertLive.mockImplementation(() => { throw new Error('refused'); });
    await expect(issueAwsProgramMediaVersionPreview(i)).rejects.toThrow('service_unavailable'); expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
