/** Read actual response bytes under a hard limit. Never fall back to text(),
 * which materializes an unbounded body before a subsequent size check. */
export async function boundedProviderJson(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  const refuse = () => new Error('provider_body_refused');
  if (!Number.isSafeInteger(limit) || limit < 1 || !response.body) throw refuse();
  const rawLength = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  const rejectBeforeRead = async () => {
    try { await response.body?.cancel(); } catch { /* refusal retained */ }
    throw refuse();
  };
  if (signal?.aborted) return rejectBeforeRead();
  let declared: number | null = null;
  if (rawLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(rawLength)) return rejectBeforeRead();
    declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared > limit) return rejectBeforeRead();
  }
  // Fetch decodes compressed bodies; their wire length is not their decoded
  // length. Both the declared wire size and actual decoded bytes stay bounded.
  const compareLength = !encoding || encoding.toLowerCase() === 'identity';
  const reader = response.body.getReader();
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = signal ? new Promise<never>((_resolve, reject) => { rejectAbort = reject; }) : null;
  const abort = () => {
    rejectAbort?.(refuse());
    // Cancel the locked reader, not response.body. Do not wait for another
    // provider chunk, and do not interpret cancellation as remote deletion.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let text = '';
  let completed = false;
  try {
    for (;;) {
      if (signal?.aborted) throw refuse();
      const next = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (signal?.aborted) throw refuse();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw refuse();
      received += next.value.byteLength;
      if (received > limit || compareLength && declared !== null && received > declared) throw refuse();
      text += decoder.decode(next.value, { stream: true });
    }
    if (compareLength && declared !== null && received !== declared) throw refuse();
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    completed = true;
    return value;
  } catch {
    throw refuse();
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!completed) {
      // Cancellation failure must not turn a refused body into success.
      try { if (!signal?.aborted) await reader.cancel(); } catch { /* original refusal retained */ }
    }
    try { reader.releaseLock(); } catch { /* pending transport read cannot authorize success */ }
  }
}
