import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedRequestBody } from "./bounded-request-body";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function request(parts: number[][], length?: string, controller = new AbortController()) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn((stream: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>) => {
    if (index < parts.length) stream.enqueue(new Uint8Array(parts[index++])); else stream.close();
  });
  return { body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
    headers: new Headers(length === undefined ? {} : { "content-length": length }), signal: controller.signal, pull, cancel };
}

describe("bounded binary request reads", () => {
  it.each([undefined, "4"])("retains exact bytes and accepts the limit with length %s", async length => {
    const req = request([[1, 2], [], [3, 4]], length);
    expect([...new Uint8Array(await readBoundedRequestBody(req, 4, 1000))]).toEqual([1, 2, 3, 4]);
    expect(req.cancel).not.toHaveBeenCalled();
  });
  it("rejects declared oversize without reading", async () => {
    const req = request([[1]], "5");
    await expect(readBoundedRequestBody(req, 4, 1000)).rejects.toMatchObject({ reason: "too_large" });
    expect(req.pull).not.toHaveBeenCalled();
  });
  it("uses one cancellation race for arbitrarily fragmented bytes", async () => {
    const race = vi.spyOn(Promise, "race");
    const req = request(Array.from({ length: 4096 }, (_, i) => [i % 256]));
    const result = new Uint8Array(await readBoundedRequestBody(req, 4096, 1000));
    expect(result).toEqual(Uint8Array.from({ length: 4096 }, (_, i) => i % 256));
    expect(race).toHaveBeenCalledOnce();
    expect(req.body.locked).toBe(false);
  });
  it("normalizes an already locked body without disturbing its owner", async () => {
    const req = request([[1]]), owner = req.body.getReader();
    await expect(readBoundedRequestBody(req, 4, 1000)).rejects.toThrow("request_body_interrupted");
    expect(req.pull).not.toHaveBeenCalled(); expect(req.cancel).not.toHaveBeenCalled();
    expect((await owner.read()).value).toEqual(new Uint8Array([1]));
    owner.releaseLock();
  });
  it("stops an unknown-length stream as soon as accumulation exceeds the cap", async () => {
    const req = request([[1, 2], [3, 4, 5], [6]]);
    await expect(readBoundedRequestBody(req, 4, 1000)).rejects.toMatchObject({ reason: "too_large" });
    expect(req.pull).toHaveBeenCalledTimes(2); expect(req.cancel).toHaveBeenCalledOnce();
  });
  it.each(["-1", "1.5", "NaN", "9007199254740992", "1e2"])("refuses malformed declared length %s", async length => {
    const req = request([[1]], length);
    await expect(readBoundedRequestBody(req, 4, 1000)).rejects.toMatchObject({ reason: "invalid_length" });
    expect(req.pull).not.toHaveBeenCalled();
  });
  it.each(["1", "3"])("rejects a lying length %s without returning partial audio", async length => {
    await expect(readBoundedRequestBody(request([[1, 2]], length), 4, 1000)).rejects.toMatchObject({ reason: "invalid_length" });
  });
  it("rejects missing and empty bodies", async () => {
    await expect(readBoundedRequestBody({ ...request([]), body: null }, 4, 1000)).rejects.toMatchObject({ reason: "empty" });
    await expect(readBoundedRequestBody(request([]), 4, 1000)).rejects.toMatchObject({ reason: "empty" });
    await expect(readBoundedRequestBody(request([], "0"), 4, 1000)).rejects.toMatchObject({ reason: "empty" });
  });
  it("bounds a stalled reader even if stream cancellation never resolves", async () => {
    vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
    const req = { ...request([]), body: new ReadableStream<Uint8Array<ArrayBuffer>>({ pull: () => new Promise<void>(() => {}), cancel }) };
    const result = expect(readBoundedRequestBody(req, 4, 1000)).rejects.toMatchObject({ reason: "interrupted" });
    await vi.advanceTimersByTimeAsync(1000); await result;
    expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("honors cancellation before and during reading", async () => {
    const controller = new AbortController(); controller.abort(); const before = request([[1]], undefined, controller);
    await expect(readBoundedRequestBody(before, 4, 1000)).rejects.toMatchObject({ reason: "interrupted" });
    expect(before.pull).not.toHaveBeenCalled();
    const during = new AbortController(), cancel = vi.fn();
    const req = { ...request([], undefined, during), body: new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel }) };
    const result = expect(readBoundedRequestBody(req, 4, 1000)).rejects.toMatchObject({ reason: "interrupted" });
    during.abort(); await result; expect(cancel).toHaveBeenCalledOnce();
  });
  it("discards arbitrary stream error details", async () => {
    const req = { ...request([]), body: new ReadableStream<Uint8Array<ArrayBuffer>>({ start: stream => stream.error(new Error("PRIVATE AUDIO PAYLOAD")) }) };
    await expect(readBoundedRequestBody(req, 4, 1000)).rejects.toThrow("request_body_interrupted");
  });
  it("checks elapsed time even if an empty synchronous stream starves the timer", async () => {
    let time = 0; vi.spyOn(Date, "now").mockImplementation(() => time += 10);
    const cancel = vi.fn();
    const req = { ...request([]), body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: stream => stream.enqueue(new Uint8Array()), cancel,
    }, { highWaterMark: 0 }) };
    await expect(readBoundedRequestBody(req, 4, 50)).rejects.toMatchObject({ reason: "interrupted" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
