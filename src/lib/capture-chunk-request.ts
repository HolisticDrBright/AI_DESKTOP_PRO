/** Bound one transport attempt; cancellation is NOT proof of a remote rollback.
 * The caller owns the buffer and must retain an unacknowledged chunk on failure.
 * Retry deduplication/receipt reconciliation remains a separate server contract.
 */
export const CAPTURE_CHUNK_TIMEOUT_MS = 8_000;

export async function requestCaptureChunk(
  init: RequestInit & { signal: AbortSignal },
  transport: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const owner = init.signal;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    rejectAbort(new DOMException("Capture upload interrupted.", "AbortError"));
    controller.abort();
  };
  const timer = setTimeout(cancel, CAPTURE_CHUNK_TIMEOUT_MS);
  owner.addEventListener("abort", cancel, { once: true });
  try {
    if (owner.aborted) {
      // Do not create a transport or an unhandled rejected promise.
      throw new DOMException("Capture upload interrupted.", "AbortError");
    }
    return await Promise.race([
      transport("/api/live/scribe/chunk", { ...init, signal: controller.signal }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    owner.removeEventListener("abort", cancel);
  }
}
