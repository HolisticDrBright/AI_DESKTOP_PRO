import { totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIB = 1024 * 1024;
const RESERVE_MIB = 4096;

/**
 * Explicit budget only for the local dev-server browser harness, never deployment.
 * @param {Record<string, string | undefined>} env
 * @param {{totalBytes: number, constrainedBytes: number}} memory
 * @returns {Record<string, string>}
 */
export function devServerEnvironment(env = process.env, memory = {
  totalBytes: totalmem(),
  constrainedBytes: process.constrainedMemory?.() ?? 0,
}) {
  const requested = env.E2E_DEV_HEAP_MB;
  if (requested === undefined) return {};
  if (env.E2E_DEV_SERVER !== '1' || env.NODE_ENV === 'production') {
    throw new Error('The E2E heap budget is only valid for the development browser harness.');
  }
  if (!/^[1-9]\d*$/.test(requested)) throw new Error('E2E_DEV_HEAP_MB must be an integer.');
  const heapMiB = Number(requested);
  if (!Number.isSafeInteger(heapMiB) || heapMiB < 2048 || heapMiB > 12288) {
    throw new Error('E2E_DEV_HEAP_MB must be between 2048 and 12288.');
  }
  const limits = [memory.totalBytes, memory.constrainedBytes].filter((value) => value > 0);
  const availableMiB = Math.floor(Math.min(...limits) / MIB);
  if (!Number.isFinite(availableMiB) || availableMiB < heapMiB + RESERVE_MIB) {
    throw new Error('Insufficient runner memory: the E2E heap requires an additional 4096 MiB reserve.');
  }
  const inherited = env.NODE_OPTIONS ?? '';
  // Refuse competing spellings instead of silently overriding an operator's budget.
  if (/max[-_]old[-_]space[-_]size/i.test(inherited)) {
    throw new Error('Set only E2E_DEV_HEAP_MB; NODE_OPTIONS already contains a heap budget.');
  }
  // Playwright loads this config through its CJS transform; avoid import.meta.
  const probe = pathToFileURL(resolve('scripts/e2e-dev-memory-probe.mjs')).href;
  return {
    NODE_OPTIONS: `${inherited} --max-old-space-size=${heapMiB} --import=${JSON.stringify(probe)}`.trim(),
    E2E_DEV_MEMORY_PROBE: '1',
  };
}
