import { getHeapStatistics } from 'node:v8';
import { totalmem } from 'node:os';
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

// Loaded only by the explicit E2E resource budget. Do not capture request paths,
// bodies, headers, tokens, environment values, heap dumps, or health information.
if (process.env.E2E_DEV_MEMORY_PROBE === '1'
  && process.env.E2E_DEV_SERVER === '1'
  && process.env.NEXT_PRIVATE_WORKER === '1'
  && process.env.NODE_ENV === 'development') {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let priorLoop = performance.eventLoopUtilization();

  // Per 30 s window, timings only: the major collections that held the loop, and the heap measured just after one,
  // which approximates what is retained — `heapUsedBytes` alone cannot tell retained memory from garbage not yet
  // collected. No collection is forced.
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
  const gcWindow = () => {
    const out = {
      gcMajorCount: gc.majorCount,
      gcMajorPauseMaxMs: Math.round(gc.majorPauseMaxMs),
      gcMajorPauseTotalMs: Math.round(gc.majorPauseTotalMs),
      heapAfterMajorGcBytes: gc.heapAfterMajorGcBytes,
    };
    gc = { majorCount: 0, majorPauseMaxMs: 0, majorPauseTotalMs: 0, heapAfterMajorGcBytes: gc.heapAfterMajorGcBytes };
    return out;
  };

  const sample = (event, exitCode, window) => {
    const heap = getHeapStatistics();
    const loopNow = performance.eventLoopUtilization();
    const loopWindow = performance.eventLoopUtilization(loopNow, priorLoop);
    priorLoop = loopNow;
    const loopMaxMs = loopDelay.max / 1_000_000;
    const loopP99Ms = loopDelay.percentile(99) / 1_000_000;
    console.error(JSON.stringify({
      check: 'e2e_next_dev_memory', event, pid: process.pid,
      ...(exitCode === undefined ? {} : { exitCode }),
      heapUsedBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      rssBytes: process.memoryUsage().rss,
      loopUtilization: Number.isFinite(loopWindow.utilization) ? loopWindow.utilization : null,
      loopDelayMaxMs: Number.isFinite(loopMaxMs) ? loopMaxMs : null,
      loopDelayP99Ms: Number.isFinite(loopP99Ms) ? loopP99Ms : null,
      totalMemoryBytes: totalmem(),
      constrainedMemoryBytes: process.constrainedMemory?.() ?? 0,
      ...window,
    }));
    loopDelay.reset();
  };
  sample('start');
  const timer = setInterval(() => sample('sample', undefined, gcWindow()), 30_000);
  timer.unref();
  process.once('exit', (code) => {
    clearInterval(timer);
    observer.disconnect();
    sample('exit', code);
    loopDelay.disable();
  });
}
