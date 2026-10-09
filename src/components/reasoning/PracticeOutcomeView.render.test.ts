import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { OutcomeReportResponse } from '@/contracts/practiceOutcomes';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { PracticeOutcomeView, type PracticeOutcomeState } from './PracticeOutcomeView';

/**
 * What happened in this practice, counted.
 *
 * The assertions are about the two ways a screen like this misleads. It must never read as
 * evidence that a treatment works, and it must never put a total beside a withheld cell — with
 * both, the withheld numbers come back by subtraction.
 */
const report = (over: Partial<OutcomeReportResponse> = {}): OutcomeReportResponse => ({
  action: 'report',
  groups: [
    { outcome: 'improved', treatment: 'thyroid_support', ageBand: null, sex: null, followupBand: null, count: 14 },
    { outcome: 'unchanged', treatment: 'thyroid_support', ageBand: null, sex: null, followupBand: null, count: 12 },
  ],
  suppressedGroups: 0, total: 26, minimumCohort: 11,
  interpretation: 'what_happened_in_this_practice_not_evidence_of_efficacy', ...over,
});
const view = (over: Partial<PracticeOutcomeState> = {}) => createElement(PracticeOutcomeView, {
  state: { report: null, groupBy: ['treatment'], busy: false, error: null,
    onGroupBy: () => {}, onRun: () => {}, ...over },
});

describe('reporting practice outcomes', () => {
  it('says this is not evidence a treatment works, before any number', () => {
    const text = renderToText(view({ report: report() }));
    expect(text).toContain('It is not evidence that a treatment works');
    expect(text.indexOf('It is not evidence that a treatment works')).toBeLessThan(text.indexOf('14'));
    // And says so with nothing on screen yet, not only once counts arrive.
    expect(renderToText(view())).toContain('It is not evidence that a treatment works');
  });

  it('never claims anything was proven', () => {
    expect(renderToText(view({ report: report() }))).not.toMatch(/proven|proves|works best|shown to work|effective/i);
  });

  it('shows a total only when nothing was withheld', () => {
    expect(renderToText(view({ report: report() }))).toContain('26 people in total, with nothing withheld');
    const withheld = report({ suppressedGroups: 2, total: null });
    const text = renderToText(view({ report: withheld }));
    expect(text).toContain('2 groups are not shown');
    expect(text).toContain('you could work the withheld numbers out by subtraction');
    expect(text).not.toContain('in total');
  });

  it('separates a cohort too small to report from no outcomes at all', () => {
    const text = renderToText(view({ report: report({ groups: [], suppressedGroups: 1, total: null }) }));
    expect(text).toContain('too few to report');
    expect(text).toContain('Not enough people yet');
    expect(renderToMarkup(view({ report: report({ groups: [], suppressedGroups: 1, total: null }) })))
      .not.toContain('data-testid="practice-outcomes-row"');
  });

  it('stops at two breakdowns', () => {
    const markup = renderToMarkup(view({ groupBy: ['treatment', 'ageBand'] }));
    // The two chosen stay available to untick; the two unchosen are closed off.
    expect(/data-testid="practice-outcomes-dimension-sex"[^>]*disabled=""/.test(markup)).toBe(true);
    expect(/data-testid="practice-outcomes-dimension-followupBand"[^>]*disabled=""/.test(markup)).toBe(true);
    expect(/data-testid="practice-outcomes-dimension-treatment"[^>]*disabled=""/.test(markup)).toBe(false);
  });

  it('draws one row per reported group and no row for a withheld one', () => {
    const markup = renderToMarkup(view({ report: report({ suppressedGroups: 3, total: null }) }));
    expect(markup.match(/data-testid="practice-outcomes-row"/g)).toHaveLength(2);
  });
});
