import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { inventorySha } from './inventory-qualification-artifacts';
import { observeInventoryCodeVersion } from './inventory-qualification-code-observer';
const commit = 'a'.repeat(40), candidate = 'personal-storage';
const bytes = Buffer.from('fictional deployment artifact, never clinical data');
const code = { file: 'deployment.zip', bucket: 'fictional-artifacts', key: `inventory-qualification/${commit}/${candidate}/deployment.zip`,
  versionId: 'fictional-version', sha256: inventorySha(bytes), bytes: bytes.length };
function fixture(options: { headers?: Record<string, unknown>; chunks?: unknown[] } = {}) {
  const stream = Readable.from(options.chunks ?? [bytes.subarray(0, 2), bytes.subarray(2)]), state = { calls: 0, destroyed: false, signal: undefined as AbortSignal | undefined };
  const makeClient = () => ({ send: async (command: GetObjectCommand, request: { abortSignal: AbortSignal }) => {
    state.calls++; state.signal = request.abortSignal; expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: code.bucket, Key: code.key, VersionId: code.versionId, ExpectedBucketOwner: '588966314750' });
    return { Body: stream, ContentLength: bytes.length, VersionId: code.versionId, ...options.headers };
  }, destroy: () => { state.destroyed = true; } });
  return { stream, state, makeClient };
}
it('reads exact versioned artifact bytes, pins bucket owner and keeps every broader claim false', async () => {
  const f = fixture(); const report = await observeInventoryCodeVersion(code, commit, candidate, f.makeClient);
  expect(report.uploadedVersionVerified).toBe(true); expect(report.bytes).toBe(bytes.length); expect(report.sha256).toBe(inventorySha(bytes));
  for (const key of ['acceptance', 'lambdaDeploymentVerified', 'humanReviewsVerified', 'phiAllowed', 'mutations'] as const) expect(report[key]).toBe(false);
  expect(f.state.calls).toBe(1); expect(f.stream.destroyed).toBe(true); expect(f.state.destroyed).toBe(true); expect(f.state.signal!.aborted).toBe(true);
});
describe('artifact stream refusal', () => {
  for (const [name, headers] of Object.entries({ missingLength: { ContentLength: undefined }, wrongLength: { ContentLength: bytes.length + 1 },
    wrongVersion: { VersionId: 'different-version' }, unversioned: { VersionId: 'null' }, deleted: { DeleteMarker: true }, partial: { ContentRange: 'bytes 0-1/2' } })) {
    it(name, async () => {
      const f = fixture({ headers }); await expect(observeInventoryCodeVersion(code, commit, candidate, f.makeClient)).rejects.toThrow();
      expect(f.stream.readableDidRead).toBe(false); expect(f.stream.destroyed).toBe(true); expect(f.state.destroyed).toBe(true);
    });
  }
  for (const [name, chunks] of Object.entries({ short: [bytes.subarray(0, -1)], overrun: [bytes, Buffer.from('extra')],
    longSingle: [Buffer.alloc(bytes.length + 1)], wrongBytes: [Buffer.alloc(bytes.length)], stringChunks: ['must not coerce'], empty: [Buffer.alloc(0)] })) {
    it(name, async () => {
      const f = fixture({ chunks }); await expect(observeInventoryCodeVersion(code, commit, candidate, f.makeClient)).rejects.toThrow();
      expect(f.stream.destroyed).toBe(true); expect(f.state.destroyed).toBe(true); expect(f.state.calls).toBe(1);
    });
  }
});
it('stalled body is bounded by the same operation deadline and its stream is destroyed', async () => {
  let destroyed = false, clientDestroyed = false;
  const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }), destroy: () => { destroyed = true; } };
  const makeClient = () => ({ send: async () => ({ Body: stream, ContentLength: bytes.length, VersionId: code.versionId }), destroy: () => { clientDestroyed = true; } });
  await expect(observeInventoryCodeVersion(code, commit, candidate, makeClient, 10)).rejects.toThrow('inventory_code_timeout');
  expect(destroyed).toBe(true); expect(clientDestroyed).toBe(true);
});
it('artifacts larger than the historical 16 MiB limit are streamed rather than buffered', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 7), count = 17;
  const large = { ...code, bytes: chunk.length * count, sha256: inventorySha(Buffer.alloc(chunk.length * count, 7)) };
  const stream = Readable.from(Array.from({ length: count }, () => chunk));
  const makeClient = () => ({ send: async () => ({ Body: stream, ContentLength: large.bytes, VersionId: code.versionId }), destroy: () => {} });
  await expect(observeInventoryCodeVersion(large, commit, candidate, makeClient)).resolves.toMatchObject({ bytes: large.bytes, uploadedVersionVerified: true, acceptance: false });
});
it('unsafe size, prefix, version, bucket or deadline is refused before making an AWS client', async () => {
  let made = 0; const makeClient = () => { made++; return fixture().makeClient(); };
  for (const change of [{ bytes: 0 }, { bytes: 46 * 1024 * 1024 + 1 }, { bytes: 1.1 }, { key: 'staging/deployment.zip' },
    { versionId: 'null' }, { versionId: 'latest' }, { bucket: '192.168.1.1' }, { bucket: 'bad..bucket' }]) {
    await expect(observeInventoryCodeVersion({ ...code, ...change }, commit, candidate, makeClient)).rejects.toThrow('inventory_code_target_refused');
  }
  await expect(observeInventoryCodeVersion(code, commit, candidate, makeClient, 30001)).rejects.toThrow('inventory_code_target_refused'); expect(made).toBe(0);
});
it('a malformed but closable response body is still closed before refusing it', async () => {
  let closed = false, destroyed = false;
  const makeClient = () => ({ send: async () => ({ Body: { destroy: () => { closed = true; } }, ContentLength: bytes.length, VersionId: code.versionId }), destroy: () => { destroyed = true; } });
  await expect(observeInventoryCodeVersion(code, commit, candidate, makeClient)).rejects.toThrow('inventory_code_body_refused');
  expect(closed).toBe(true); expect(destroyed).toBe(true);
});
it('a caller mutation after the request starts cannot replace the captured byte identity', async () => {
  const input = { ...code }, f = fixture();
  const makeClient = () => ({ send: async (command: GetObjectCommand, options: { abortSignal: AbortSignal }) => {
    input.sha256 = 'b'.repeat(64); input.bytes = 1; return f.makeClient().send(command, options);
  }, destroy: () => {} });
  await expect(observeInventoryCodeVersion(input, commit, candidate, makeClient)).resolves.toMatchObject({ sha256: code.sha256, bytes: bytes.length });
});
