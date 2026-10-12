import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { programMediaCompositeChecksum } from './program-media-parts';

// Actual serializer, signer, retry and checksum middleware. HTTP is a local
// function returning fictional responses, not an AWS endpoint or provider test.
const body = Buffer.from('ALP!'), sha256 = createHash('sha256').update(body).digest('hex');
const checksum = Buffer.from(sha256, 'hex').toString('base64');
const composite = programMediaCompositeChecksum({ totalBytes: body.length, parts: [{ partNumber: 1, bytes: body.length, sha256 }] });
const base = { Bucket: 'alp-fictional-multipart-sdk', Key: 'program-media/fictional.mp4', ExpectedBucketOwner: '588966314750' };
const credentials = { accessKeyId: 'ASIA' + 'F'.repeat(16), secretAccessKey: 'F'.repeat(40), sessionToken: 'fictional-test-session' };
const xml = (text: string, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/xml' }, body: Buffer.from(text) } });

describe('actual multipart SDK middleware with fictional HTTP only', () => {
  it.each(['creation', 'part', 'completion'])('keeps %s single-attempt after a retryable server failure', async stage => {
    let calls = 0;
    const sdk = new S3Client({ region: 'us-east-2', credentials, maxAttempts: 1,
      requestHandler: { handle: async () => { calls++; return xml('<Error><Code>InternalError</Code><Message>Fictional lost outcome</Message></Error>', 500); } } });
    const send = () => stage === 'creation' ? sdk.send(new CreateMultipartUploadCommand({ ...base, ChecksumAlgorithm: 'SHA256', ChecksumType: 'COMPOSITE' }))
      : stage === 'part' ? sdk.send(new UploadPartCommand({ ...base, UploadId: 'fictional-upload', PartNumber: 1, Body: body, ContentLength: body.length, ChecksumSHA256: checksum }))
        : sdk.send(new CompleteMultipartUploadCommand({ ...base, UploadId: 'fictional-upload', IfNoneMatch: '*',
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"fictional-part"', ChecksumSHA256: checksum }] } }));
    try { await expect(send()).rejects.toThrow(); expect(calls).toBe(1); } finally { sdk.destroy(); }
  });
  it('rejects the embedded error in a 200 completion response without retrying', async () => {
    let calls = 0;
    const sdk = new S3Client({ region: 'us-east-2', credentials, maxAttempts: 1,
      requestHandler: { handle: async () => { calls++; return xml('<Error><Code>InternalError</Code><Message>Fictional embedded failure</Message></Error>'); } } });
    try {
      await expect(sdk.send(new CompleteMultipartUploadCommand({ ...base, UploadId: 'fictional-upload', IfNoneMatch: '*',
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"fictional-part"', ChecksumSHA256: checksum }] } }))).rejects.toThrow();
      expect(calls).toBe(1);
    } finally { sdk.destroy(); }
  });
  it('reads a composite-checksummed response without confusing it with whole-file SHA256', async () => {
    const sdk = new S3Client({ region: 'us-east-2', credentials, maxAttempts: 1,
      requestHandler: { handle: async () => ({ response: { statusCode: 200, headers: {
        'content-length': String(body.length), 'content-type': 'video/mp4', 'x-amz-version-id': 'fictional-version',
        'x-amz-checksum-sha256': composite, 'x-amz-checksum-type': 'COMPOSITE',
      }, body: Readable.from([body.subarray(0, 2), body.subarray(2)]) } }) } });
    try {
      const out = await sdk.send(new GetObjectCommand({ ...base, VersionId: 'fictional-version', ChecksumMode: 'ENABLED' }));
      expect(out.ChecksumSHA256).toBe(composite); expect(out.ChecksumType).toBe('COMPOSITE');
      expect(composite).not.toBe(checksum);
      const whole = createHash('sha256'); let received = 0;
      for await (const chunk of out.Body as Readable) { whole.update(chunk); received += chunk.length; }
      expect(received).toBe(body.length); expect(whole.digest('hex')).toBe(sha256);
    } finally { sdk.destroy(); }
  });
  it('serializes the exact measured part checksum and create-only completion headers', async () => {
    const requests: { headers: Record<string, string>; body?: unknown }[] = [];
    const sdk = new S3Client({ region: 'us-east-2', credentials, maxAttempts: 1,
      requestHandler: { handle: async (request: { method: string; headers: Record<string, string>; body?: unknown }) => {
        requests.push({ headers: request.headers, body: request.body });
        return request.method === 'PUT' ? { response: { statusCode: 200, headers: { etag: '"fictional-part"', 'x-amz-checksum-sha256': checksum }, body: Buffer.alloc(0) } }
          : xml(`<CompleteMultipartUploadResult><Bucket>${base.Bucket}</Bucket><Key>${base.Key}</Key><ETag>"fictional-whole"</ETag><ChecksumSHA256>${composite}</ChecksumSHA256><ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>`);
      } } });
    try {
      await sdk.send(new UploadPartCommand({ ...base, UploadId: 'fictional-upload', PartNumber: 1, Body: body,
        ContentLength: body.length, ChecksumAlgorithm: 'SHA256', ChecksumSHA256: checksum }));
      await sdk.send(new CompleteMultipartUploadCommand({ ...base, UploadId: 'fictional-upload', IfNoneMatch: '*',
        ChecksumType: 'COMPOSITE', ChecksumSHA256: composite, MpuObjectSize: body.length,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"fictional-part"', ChecksumSHA256: checksum }] } }));
      expect(requests).toHaveLength(2);
      expect(requests[0].headers).toMatchObject({ 'x-amz-checksum-sha256': checksum, 'content-length': String(body.length), 'x-amz-expected-bucket-owner': base.ExpectedBucketOwner });
      expect(requests[1].headers).toMatchObject({ 'if-none-match': '*', 'x-amz-checksum-sha256': composite,
        'x-amz-checksum-type': 'COMPOSITE', 'x-amz-mp-object-size': String(body.length) });
      expect(String(requests[1].body)).toContain(`<ChecksumSHA256>${checksum}</ChecksumSHA256>`);
    } finally { sdk.destroy(); }
  });
});
