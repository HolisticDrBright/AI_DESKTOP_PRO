import { campaignCounts, type CampaignCounts } from '@/contracts/leadCampaigns';

/**
 * The Desktop's only view of the campaign service: counts from its /internal/counts endpoint, read on
 * the server with a bearer token the browser never sees. The campaign service's own admin key stays
 * inside that service; this side receives numbers, never a person, and has no way to ask for one.
 */
export type CampaignStatus =
  | { state: 'not_configured' }
  | { state: 'unavailable' }
  | { state: 'ok'; counts: CampaignCounts; dashboardUrl: string | null };
type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; cache: 'no-store'; redirect: 'error' }) => Promise<{ ok: boolean; text(): Promise<string> }>;

export function campaignStatusConfig(env: Record<string, string | undefined>) {
  const url = env.CAMPAIGN_STATS_URL ?? '', token = env.CAMPAIGN_STATS_TOKEN ?? '';
  let parsed: URL | null = null; try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.pathname !== '/internal/counts' || parsed.search || parsed.username || token.length < 32) return null;
  let dashboardUrl: string | null = null;
  try { const d = new URL(env.CAMPAIGN_DASHBOARD_URL ?? ''); if (d.protocol === 'https:' && !d.username) dashboardUrl = d.toString(); } catch { dashboardUrl = null; }
  return { url: parsed.toString(), token, dashboardUrl };
}

export async function readCampaignStatus(env: Record<string, string | undefined>, fetcher: Fetch = fetch as unknown as Fetch): Promise<CampaignStatus> {
  const config = campaignStatusConfig(env);
  if (!config) return { state: 'not_configured' };
  try {
    const response = await fetcher(config.url, { headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000), cache: 'no-store', redirect: 'error' });
    if (!response.ok) return { state: 'unavailable' };
    const text = await response.text();
    if (text.length > 65536) return { state: 'unavailable' };
    const parsed = campaignCounts.safeParse(JSON.parse(text));
    return parsed.success ? { state: 'ok', counts: parsed.data, dashboardUrl: config.dashboardUrl } : { state: 'unavailable' };
  } catch { return { state: 'unavailable' }; }
}
