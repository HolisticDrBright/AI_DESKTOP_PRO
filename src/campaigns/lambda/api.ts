import { createCampaignHttpHandler, type HttpEvent, type HttpResponse } from '../http';
import { campaignRuntime } from '../runtime';
import { buildEngineDeps } from './build';

/** The campaign API Lambda. Off: 503 for every route, and nothing is built. */
let ready: Promise<(event: HttpEvent) => Promise<HttpResponse>> | null = null;
export async function handler(event: HttpEvent): Promise<HttpResponse> {
  const runtime = campaignRuntime(process.env);
  if (!runtime.enabled) return { statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{"error":"disabled"}' };
  ready ??= buildEngineDeps(runtime).then(createCampaignHttpHandler);
  return (await ready)(event);
}
