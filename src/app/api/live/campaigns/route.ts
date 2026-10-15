import { NextResponse } from 'next/server';
import { workforceRequest, workforceResponse } from '@/campaigns/contract';
import { getRequestSession } from '@/server/session';
import { readBoundedRequestBody } from '@/server/bounded-request-body';
import { sameBrowserOrigin } from '@/server/same-browser-origin';
import { CampaignApiError, campaignApiCall, campaignEngineEnabled } from '@/server/campaign-api';
import { liveGuard } from '../route-guard';

/**
 * The Campaigns screen's route. The practitioner's cookie session is exchanged for the workforce token here, and the
 * campaign API's own JWT authorizer verifies it; the practice and the person come from that token there, never from
 * this request. The answer is commercial data under its own key (`data`), and a failure is an error status, never an
 * empty answer.
 */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  if (!campaignEngineEnabled()) return json(404, { error: 'not_found' });
  if (!sameBrowserOrigin(request)) return json(403, { error: 'identity_refused' });
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(request, 262_144, 5000))); } catch { return json(400, { error: 'invalid' }); }
  const parsed = workforceRequest.safeParse(body);
  if (!parsed.success) return json(400, { error: 'invalid' });
  try {
    const data = workforceResponse.parse(await campaignApiCall({ method: 'POST', path: '/campaigns/workforce', body: parsed.data, token: session.token, timeoutMs: 20_000 }));
    return json(200, { data });
  } catch (error) {
    if (error instanceof CampaignApiError && error.status !== 503) return json(error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    return json(503, { error: 'unavailable' });
  }
}
