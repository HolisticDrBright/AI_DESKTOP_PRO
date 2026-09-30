import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { OutcomeRecordView, type OutcomeRecordState } from './OutcomeRecordView';

/**
 * Recording what happened, for counting later.
 *
 * The assertions are about the promises this screen makes on the clinic's behalf. It must say
 * what is not kept. It must say this needs its own consent. It must not offer a free-text field
 * anywhere, because a sentence about a person in the counted ledger is the failure the whole
 * design is arranged around.
 */
const vocabulary = [
  { kind: 'condition' as const, code: 'hypothyroid', label: 'Hypothyroidism', status: 'active' as const },
  { kind: 'treatment' as const, code: 'thyroid_support', label: 'Fictional thyroid support', status: 'active' as const },
  { kind: 'treatment' as const, code: 'retired_one', label: 'Retired treatment', status: 'retired' as const },
];
const draft: OutcomeRecordState['draft'] = { ageYears: '47', sex: 'female',
  conditionCodes: ['hypothyroid'], treatmentCode: 'thyroid_support', outcomeCode: 'improved',
  followupBand: '3_to_6_months' };
const view = (over: Partial<OutcomeRecordState> = {}) => createElement(OutcomeRecordView, {
  state: { vocabulary, draft, recorded: null, consentAbsent: false, busy: false, error: null,
    onDraft: () => {}, onRecord: () => {}, ...over },
});
const isDisabled = (markup: string, testid: string) =>
  new RegExp(`data-testid="${testid}"[^>]*disabled=""|disabled=""[^>]*data-testid="${testid}"`).test(markup);

describe('recording an outcome', () => {
  it('says what is not kept, including the exact age', () => {
    const text = renderToText(view());
    expect(text).toContain('No name, no note, no date and no exact age are kept');
    expect(text).toContain('banded to five years before it is stored');
    expect(text).toContain('everyone over 89 is stored as one band');
  });

  it('says this needs its own consent and can be taken back', () => {
    const text = renderToText(view());
    expect(text).toContain('Agreeing to care is not agreeing to this');
    expect(text).toContain('deletes what was contributed');
  });

  it('has no free-text field anywhere in it', () => {
    const markup = renderToMarkup(view());
    expect(markup).not.toContain('<textarea');
    // The one text input is the age, and it is numeric.
    expect(markup.match(/<input(?![^>]*type="checkbox")/g)).toHaveLength(1);
    expect(markup).toContain('data-testid="outcome-record-age"');
  });

  it('offers only declared, unretired codes', () => {
    const markup = renderToMarkup(view());
    expect(markup).toContain('Fictional thyroid support');
    expect(markup).not.toContain('Retired treatment');
  });

  it('will not record without an age, a condition and a treatment', () => {
    expect(isDisabled(renderToMarkup(view()), 'outcome-record-save')).toBe(false);
    for (const patch of [{ ageYears: '' }, { ageYears: '17' }, { ageYears: 'forty' },
      { conditionCodes: [] }, { treatmentCode: '' }]) {
      expect(isDisabled(renderToMarkup(view({ draft: { ...draft, ...patch } })), 'outcome-record-save'), JSON.stringify(patch))
        .toBe(true);
    }
  });

  it('explains a refused contribution as a missing consent rather than a failure', () => {
    const text = renderToText(view({ consentAbsent: true }));
    expect(text).toContain('has not agreed to be counted, so nothing was recorded');
  });

  it('says which band was stored once something is recorded', () => {
    const recorded = { action: 'contribute' as const, observationId: '00000000-0000-4000-8000-000000000001',
      ageBand: '90_plus' as const, stored: { exactAgeKept: false as const, freeTextKept: false as const, dateKept: false as const } };
    expect(renderToText(view({ recorded }))).toContain('Recorded in the 90 and over band');
  });

  it('says why nothing can be recorded before any code is declared', () => {
    const text = renderToText(view({ vocabulary: [] }));
    expect(text).toContain('has not declared the conditions and treatments it counts by');
    expect(renderToMarkup(view({ vocabulary: [] }))).not.toContain('data-testid="outcome-record-save"');
  });
});
