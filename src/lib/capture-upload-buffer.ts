/** Memory-only audio owned by one recorder/session, never a global upload queue.
 * Cancelling releases buffered audio and aborts transport. It does NOT prove a
 * request was rolled back by the server; remote receipt reconciliation is separate.
 */
export class CaptureUploadBuffer {
  private readonly controller = new AbortController();
  private readonly chunks: Blob[] = [];
  pumping = false;

  constructor(readonly recordingId: string, readonly sessionId: string) {
    if (!recordingId || !sessionId) throw new Error("capture_owner_required");
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get length(): number { return this.chunks.length; }
  get head(): Blob | undefined { return this.chunks[0]; }

  enqueue(chunk: Blob): boolean {
    if (this.signal.aborted || chunk.size === 0) return false;
    this.chunks.push(chunk);
    return true;
  }

  acknowledge(chunk: Blob): boolean {
    if (this.signal.aborted || this.head !== chunk) return false;
    this.chunks.shift();
    return true;
  }

  cancel(): void {
    this.controller.abort();
    this.chunks.length = 0;
  }
}
