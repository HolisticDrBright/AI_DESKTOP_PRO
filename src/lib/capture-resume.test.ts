import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeCaptureResume, type CaptureReply } from "./capture-resume";

afterEach(() => vi.useRealTimers());
const resumed: CaptureReply = { ok: true, status: 200, data: { ok: true } };
const active: CaptureReply = { ok: true, status: 200, data: { ok: true, status: "active", captureToken: "fresh-synthetic-token" } };
describe("explicit capture resume authorization", () => {
  it("requires a successful resume then a fresh active heartbeat", async () => {
    const request = vi.fn().mockResolvedValueOnce(resumed).mockResolvedValueOnce(active);
    await expect(authorizeCaptureResume(new AbortController().signal, request)).resolves.toEqual({ kind: "authorized", token: "fresh-synthetic-token" });
    expect(request.mock.calls.map(call => call[0])).toEqual(["resume", "heartbeat"]);
  });
  it.each([
    { ok: false, status: 503 },
    { ok: true, status: 200 },
    { ok: true, status: 200, data: { ok: false, status: "active", captureToken: "old" } },
    { ok: true, status: 200, data: { ok: true, status: "paused", captureToken: "old" } },
    { ok: true, status: 200, data: { ok: true, status: "active", captureToken: " " } },
  ])("never resumes from an unconfirmed heartbeat: %j", async beat => {
    const request = vi.fn().mockResolvedValueOnce(resumed).mockResolvedValueOnce(beat);
    await expect(authorizeCaptureResume(new AbortController().signal, request)).resolves.toEqual({ kind: "unconfirmed" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("does not heartbeat after a refused or malformed resume", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    await expect(authorizeCaptureResume(new AbortController().signal, request)).resolves.toEqual({ kind: "refused" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("bounds stalled resume and never sends a heartbeat after a late response", async () => {
    vi.useFakeTimers(); let finish!: (reply: CaptureReply) => void;
    const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = authorizeCaptureResume(new AbortController().signal, request);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(result).resolves.toEqual({ kind: "unconfirmed" });
    finish(resumed); await Promise.resolve();
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]?.[1].aborted).toBe(true);
  });
  it("ignores late authorization after cancellation and does not start an already cancelled request", async () => {
    const controller = new AbortController(); let finish!: (reply: CaptureReply) => void;
    const request = vi.fn().mockResolvedValueOnce(resumed).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = authorizeCaptureResume(controller.signal, request);
    await Promise.resolve(); controller.abort();
    await expect(result).resolves.toEqual({ kind: "unconfirmed" });
    finish(active); await Promise.resolve();
    await expect(authorizeCaptureResume(controller.signal, request)).resolves.toEqual({ kind: "unconfirmed" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
