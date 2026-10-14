import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedChild } from './e2e-child-process.mjs';

test('browser child wait leaves the parent event loop free to drain another server', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try {
    const result = await runBoundedChild(process.execPath, [
      '-e', "setTimeout(() => { process.stdout.write('ready\\n'); }, 180)",
    ]);
    assert.equal(result.exitOk, true);
    assert.match(result.output, /ready/);
    assert.ok(ticks >= 5, `parent event loop only advanced ${ticks} times`);
  } finally {
    clearInterval(timer);
  }
});

test('browser child retains a nonzero exit even when it prints a passing summary', async () => {
  const result = await runBoundedChild(process.execPath, [
    '-e', "console.log('12 passed'); process.exitCode = 1",
  ]);
  assert.equal(result.exitOk, false);
  assert.equal(result.code, 1);
  assert.match(result.output, /12 passed/);
});

test('browser child refuses an oversized output instead of silently truncating it', async () => {
  const result = await runBoundedChild(process.execPath, [
    '-e', "process.stdout.write('x'.repeat(4096))",
  ], { maxBytes: 1024 });
  assert.equal(result.exitOk, false);
  assert.equal(result.limitExceeded, true);
});
