import { getHeapStatistics } from 'node:v8';
import { totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Loaded only by the explicit E2E resource budget. Do not capture request paths,
// bodies, headers, tokens, environment values, heap dumps, or health information.
if (process.env.E2E_DEV_MEMORY_PROBE === '1'
  && process.env.E2E_DEV_SERVER === '1'
  && process.env.NEXT_PRIVATE_WORKER === '1'
  && process.env.NODE_ENV === 'development') {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let priorLoop = performance.eventLoopUtilization();
  const sample = (event, exitCode) => {
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
    }));
    loopDelay.reset();
  };
  sample('start');
  const timer = setInterval(() => sample('sample'), 30_000);
  timer.unref();
  process.once('exit', (code) => { clearInterval(timer); sample('exit', code); loopDelay.disable(); });
}
