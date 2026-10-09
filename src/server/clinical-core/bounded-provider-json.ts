/** Read actual response bytes under a hard limit. Never fall back to text(),
 * which materializes an unbounded body before a subsequent size check. */
export async function boundedProviderJson(response: Response, limit: number): Promise<unknown> {
  const refuse = () => new Error('provider_body_refused');
  if (!Number.isSafeInteger(limit) || limit < 1 || !response.body) throw refuse();
  const rawLength = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  const rejectBeforeRead = async () => {
    try { await response.body?.cancel(); } catch { /* refusal retained */ }
    throw refuse();
  };
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
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let text = '';
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
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
    if (!completed) {
      // Cancellation failure must not turn a refused body into success.
      try { await reader.cancel(); } catch { /* original refusal retained */ }
    }
    reader.releaseLock();
  }
}
