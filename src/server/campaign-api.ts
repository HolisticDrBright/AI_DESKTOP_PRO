if (typeof window !== 'undefined') throw new Error('campaign-api is server-only');
import { readBoundedRequestBody } from '@/server/bounded-request-body';

/**
 * The Desktop's side of the campaign engine: it forwards to the engine's own API and holds nothing itself. The engine
 * is commercial; this file imports nothing clinical, and the clinical API is never called from here.
 *
 *   CAMPAIGN_ENGINE_ENABLED  exactly `true` or the whole feature is absent: /join pages and the public campaign routes
 *                            answer not-found, the Campaigns screen says the engine is switched off, and no program
 *                            page shows "Get updates".
 *   CAMPAIGN_API_ORIGIN      the campaign HTTP API (an execute-api https origin and nothing else).
 *   FUNNEL_PRACTICE_SLUG     the practice whose /join page this deployment's program pages link to.
 */
type Env = Readonly<Record<string, string | undefined>>;

export function campaignEngineEnabled(env: Env = process.env): boolean {
  return env.CAMPAIGN_ENGINE_ENABLED?.trim() === 'true';
}
export function campaignApiOrigin(env: Env = process.env): string | null {
  let url: URL;
  try { url = new URL(env.CAMPAIGN_API_ORIGIN?.trim() ?? ''); } catch { return null; }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port
    || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return null;
  return url.origin;
}
export function funnelPracticeSlug(env: Env = process.env): string | null {
  const slug = env.FUNNEL_PRACTICE_SLUG?.trim() ?? '';
  return /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(slug) ? slug : null;
}

export class CampaignApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) { super(code); }
}

/** One call to the campaign API. A failure to reach it is a 503, never an empty answer. */
export async function campaignApiCall<T>(input: { method: 'GET' | 'POST'; path: string; body?: unknown; token?: string; timeoutMs?: number; env?: Env }): Promise<T> {
  const env = input.env ?? process.env;
  if (!campaignEngineEnabled(env)) throw new CampaignApiError(404, 'not_found');
  const origin = campaignApiOrigin(env);
  if (!origin) throw new CampaignApiError(503, 'unavailable');
  let response: Response;
  try {
    response = await fetch(origin + input.path, {
      method: input.method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      headers: { accept: 'application/json', ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch { throw new CampaignApiError(503, 'unavailable'); }
  let payload: { data?: T; error?: string; detail?: string } = {};
  try {
    if (response.headers.get('content-type')?.includes('application/json')) {
      const bytes = await readBoundedRequestBody({ body: response.body, headers: response.headers, signal: AbortSignal.timeout(10_000) }, 1_000_000, 10_000);
      payload = JSON.parse(new TextDecoder().decode(bytes)) as typeof payload;
    }
  } catch { throw new CampaignApiError(503, 'unavailable'); }
  if (!response.ok) {
    const status = [400, 401, 403, 404, 409].includes(response.status) ? response.status : 503;
    throw new CampaignApiError(status, typeof payload.error === 'string' ? payload.error : 'unavailable', typeof payload.detail === 'string' ? payload.detail.slice(0, 200) : undefined);
  }
  if (payload.data === undefined) throw new CampaignApiError(503, 'unavailable');
  return payload.data;
}
