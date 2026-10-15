import { NO_MARKETING_SIGNUP, type MarketingSignupDirectory } from '@/lib/marketingSignupLink';
import { campaignApiCall, campaignEngineEnabled, funnelPracticeSlug } from '@/server/campaign-api';

/**
 * Which practice, if any, may show "Get updates" on these program pages: the practice named by FUNNEL_PRACTICE_SLUG,
 * and only while the campaign engine says its sign-up page for that program is open (the practice holds the
 * `marketing` entitlement and can send). Engine off, no practice named, or the engine unreachable: no link.
 */
export function marketingSignupDirectory(env: Readonly<Record<string, string | undefined>> = process.env): MarketingSignupDirectory {
  const practiceSlug = funnelPracticeSlug(env);
  if (!campaignEngineEnabled(env) || !practiceSlug) return NO_MARKETING_SIGNUP;
  return {
    async practiceFor(programKey) {
      try {
        const answer = await campaignApiCall<{ open: boolean }>({ method: 'GET', path: `/campaigns/public/signup-open/${practiceSlug}/${encodeURIComponent(programKey)}`, timeoutMs: 1500, env });
        return answer.open === true ? { practiceSlug } : null;
      } catch { return null; }
    },
  };
}
