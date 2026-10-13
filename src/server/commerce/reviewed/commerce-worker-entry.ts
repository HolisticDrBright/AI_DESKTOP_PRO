if (typeof window !== 'undefined') throw new Error('reviewed commerce worker is server-only');
import type { WorkerReport } from '../program-commerce-worker';
import { commerceFlagsOn, type CommerceHoldReason, type ProgramCommerceHostTarget } from './commerce-host-target';
import { commerceHostTargetFromEnvironment } from './commerce-host-target-source';
import { createReviewedCommerceRuntime, type ReviewedCommerceInputs } from './reviewed-commerce-runtime';

/**
 * The scheduled settlement and recovery pass: one runOnce of the existing commerce worker (intake,
 * reconciliation, settlement, delivery, expiry) per invocation, from a schedule the host owns. The
 * webhook only admits; this is what turns admitted payments into entitlements and sends the codes,
 * and what recovers everything a crash, a lost reply or a duplicate event left behind.
 *
 * Closed by default: the flags, the pinned target and the worker's readiness (processor credentials
 * proving the target's account and version, price ids, the purchaser-contact and code-lifetime
 * decisions, the sealing key) must all hold, or the pass does nothing and says which holds apply.
 * The summary carries counts by outcome only: no code, address, order detail or provider text.
 * Overlapping invocations are safe (every step is revision-checked); scheduling, concurrency and
 * alarms are the host's.
 */
export type WorkerSummary =
  | { ran: false; reason: 'flags_off' | 'target_unavailable'; holds?: CommerceHoldReason[] }
  | { ran: false; reason: 'worker_held'; holds: CommerceHoldReason[] }
  | { ran: true; counts: Record<string, Record<string, number> | 'unavailable'> };

const tally = <T>(pass: { ok: true } & Record<string, unknown> | { ok: false }, list: (value: never) => T[], key: (item: T) => string): Record<string, number> | 'unavailable' => {
  if (!pass.ok) return 'unavailable';
  const counts: Record<string, number> = {};
  for (const item of list(pass as never)) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

export function summarizeWorkerReport(report: WorkerReport): Extract<WorkerSummary, { ran: true }> {
  return { ran: true, counts: {
    intake: tally(report.intake, (v: { results: { state: string }[] }) => v.results, item => item.state),
    reconcile: tally(report.reconcile, (v: { results: { outcome: string }[] }) => v.results, item => item.outcome),
    settlement: tally(report.settlement, (v: { outcomes: { settled: boolean; reason?: string; delivery?: string }[] }) => v.outcomes, item => item.settled ? `settled_${item.delivery}` : `held_${item.reason}`),
    delivery: tally(report.delivery, (v: { results: { state: string }[] }) => v.results, item => item.state),
    expiry: report.expiry.ok ? { expired: report.expiry.expired.length } : 'unavailable',
  } };
}

export function createReviewedCommerceWorkerHandler(deps: { env?: Record<string, string | undefined>; target?: () => ProgramCommerceHostTarget; runtimeInputs?: Omit<ReviewedCommerceInputs, 'target' | 'env'> } = {}) {
  const env = deps.env ?? process.env;
  let composed: { pin: string; runtime: ReturnType<typeof createReviewedCommerceRuntime> } | null = null;
  return async (): Promise<WorkerSummary> => {
    if (!commerceFlagsOn(env)) return { ran: false, reason: 'flags_off' };
    let target: ProgramCommerceHostTarget;
    try { target = (deps.target ?? (() => commerceHostTargetFromEnvironment(env)))(); } catch { return { ran: false, reason: 'target_unavailable' }; }
    const pin = JSON.stringify(target);
    if (!composed || composed.pin !== pin) composed = { pin, runtime: createReviewedCommerceRuntime({ ...deps.runtimeInputs, target, env }) };
    const { runtime } = composed;
    if (!runtime.worker) return { ran: false, reason: 'worker_held', holds: runtime.readiness.worker.holds };
    return summarizeWorkerReport(await runtime.worker.runOnce());
  };
}
