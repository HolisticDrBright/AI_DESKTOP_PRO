import { getHeapStatistics } from 'node:v8';
import { totalmem } from 'node:os';

// Loaded only by the explicit E2E resource budget. Do not capture request paths,
// bodies, headers, tokens, environment values, heap dumps, or health information.
if (process.env.E2E_DEV_MEMORY_PROBE === '1'
  && process.env.E2E_DEV_SERVER === '1'
  && process.env.NEXT_PRIVATE_WORKER === '1'
  && process.env.NODE_ENV === 'development') {
  const sample = (event, exitCode) => {
    const heap = getHeapStatistics();
    console.error(JSON.stringify({
      check: 'e2e_next_dev_memory', event, pid: process.pid,
      ...(exitCode === undefined ? {} : { exitCode }),
      heapUsedBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      rssBytes: process.memoryUsage().rss,
      totalMemoryBytes: totalmem(),
      constrainedMemoryBytes: process.constrainedMemory?.() ?? 0,
    }));
  };
  sample('start');
  const timer = setInterval(() => sample('sample'), 30_000);
  timer.unref();
  process.once('exit', (code) => { clearInterval(timer); sample('exit', code); });
}
