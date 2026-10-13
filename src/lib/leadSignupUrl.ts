import { LEAD_PROGRAMS, type LeadProgram } from '@/contracts/leadCampaigns';

/**
 * The address of a program's sign-up page, which belongs to the campaign service (not this web tier):
 * its own https origin, set by LEAD_SIGNUP_ORIGIN, plus /signup/<program>. With no origin configured, or
 * for a funnel that has no list, there is no link: the funnel page then shows only its consult (and buy)
 * choices.
 */
export function leadSignupUrl(slug: string, origin: string | undefined): string | null {
  if (!LEAD_PROGRAMS.includes(slug as LeadProgram)) return null;
  let parsed: URL;
  try { parsed = new URL((origin ?? '').trim()); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  return `${parsed.origin}/signup/${slug}`;
}
