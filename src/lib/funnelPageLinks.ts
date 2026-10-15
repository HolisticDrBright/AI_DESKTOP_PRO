import { consultSlugFor, funnelChannelFrom, type FunnelDefinition } from '@/funnels';
import { consultLinkUrl } from '@/lib/consultLinkUrl';
import { funnelUpdatesUrl, type MarketingSignupDirectory, type SiteEnv } from '@/lib/marketingSignupLink';
import { publicSiteOrigin } from '@/lib/publicSite';

/**
 * The outbound addresses of one rendering of a funnel page, decided on the server from the definition,
 * configuration, the marketing directory and the `?via=` value alone.
 *
 * `via` chooses which consult link the button points at (an email visitor reaches the program's email
 * link) and does nothing else: it is not returned, stored, logged or put in a cookie, and an unknown value
 * is the web. The updates link is the offering practice's `/join/<practice>/<program>` page, or null when
 * no practice offering the list holds the `marketing` entitlement.
 */
export async function funnelPageLinks(funnel: FunnelDefinition, via: unknown, directory: MarketingSignupDirectory, env: SiteEnv = process.env): Promise<{ consultHref: string; updatesUrl: string | null }> {
  const consultSlug = consultSlugFor(funnel, funnelChannelFrom(via));
  return {
    consultHref: consultLinkUrl(consultSlug, publicSiteOrigin(env) ?? undefined) ?? `/consult/${consultSlug}`,
    updatesUrl: await funnelUpdatesUrl(funnel, directory, env),
  };
}
