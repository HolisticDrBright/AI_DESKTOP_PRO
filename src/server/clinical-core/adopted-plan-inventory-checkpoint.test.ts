import { expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pauseInventoryInterruptionCheckpoint } from './adopted-plan-inventory-checkpoint';

it('refuses a non-IPC invocation without sending a checkpoint', async () => {
  await expect(pauseInventoryInterruptionCheckpoint({} as never,
    { connected: false } as NodeJS.Process)).rejects.toThrow('interruption_ipc_refused');
});

for (const end of ['stop', 'disconnect'] as const) it(`holds a real child after its checkpoint until ${end}`, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'alp-inventory-ipc-'));
  const filename = resolve(directory, 'checkpoint.cjs');
  buildSync({ stdin: { contents: `import { pauseInventoryInterruptionCheckpoint } from './src/server/clinical-core/adopted-plan-inventory-checkpoint';
    pauseInventoryInterruptionCheckpoint({ kind: 'checkpoint' } as never).then(() => { process.exitCode = 99; })
      .catch(() => { process.exitCode = 1; });`, resolveDir: process.cwd(), sourcefile: 'checkpoint-fixture.ts', loader: 'ts' },
    outfile: filename, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const child = spawn(process.execPath, [filename], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
  let output = 0; child.stdout!.on('data', b => { output += b.length; }); child.stderr!.on('data', b => { output += b.length; });
  try {
    const packet = await new Promise(done => child.once('message', done));
    expect(packet).toEqual({ kind: 'checkpoint' });
    await new Promise(done => setTimeout(done, 300));
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    if (end === 'stop') expect(child.kill()).toBe(true); else child.disconnect();
    const result = await exit;
    expect(result.code).not.toBe(99);
    if (end === 'disconnect') expect(result.code).toBe(1);
    expect(output).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
