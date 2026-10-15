import { campaignRuntime } from '../runtime';
import { createSendJob, type PassSummary } from '../send-job';
import { buildEngineDeps } from './build';

/** The scheduled sending job, invoked every 5 minutes by EventBridge Scheduler. Off: it does nothing. */
let ready: Promise<() => Promise<PassSummary>> | null = null;
export async function handler(): Promise<PassSummary | { disabled: true }> {
  const runtime = campaignRuntime(process.env);
  if (!runtime.enabled) return { disabled: true };
  ready ??= buildEngineDeps(runtime).then(createSendJob);
  return (await ready)();
}
