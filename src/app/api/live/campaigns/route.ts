import { NextResponse } from 'next/server';
import { readCampaignStatus } from '@/server/campaigns/campaign-status';
import { getRequestSession } from '@/server/session';
import { liveGuard } from '../route-helpers';

/** Campaign counts for the signed-in staff Campaigns screen. Read-only; counts only. */
const json = (status: number, value: unknown) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET() {
  const blocked = liveGuard(); if (blocked) return blocked;
  const session = await getRequestSession(); if (!session.token) return json(401, { error: 'reauth_required' });
  const status = await readCampaignStatus(process.env as Record<string, string | undefined>);
  return status.state === 'unavailable' ? json(503, { error: 'campaign_service_unavailable' }) : json(200, { data: status });
}
