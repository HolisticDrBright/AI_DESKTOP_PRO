import type { FunnelDefinition } from '@/funnels';
import { publicSiteOrigin } from '@/lib/publicSite';

/**
 * The "Get updates about this program" address: the offering practice's own sign-up page,
 * `/join/<practice>/<program>`, served by this Desktop (workstream 2's campaign engine).
 *
 * Shown only when a directory says a practice offering this program's list holds the `marketing`
 * entitlement. Without that answer there is no link at all: an unset, unentitled or unreadable directory
 * all hide it, because a link to a sign-up page that refuses the visitor is worse than no link.
 *
 * The page stays a page: no form, script or cross-site request is added, and nothing about the visitor is
 * read or kept. The link is same-origin, so the content security policy does not change.
 */
export type MarketingSignupDirectory = { practiceFor(programKey: string): Promise<{ practiceSlug: string } | null> };

/** No practice holds the marketing entitlement (the engine is not on this branch, or is switched off). */
export const NO_MARKETING_SIGNUP: MarketingSignupDirectory = Object.freeze({ async practiceFor() { return null; } });

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** `/join/<practice>/<program>`, or null for anything that is not two plain slugs. */
export function joinPath(practiceSlug: string, programKey: string): string | null {
  return SLUG.test(practiceSlug) && SLUG.test(programKey) ? `/join/${practiceSlug}/${programKey}` : null;
}

export type SiteEnv = { readonly [key: string]: string | undefined };

export async function funnelUpdatesUrl(funnel: FunnelDefinition, directory: MarketingSignupDirectory, env: SiteEnv = process.env): Promise<string | null> {
  if (!funnel.updates) return null;
  let practice: { practiceSlug: string } | null;
  try { practice = await directory.practiceFor(funnel.updates.programKey); } catch { return null; }
  if (!practice) return null;
  const path = joinPath(practice.practiceSlug, funnel.updates.programKey);
  if (!path) return null;
  const origin = publicSiteOrigin(env);
  return origin ? origin + path : path;
}
