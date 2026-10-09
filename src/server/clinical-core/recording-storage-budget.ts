/** Storage timeouts are uncertain outcomes, not evidence of absence or erasure.
 * Bound our wait independently of SDK cancellation. Detached late responses
 * have no continuation into receipt creation; their rejections are consumed.
 * A backwards wall clock cannot extend the original monotonic time budget. */
export function createRecordingStorageBudget(acceptBefore: string, maximumMs: number,
  now: () => number = Date.now, monotonic: () => number = () => performance.now()) {
  const wallDeadline = Math.min(Date.parse(acceptBefore), now() + maximumMs);
  const duration = wallDeadline - now(), started = monotonic();
  const unavailable = () => new Error('recording_storage_deadline');
  const remaining = () => {
    const elapsed = monotonic() - started;
    const value = Math.min(wallDeadline - now(), duration - elapsed);
    if (!Number.isFinite(value) || !Number.isFinite(elapsed) || elapsed < 0 || value <= 0) throw unavailable();
    return value;
  };
  return {
    check() { remaining(); },
    run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const limit = Math.min(10000, remaining());
      const operationStarted = monotonic();
      const checkOperation = () => {
        remaining();
        const elapsed = monotonic() - operationStarted;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= limit) throw unavailable();
      };
      const controller = new AbortController();
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(unavailable());
          controller.abort();
        }, Math.max(1, Math.floor(limit)));
        Promise.resolve().then(() => {
          checkOperation();
          if (settled) throw unavailable();
          return operation(controller.signal);
        }).then(value => {
          if (settled) return;
          try { checkOperation(); } catch (error) {
            settled = true; clearTimeout(timer); reject(error); controller.abort(); return;
          }
          settled = true; clearTimeout(timer); resolve(value);
        }, error => {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(error);
        });
      });
    },
  };
}
