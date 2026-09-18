export class BoundedBodyError extends Error {
  constructor(readonly reason: "invalid_length" | "too_large" | "empty" | "interrupted") {
    super(`request_body_${reason}`);
  }
}

/** Bound accumulation and waiting, including unknown-length/chunked requests.
 * Never forward a partial body. Cancelling the reader must not itself delay the
 * response (a hostile or broken stream may never settle its cancel promise).
 */
export async function readBoundedRequestBody(
  request: Pick<Request, "body" | "headers" | "signal">,
  maxBytes: number,
  timeoutMs: number,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("request_body_limits_invalid");
  }
  const length = request.headers.get("content-length");
  let declared: number | undefined;
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new BoundedBodyError("invalid_length");
    declared = Number(length);
    if (declared > maxBytes) throw new BoundedBodyError("too_large");
    if (declared === 0) throw new BoundedBodyError("empty");
  }
  if (request.signal.aborted) throw new BoundedBodyError("interrupted");
  if (!request.body) throw new BoundedBodyError("empty");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = request.body.getReader(); }
  catch { throw new BoundedBodyError("interrupted"); }
  let interrupt!: (error: BoundedBodyError) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  const onAbort = () => interrupt(new BoundedBodyError("interrupted"));
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let complete = false;
  let stopped = false;
  async function consume(): Promise<ArrayBuffer> {
    // A fixed allocation also bounds metadata overhead for one-byte fragments.
    const bytes = new Uint8Array(declared ?? maxBytes);
    let size = 0;
    for (;;) {
      // A synchronously producing stream can starve the timer's task queue.
      if (stopped || request.signal.aborted || Date.now() >= deadline) throw new BoundedBodyError("interrupted");
      const part = await reader.read();
      if (stopped || request.signal.aborted || Date.now() >= deadline) throw new BoundedBodyError("interrupted");
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new BoundedBodyError("interrupted");
      size += part.value.byteLength;
      if (size > maxBytes) throw new BoundedBodyError("too_large");
      if (declared !== undefined && size > declared) throw new BoundedBodyError("invalid_length");
      bytes.set(part.value, size - part.value.byteLength);
    }
    if (size === 0) throw new BoundedBodyError("empty");
    if (declared !== undefined && size !== declared) throw new BoundedBodyError("invalid_length");
    return bytes.buffer.slice(0, size);
  }
  try {
    // Race once for the entire body. Racing each fragment against the same
    // pending interruption promise retains one handler per fragment until EOF.
    const bytes = await Promise.race([consume(), interrupted]);
    complete = true;
    return bytes;
  } catch (error) {
    if (error instanceof BoundedBodyError) throw error;
    // A body stream error is untrusted; never surface its payload or message.
    throw new BoundedBodyError("interrupted");
  } finally {
    stopped = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* pending read can finish after cancellation */ }
  }
}
