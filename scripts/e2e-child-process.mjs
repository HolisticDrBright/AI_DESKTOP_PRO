import { spawn } from 'node:child_process';

/**
 * Wait for a browser-test process without blocking the parent event loop.
 * The parent must keep draining the separately owned Next dev server's
 * stdout/stderr pipes throughout the full browser battery.
 */
export async function runBoundedChild(executable, args, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes must be a positive safe integer');
  }
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let bytes = 0;
  let limitExceeded = false;
  let spawnError = null;

  const collect = (chunk) => {
    if (limitExceeded) return;
    // Optional progress echo (the order runner streams Playwright's list output into its own log).
    options.onData?.(chunk);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      limitExceeded = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('error', (error) => { spawnError = error; });

  const { code, signal } = await new Promise((resolve) => {
    child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  return {
    output: Buffer.concat(chunks).toString('utf8'),
    exitOk: code === 0 && signal === null && !limitExceeded && spawnError === null,
    code,
    signal,
    limitExceeded,
    error: spawnError,
  };
}
