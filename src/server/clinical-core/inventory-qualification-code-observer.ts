if (typeof window !== 'undefined') throw Error('inventory qualification code observation is server-only');
import { createHash } from 'node:crypto';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { inventoryRecord, inventoryRefuse } from './inventory-qualification-artifacts';
import type { InventoryCodeObject } from './inventory-qualification-target';

type Transport = { send(command: GetObjectCommand, options: { abortSignal: AbortSignal }): Promise<unknown>; destroy(): void };
type Body = AsyncIterable<unknown> & { destroy(): void };
function actualClient(): Transport {
  const client = new S3Client({ region: 'us-east-2', credentials: fromIni({ profile: 'ai-synthetic-member' }), maxAttempts: 1,
    followRegionRedirects: false, endpoint: 'https://s3.us-east-2.amazonaws.com', forcePathStyle: true });
  return { send: (command, options) => client.send(command, options), destroy: () => client.destroy() };
}
function body(value: unknown): Body {
  if (!value || typeof value !== 'object' || !(Symbol.asyncIterator in value) || typeof value[Symbol.asyncIterator] !== 'function'
    || !('destroy' in value) || typeof value.destroy !== 'function') return inventoryRefuse('inventory_code_body_refused');
  return value as Body;
}
async function nextChunk(iterator: AsyncIterator<unknown>, signal: AbortSignal): Promise<IteratorResult<unknown>> {
  if (signal.aborted) return inventoryRefuse('inventory_code_timeout');
  let rejectAbort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(Error('inventory_code_timeout')); signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([iterator.next(), expired]); }
  finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); }
}

/** One immutable version, one attempt, bounded streaming. This never relies on
 * an ETag or manifest-only checksum, never buffers the full object, never follows
 * a caller URL, and never reads a clinical-data object or provider credential.
 * It proves uploaded artifact bytes only, not Lambda deployment or acceptance. */
export async function observeInventoryCodeVersion(supplied: InventoryCodeObject, sourceCommit: string, candidate: string,
  makeClient: () => Transport = actualClient, deadlineMs = 30000) {
  const code = structuredClone(supplied);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-z][a-z-]+$/.test(candidate)
    || !/^[a-z][a-z0-9-]*\.zip$/.test(code.file) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(code.bucket)
    || /\.\.|^\d+\.\d+\.\d+\.\d+$/.test(code.bucket)
    || code.key !== `inventory-qualification/${sourceCommit}/${candidate}/${code.file}`
    || !/^(?!null$)(?!latest$)[A-Za-z0-9+/._=-]{1,1024}$/.test(code.versionId) || !/^[a-f0-9]{64}$/.test(code.sha256)
    || !Number.isSafeInteger(code.bytes) || code.bytes < 1 || code.bytes > 46 * 1024 * 1024
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) return inventoryRefuse('inventory_code_target_refused');
  const client = makeClient(), abort = new AbortController(), timer = setTimeout(() => abort.abort(), deadlineMs);
  let stream: Body | undefined, closeBody: (() => void) | undefined;
  try {
    const output = await client.send(new GetObjectCommand({ Bucket: code.bucket, Key: code.key,
      VersionId: code.versionId, ExpectedBucketOwner: '588966314750' }), { abortSignal: abort.signal });
    // Capture the body before rejecting headers, so refusal still closes it.
    if (inventoryRecord(output) && output.Body !== undefined) {
      const raw = output.Body;
      if (raw && typeof raw === 'object' && 'destroy' in raw && typeof raw.destroy === 'function') {
        const destroy = raw.destroy; closeBody = () => { destroy.call(raw); };
      }
      stream = body(raw);
    }
    if (!inventoryRecord(output) || output.ContentLength !== code.bytes || output.VersionId !== code.versionId
      || output.DeleteMarker === true || output.ContentRange !== undefined || !stream) return inventoryRefuse('inventory_code_metadata_refused');
    const iterator = stream[Symbol.asyncIterator](), digest = createHash('sha256'); let received = 0, chunks = 0;
    for (;;) {
      const next = await nextChunk(iterator, abort.signal); if (next.done) break;
      if (!(next.value instanceof Uint8Array) || !next.value.byteLength || ++chunks > 1024 * 1024) return inventoryRefuse('inventory_code_body_refused');
      if (next.value.byteLength > code.bytes - received) return inventoryRefuse('inventory_code_size_refused');
      received += next.value.byteLength; digest.update(next.value);
    }
    if (abort.signal.aborted) return inventoryRefuse('inventory_code_timeout');
    if (received !== code.bytes) return inventoryRefuse('inventory_code_size_refused');
    if (digest.digest('hex') !== code.sha256) return inventoryRefuse('inventory_code_digest_refused');
    return { contract: 'inventory-qualification-code-version-observation/1', uploadedVersionVerified: true,
      candidate, file: code.file, bucket: code.bucket, key: code.key, versionId: code.versionId, sha256: code.sha256, bytes: received,
      acceptance: false, lambdaDeploymentVerified: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
  } finally {
    clearTimeout(timer); abort.abort();
    try { closeBody?.(); } finally { client.destroy(); }
  }
}
