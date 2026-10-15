import { describe, expect, it } from 'vitest';
import { requestSource } from './ConsultRequestQueue';

/**
 * A request in the queue names where it came from, from its link's slug alone: the program page and the
 * channel, or the link itself when no program page uses it. Nothing new is recorded to say so.
 */
describe('where a consult request came from', () => {
  it('names the program page and channel for a funnel link, and the link otherwise', () => {
    expect(requestSource('longevity-program')).toBe('Longevity Program page · web');
    expect(requestSource('longevity-program-email')).toBe('Longevity Program page · email');
    expect(requestSource('diabetes-program-email')).toMatch(/ page · email$/);
    expect(requestSource('fictional-clinic-link')).toBe('link fictional-clinic-link');
  });
});
