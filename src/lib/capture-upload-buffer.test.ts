import { describe, expect, it } from "vitest";
import { CaptureUploadBuffer } from "./capture-upload-buffer";

describe("recording-owned audio buffers", () => {
  it("requires both recording and capture-session ownership", () => {
    expect(() => new CaptureUploadBuffer("", "session")).toThrow("capture_owner_required");
    expect(() => new CaptureUploadBuffer("recording", "")).toThrow("capture_owner_required");
  });
  it("acknowledges only the exact first chunk, not a duplicate or out-of-order receipt", () => {
    const queue = new CaptureUploadBuffer("recording", "session");
    const first = new Blob(["first"]), second = new Blob(["second"]);
    queue.enqueue(first); queue.enqueue(second);
    expect(queue.acknowledge(second)).toBe(false);
    expect(queue.acknowledge(new Blob(["first"]))).toBe(false);
    expect(queue.acknowledge(first)).toBe(true);
    expect(queue.acknowledge(first)).toBe(false);
    expect(queue.head).toBe(second);
  });
  it("cancels transport and releases audio; late recorder events cannot requeue it", () => {
    const queue = new CaptureUploadBuffer("recording", "session");
    const chunk = new Blob(["audio"]); queue.enqueue(chunk); queue.cancel();
    expect(queue.signal.aborted).toBe(true);
    expect(queue.length).toBe(0);
    expect(queue.enqueue(chunk)).toBe(false);
    expect(queue.acknowledge(chunk)).toBe(false);
    queue.cancel(); expect(queue.length).toBe(0);
  });
  it("a delayed completion cannot consume or unlock a newer recorder's buffer, even for the same server IDs", async () => {
    const old = new CaptureUploadBuffer("recording", "session");
    const oldChunk = new Blob(["old"]); old.enqueue(oldChunk); old.pumping = true;
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; }).then(() => {
      old.acknowledge(oldChunk); old.pumping = false;
    });
    old.cancel();
    const current = new CaptureUploadBuffer("recording", "session");
    const newChunk = new Blob(["new"]); current.enqueue(newChunk); current.pumping = true;
    complete(); await pending;
    expect(current.head).toBe(newChunk); expect(current.length).toBe(1);
    expect(current.pumping).toBe(true); expect(current.signal.aborted).toBe(false);
  });
  it("never accepts empty audio", () => {
    const queue = new CaptureUploadBuffer("recording", "session");
    expect(queue.enqueue(new Blob())).toBe(false); expect(queue.length).toBe(0);
  });
});
