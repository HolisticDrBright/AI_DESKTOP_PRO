import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_CHUNK_TIMEOUT_MS, requestCaptureChunk } from "./capture-chunk-request";
import { CaptureUploadBuffer } from "./capture-upload-buffer";

afterEach(() => vi.useRealTimers());

describe("bounded capture upload attempts", () => {
  it("bounds a transport that never returns, retaining the exact buffered audio", async () => {
    vi.useFakeTimers();
    const queue = new CaptureUploadBuffer("recording", "session");
    const chunk = new Blob(["fictional audio"]);
    queue.enqueue(chunk);
    let requestSignal!: AbortSignal;
    const transport = vi.fn<typeof fetch>((_, init) => {
      requestSignal = init!.signal!;
      return new Promise(() => {}); // Includes transports that ignore abort.
    });
    const pending = requestCaptureChunk({ method: "POST", body: chunk, signal: queue.signal }, transport);
    const refused = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(CAPTURE_CHUNK_TIMEOUT_MS);
    await refused;
    expect(requestSignal.aborted).toBe(true);
    expect(queue.signal.aborted).toBe(false);
    expect(queue.head).toBe(chunk);
    expect(queue.length).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1); // Helper does not retry/acknowledge.
    expect(vi.getTimerCount()).toBe(0);
    const receipt = await requestCaptureChunk({ signal: queue.signal, body: queue.head },
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })));
    expect(receipt.ok).toBe(true);
    expect(queue.head).toBe(chunk); // Only the owning pump can acknowledge it.
  });

  it("cancels promptly when the recording owner is invalidated", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    let signal!: AbortSignal;
    const pending = requestCaptureChunk({ signal: owner.signal }, vi.fn<typeof fetch>((_, init) => {
      signal = init!.signal!;
      return new Promise(() => {});
    }));
    const refused = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    owner.abort();
    await refused;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send a request for a cancelled owner", async () => {
    vi.useFakeTimers();
    const owner = new AbortController(); owner.abort();
    const transport = vi.fn<typeof fetch>();
    await expect(requestCaptureChunk({ signal: owner.signal }, transport)).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 409, 503])("preserves HTTP %i and releases its timer/listener", async status => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, "removeEventListener");
    const response = new Response(null, { status });
    expect(await requestCaptureChunk({ signal: owner.signal }, vi.fn<typeof fetch>().mockResolvedValue(response))).toBe(response);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cannot turn a late transport success into an acknowledged upload", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const pending = requestCaptureChunk({ signal: new AbortController().signal }, vi.fn<typeof fetch>(() =>
      new Promise(resolve => { finish = resolve; })));
    const refused = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(CAPTURE_CHUNK_TIMEOUT_MS);
    await refused;
    finish(new Response(null, { status: 200 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
