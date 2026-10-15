import { NO_MARKETING_SIGNUP, type MarketingSignupDirectory } from '@/lib/marketingSignupLink';

/**
 * Which practice, if any, may show "Get updates" on these program pages. The campaign engine (workstream 2)
 * answers from its own commercial store: the practice must hold the `marketing` entitlement and offer the
 * program's list. Here, without the engine, the answer is always "none", so no page shows the link.
 */
export function marketingSignupDirectory(): MarketingSignupDirectory {
  return NO_MARKETING_SIGNUP;
}
