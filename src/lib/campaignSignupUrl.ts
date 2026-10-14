import type { FunnelDefinition } from '@/funnels';

/**
 * The "Get updates about this program" address: the campaign service's own sign-up page, which belongs to
 * that service and not to this web tier. Built from `CAMPAIGN_SIGNUP_ORIGIN` (an https origin and nothing
 * more) plus `/signup/<program key>`. With the setting unset or malformed, or for a funnel with no list,
 * there is no address and the page shows no link at all.
 *
 * The origin is used for this link and for nothing else: it is not added to the page's content security
 * policy, because a plain link needs no allowance and the page makes no request to that service.
 */
export type CampaignSignupEnv = { readonly [key: string]: string | undefined };

export function campaignSignupOrigin(env: CampaignSignupEnv = process.env): string | null {
  const raw = (env.CAMPAIGN_SIGNUP_ORIGIN ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) return null;
  return parsed.origin;
}

export function funnelUpdatesUrl(funnel: FunnelDefinition, env: CampaignSignupEnv = process.env): string | null {
  const origin = campaignSignupOrigin(env);
  if (!origin || !funnel.updates) return null;
  return `${origin}/signup/${funnel.updates.programKey}`;
}
