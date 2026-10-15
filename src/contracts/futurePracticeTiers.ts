/**
 * Owner's 2026-10-14 Desktop tier proposal, not a live SaaS entitlement.
 * All entries remain blocked until provider-backed billing, organization-scoped
 * entitlements, reviewed terms, usage metering and hosted acceptance exist.
 */
export type FuturePracticeTierId = 'essentials_future' | 'growth_future' | 'complete_future';
export type FuturePracticeAddOnId =
  | 'marketing_future' | 'single_program_future' | 'all_programs_future'
  | 'extra_practitioner_future' | 'text_pack_future' | 'sponsored_v2_future';

export type FuturePracticeTierCandidate = Readonly<{
  id: FuturePracticeTierId;
  releaseState: 'blocked';
  billingProductRef: null;
  reviewedReleaseRef: null;
  includedPractitioners: number;
  includedPrograms: 0 | 1 | 'all';
  includedMonthlyTexts: number;
  includedSponsoredBasicSeats: number;
  marketingEnabled: boolean;
  includedMarketingContacts: number;
  includedMonthlyMarketingEmails: number;
}>;

export const FUTURE_PRACTICE_TIER_CANDIDATES: readonly FuturePracticeTierCandidate[] = [
  {
    id: 'essentials_future', releaseState: 'blocked', billingProductRef: null,
    reviewedReleaseRef: null, includedPractitioners: 1, includedPrograms: 0,
    includedMonthlyTexts: 0, includedSponsoredBasicSeats: 0,
    marketingEnabled: false, includedMarketingContacts: 0,
    includedMonthlyMarketingEmails: 0,
  },
  {
    id: 'growth_future', releaseState: 'blocked', billingProductRef: null,
    reviewedReleaseRef: null, includedPractitioners: 2, includedPrograms: 1,
    includedMonthlyTexts: 500, includedSponsoredBasicSeats: 0,
    marketingEnabled: true, includedMarketingContacts: 10_000,
    includedMonthlyMarketingEmails: 50_000,
  },
  {
    id: 'complete_future', releaseState: 'blocked', billingProductRef: null,
    reviewedReleaseRef: null, includedPractitioners: 3, includedPrograms: 'all',
    includedMonthlyTexts: 2_000, includedSponsoredBasicSeats: 25,
    marketingEnabled: true, includedMarketingContacts: 25_000,
    includedMonthlyMarketingEmails: 50_000,
  },
];

export const FUTURE_PRACTICE_ADD_ON_CANDIDATES: readonly Readonly<{
  id: FuturePracticeAddOnId;
  releaseState: 'blocked';
  billingProductRef: null;
  reviewedReleaseRef: null;
}>[] = [
  'marketing_future', 'single_program_future', 'all_programs_future',
  'extra_practitioner_future', 'text_pack_future', 'sponsored_v2_future',
].map(id => ({ id: id as FuturePracticeAddOnId, releaseState: 'blocked',
  billingProductRef: null, reviewedReleaseRef: null }));

/** The proposal cannot grant organization access or start checkout. */
export function futurePracticeTierIsOfferable(_id: FuturePracticeTierId | FuturePracticeAddOnId): false {
  return false;
}
