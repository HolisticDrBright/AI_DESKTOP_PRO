import { describe, expect, it } from 'vitest';
import {
  FUTURE_PRACTICE_ADD_ON_CANDIDATES, FUTURE_PRACTICE_TIER_CANDIDATES,
  futurePracticeTierIsOfferable,
} from './futurePracticeTiers';

describe('blocked future practice tiers', () => {
  it('records three distinct tiers and leaves every provider product and release unset', () => {
    expect(FUTURE_PRACTICE_TIER_CANDIDATES.map(tier => tier.id)).toEqual([
      'essentials_future', 'growth_future', 'complete_future',
    ]);
    for (const candidate of [...FUTURE_PRACTICE_TIER_CANDIDATES, ...FUTURE_PRACTICE_ADD_ON_CANDIDATES]) {
      expect(candidate.releaseState).toBe('blocked');
      expect(candidate.billingProductRef).toBeNull();
      expect(candidate.reviewedReleaseRef).toBeNull();
      expect(futurePracticeTierIsOfferable(candidate.id)).toBe(false);
    }
  });

  it('records the proposed seat, program, text and sponsorship quantities without granting access', () => {
    expect(FUTURE_PRACTICE_TIER_CANDIDATES.map(tier => [
      tier.includedPractitioners, tier.includedPrograms, tier.includedMonthlyTexts,
      tier.includedSponsoredBasicSeats,
    ])).toEqual([[1, 0, 0, 0], [2, 1, 500, 0], [3, 'all', 2_000, 25]]);
    expect(FUTURE_PRACTICE_TIER_CANDIDATES.every(tier => !futurePracticeTierIsOfferable(tier.id))).toBe(true);
  });

  it('keeps every proposed add-on separate and blocked', () => {
    expect(FUTURE_PRACTICE_ADD_ON_CANDIDATES.map(addOn => addOn.id)).toEqual([
      'marketing_future', 'single_program_future', 'all_programs_future',
      'extra_practitioner_future', 'text_pack_future', 'sponsored_v2_future',
    ]);
  });
});
