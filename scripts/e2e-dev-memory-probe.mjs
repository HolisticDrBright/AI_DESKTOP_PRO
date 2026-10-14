import { getHeapStatistics } from 'node:v8';
import { totalmem } from 'node:os';
import { constants, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

// Loaded only by the explicit E2E resource budget. Do not capture request paths,
// bodies, headers, tokens, environment values, heap dumps, or health information.
if (process.env.E2E_DEV_MEMORY_PROBE === '1'
  && process.env.E2E_DEV_SERVER === '1'
  && process.env.NEXT_PRIVATE_WORKER === '1'
  && process.env.NODE_ENV === 'development') {
  const sample = (event, exitCode, window) => {
    const heap = getHeapStatistics();
    console.error(JSON.stringify({
      check: 'e2e_next_dev_memory', event, pid: process.pid,
      ...(exitCode === undefined ? {} : { exitCode }),
      heapUsedBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      rssBytes: process.memoryUsage().rss,
      totalMemoryBytes: totalmem(),
      constrainedMemoryBytes: process.constrainedMemory?.() ?? 0,
      ...window,
    }));
  };

  // Per 30 s window, timings only: the longest the event loop was held, and the major collections that held it. The
  // heap measured just after a major collection approximates what is retained — `heapUsedBytes` alone cannot tell
  // retained memory from garbage not yet collected. No collection is forced.
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let gc = { majorCount: 0, majorPauseMaxMs: 0, majorPauseTotalMs: 0, heapAfterMajorGcBytes: null };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.detail?.kind !== constants.NODE_PERFORMANCE_GC_MAJOR) continue;
      gc.majorCount += 1;
      gc.majorPauseMaxMs = Math.max(gc.majorPauseMaxMs, entry.duration);
      gc.majorPauseTotalMs += entry.duration;
      gc.heapAfterMajorGcBytes = getHeapStatistics().used_heap_size;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  const window = () => {
    const out = {
      eventLoopDelayMaxMs: Math.round(loop.max / 1e6),
      gcMajorCount: gc.majorCount,
      gcMajorPauseMaxMs: Math.round(gc.majorPauseMaxMs),
      gcMajorPauseTotalMs: Math.round(gc.majorPauseTotalMs),
      heapAfterMajorGcBytes: gc.heapAfterMajorGcBytes,
    };
    loop.reset();
    gc = { majorCount: 0, majorPauseMaxMs: 0, majorPauseTotalMs: 0, heapAfterMajorGcBytes: gc.heapAfterMajorGcBytes };
    return out;
  };

  sample('start');
  const timer = setInterval(() => sample('sample', undefined, window()), 30_000);
  timer.unref();
  process.once('exit', (code) => {
    clearInterval(timer);
    observer.disconnect();
    loop.disable();
    sample('exit', code);
  });
}
