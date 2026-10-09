import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), token: vi.fn(), upload: vi.fn() }));
vi.mock("@/server/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/adapters/session.server", () => ({ getClinicalAccessToken: mocks.token }));
vi.mock("@/adapters/scribe.live", () => ({ scribeLive: { uploadChunk: mocks.upload } }));
vi.mock("@/adapters/mode", () => ({ USE_LIVE_API: true }));
import { POST } from "./route";

const recordingId = "aaaaaaaa-1111-2222-3333-444444444401";
const maxBytes = 5 * 1024 * 1024;
const invalidHeaders: Record<string, string>[] = [
  { "x-recording-id": "../../another-endpoint" }, { "x-recording-id": "" },
  { "x-capture-token": " " }, { "x-capture-token": "a".repeat(4097) },
];
function request(bytes: number[] = [1, 2, 3], headers: Record<string, string> = {}) {
  let sent = false;
  const pull = vi.fn((stream: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>) => {
    if (sent) stream.close(); else { stream.enqueue(new Uint8Array(bytes)); sent = true; }
  });
  const req = new NextRequest("http://localhost/api/live/scribe/chunk", {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-recording-id": recordingId,
      "x-capture-token": "synthetic-capture-authorization", ...headers },
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
  });
  return { req, pull };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.session.mockResolvedValue({ token: "cookie-session" });
  mocks.token.mockResolvedValue("resolved-workforce-token");
  mocks.upload.mockResolvedValue({ receivedBytes: 3, totalBytes: 3 });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("recording chunk proxy", () => {
  it("requires the session before reading audio or calling the backend", async () => {
    mocks.token.mockRejectedValue(new AdapterError("unauthenticated"));
    const { req, pull } = request(); const response = await POST(req);
    expect(response.status).toBe(401); expect(pull).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });
  it.each(invalidHeaders)("rejects malformed ownership headers before reading", async headers => {
    const { req, pull } = request(undefined, headers);
    expect((await POST(req)).status).toBe(400); expect(pull).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("rejects advertised oversize without buffering it", async () => {
    const { req, pull } = request([1], { "content-length": String(maxBytes + 1) });
    expect((await POST(req)).status).toBe(400); expect(pull).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("rejects real oversize even without a declared length", async () => {
    const req = new NextRequest("http://localhost/api/live/scribe/chunk", { method: "POST",
      headers: { "x-recording-id": recordingId, "x-capture-token": "synthetic-capture-authorization" },
      body: new Uint8Array(maxBytes + 1) });
    expect((await POST(req)).status).toBe(400); expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("forwards exact bytes with the resolved token only after complete validation", async () => {
    const { req } = request([1, 2, 3], { "content-length": "3" });
    const response = await POST(req); expect(response.status).toBe(200);
    expect(mocks.token).toHaveBeenCalledWith("cookie-session");
    expect(mocks.upload).toHaveBeenCalledWith({ recordingId, captureToken: "synthetic-capture-authorization",
      bytes: new Uint8Array([1, 2, 3]).buffer }, "resolved-workforce-token");
  });
  it("never forwards a truncated request", async () => {
    expect((await POST(request([1], { "content-length": "3" }).req)).status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("returns a bounded safe failure for a stalled stream, without a backend write", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const req = new NextRequest("http://localhost/api/live/scribe/chunk", { method: "POST",
      headers: { "x-recording-id": recordingId, "x-capture-token": "synthetic-capture-authorization" },
      body: new ReadableStream({ cancel }) });
    const pending = POST(req); await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending; expect(response.status).toBe(503);
    expect(await response.text()).toContain("No partial audio was forwarded");
    expect(cancel).toHaveBeenCalledOnce(); expect(mocks.upload).not.toHaveBeenCalled();
  });
});
