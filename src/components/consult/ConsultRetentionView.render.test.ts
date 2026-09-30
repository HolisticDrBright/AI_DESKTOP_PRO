import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { ConsultRetentionView, type ConsultRetentionState } from './ConsultRetentionView';

/**
 * Erasing the contact details of an enquirer who never became a patient.
 *
 * The assertions are about the four things a practice could be misled into believing: that
 * enquiries expire on their own when no window is set; that erasing takes the whole record; that
 * a refused purge was a failure; and that a converted enquirer has no erasure path.
 */
const state = (over: Partial<ConsultRetentionState> = {}): ConsultRetentionState => ({
  window: null, counts: { purgeable: 2, stillHeld: 5, alreadyPurged: 1 }, draftDays: '',
  lastRefusal: null, busy: false, error: null, notice: null,
  onDraftDays: () => {}, onSetWindow: () => {}, onSweep: () => {}, ...over,
});
const view = (over: Partial<ConsultRetentionState> = {}) =>
  createElement(ConsultRetentionView, { state: state(over) });
const isDisabled = (markup: string, testid: string) =>
  new RegExp(`data-testid="${testid}"[^>]*disabled=""|disabled=""[^>]*data-testid="${testid}"`).test(markup);

describe('consult retention', () => {
  it('says nothing expires on its own when no window is set, and calls that a choice', () => {
    const text = renderToText(view());
    expect(text).toContain('nothing is ever erased automatically');
    expect(text).toContain('That is a choice, not a default');
    // And the sweep is not offered, because it would do nothing.
    const markup = renderToMarkup(view());
    expect(isDisabled(markup, 'consult-retention-sweep')).toBe(true);
    expect(markup).toContain('Nothing to sweep without a window');
  });

  it('says what a purge removes and what it keeps', () => {
    const text = renderToText(view());
    expect(text).toContain('removes the sealed contact envelope and keeps the rest of the row');
    expect(text).toContain('identifies nobody');
  });

  it('says a converted enquirer is covered by their own erasure', () => {
    expect(renderToText(view())).toContain('Their own erasure request reaches their enquiry');
  });

  it('shows a refusal as a reason to act on, not a failure', () => {
    const text = renderToText(view({ lastRefusal: 'still_open_and_no_retention_window_is_set' }));
    expect(text).toContain('Nothing was erased.');
    expect(text).toContain('Decline or accept it first, or set a retention window');
    // A refusal is not rendered as an error.
    expect(renderToMarkup(view({ lastRefusal: 'already_purged' })))
      .not.toContain('data-testid="consult-retention-error"');
  });

  it('describes a set window in days and offers the sweep', () => {
    const markup = renderToMarkup(view({ window: 60, draftDays: '60' }));
    expect(renderToText(view({ window: 60, draftDays: '60' })))
      .toContain('erasable 60 days after they arrive');
    expect(isDisabled(markup, 'consult-retention-sweep')).toBe(false);
    expect(isDisabled(markup, 'consult-retention-clear')).toBe(false);
  });

  it('will not save a window that is not a whole number of days in range', () => {
    for (const draftDays of ['', '0', '-1', '3651', 'sixty', '30.5']) {
      expect(isDisabled(renderToMarkup(view({ draftDays })), 'consult-retention-save'), draftDays).toBe(true);
    }
    expect(isDisabled(renderToMarkup(view({ draftDays: '30' })), 'consult-retention-save')).toBe(false);
  });

  it('reports how many are held, erasable and already gone', () => {
    expect(renderToText(view({ counts: { purgeable: 1, stillHeld: 1, alreadyPurged: 0 } })))
      .toContain('1 enquiry still hold contact details, 1 can be erased now, 0 already have been');
  });
});
