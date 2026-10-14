import { consultSlugFor, funnelChannelFrom, type FunnelDefinition } from '@/funnels';
import { consultLinkUrl } from '@/lib/consultLinkUrl';
import { funnelUpdatesUrl, type CampaignSignupEnv } from '@/lib/campaignSignupUrl';
import { publicSiteOrigin } from '@/lib/publicSite';

/**
 * The outbound addresses of one rendering of a funnel page, decided on the server from the definition,
 * configuration and the `?via=` value alone.
 *
 * `via` chooses which consult link the button points at (an email visitor reaches the program's email
 * link) and does nothing else: it is not returned, stored, logged or put in a cookie, and an unknown value
 * is the web. The updates link is the campaign service's sign-up page, or null when
 * `CAMPAIGN_SIGNUP_ORIGIN` is unset.
 */
export function funnelPageLinks(funnel: FunnelDefinition, via: unknown, env: CampaignSignupEnv = process.env): { consultHref: string; updatesUrl: string | null } {
  const consultSlug = consultSlugFor(funnel, funnelChannelFrom(via));
  return {
    consultHref: consultLinkUrl(consultSlug, publicSiteOrigin(env) ?? undefined) ?? `/consult/${consultSlug}`,
    updatesUrl: funnelUpdatesUrl(funnel, env),
  };
}
