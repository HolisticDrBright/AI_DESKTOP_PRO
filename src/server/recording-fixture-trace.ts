import { randomUUID } from 'node:crypto';
import { isContractFixtureAllowed } from './runtime/contractFixture';
import type { TrpcObservation } from '@/adapters/trpc.server';

const stages = new Set(['request_received', 'request_body_read', 'session_read', 'token_start', 'token_ready',
  'upstream_start', 'upstream_headers', 'upstream_decoded', 'request_aborted', 'route_settled']);
export type RecordingFixtureStage = TrpcObservation | 'request_received' | 'request_body_read' | 'session_read';

/** Optional numeric-only local diagnostic. No identifiers/body/error strings or
 * credentials can be supplied to the logger. This cannot activate a fixture. */
export async function withRecordingFixtureTrace<T>(request: Request, work: (observe: (stage: RecordingFixtureStage) => void) => Promise<T>): Promise<T> {
  if (process.env.E2E_RECORDING_DIAGNOSTICS !== '1' || !isContractFixtureAllowed()
    || !['GET', 'POST', 'PATCH'].includes(request.method)) return work(() => {});
  const started = performance.now(), trace = randomUUID();
  const observe = (stage: string) => {
    if (!stages.has(stage)) return;
    try { console.info(JSON.stringify({ check: 'fixture_recording_timing', trace, method: request.method,
      stage, elapsedMs: Math.round(performance.now() - started) })); } catch { /* Diagnostics cannot change the request outcome. */ }
  };
  const abort = () => observe('request_aborted');
  request.signal.addEventListener('abort', abort, { once: true });
  observe('request_received');
  try { return await work(observe); }
  finally { observe('route_settled'); request.signal.removeEventListener('abort', abort); }
}
