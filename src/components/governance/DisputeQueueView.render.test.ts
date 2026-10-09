import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { DisputeQueueView, type DisputeQueueState } from './DisputeQueueView';

/**
 * The practitioner's view of what the practice got wrong.
 *
 * The assertions that matter are about not hiding things: a resolved disagreement stays
 * listed, and an unacknowledged safety withdrawal is called out rather than shown as delivered
 * and left at that.
 */
const uuid = (n: number) => 'c0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const dispute = (over: Record<string, unknown> = {}) => ({
  disputeId: uuid(1), connectionId: uuid(2), subjectKind: 'program_assignment' as const,
  subjectId: uuid(3), reasonCode: 'not_true_of_me' as const, status: 'open' as const,
  resolution: null, clinicianResponse: null, raisedAt: '2026-09-30T10:00:00.000Z',
  acknowledgedAt: null, resolvedAt: null, revision: '1',
  statements: [{ body: 'I have never had a thyroid problem.', statedAt: '2026-09-30T10:00:00.000Z' }],
  ...over,
});
const notice = (over: Record<string, unknown> = {}) => ({
  noticeId: uuid(4), connectionId: uuid(2), assignmentId: uuid(3),
  revisionClass: 'correction' as const, itemsAdded: 1, itemsRemoved: 0, itemsChanged: 1,
  statement: null, status: 'delivered' as const, createdAt: '2026-09-30T10:00:00.000Z',
  acknowledgedAt: null, ...over,
});
const view = (over: Partial<DisputeQueueState> = {}) => createElement(DisputeQueueView, {
  state: {
    disputes: [], notices: [], busy: false, error: null,
    onAcknowledge: () => {}, onResolve: () => {}, ...over,
  } as DisputeQueueState,
});

describe('contested records, as the practice sees them', () => {
  it('shows what the patient actually said and what answering requires', () => {
    const text = renderToText(view({ disputes: [dispute()] }));
    expect(text).toContain('I have never had a thyroid problem');
    expect(text).toContain('Not true of them');
    expect(text).toContain('Answering requires a written response, which the patient sees');
    expect(renderToMarkup(view({ disputes: [dispute()] }))).toContain('data-testid="dispute-resolve-upheld"');
  });

  it('keeps an answered disagreement on the record instead of clearing it', () => {
    const resolved = dispute({
      status: 'resolved', resolution: 'upheld', resolvedAt: '2026-09-30T11:00:00.000Z',
      acknowledgedAt: '2026-09-30T10:30:00.000Z', revision: '3',
      clinicianResponse: 'The finding stands, and the disagreement is recorded with it.',
    });
    const markup = renderToMarkup(view({ disputes: [resolved] }));
    expect(markup).toContain('data-testid="dispute-answered"');
    expect(renderToText(view({ disputes: [resolved] })))
      .toContain('stays attached to the record. It is not removed by being answered');
    // And it is not counted as still waiting.
    expect(markup).not.toContain('data-testid="dispute-row"');
  });

  it('calls out a safety withdrawal the patient has not acknowledged', () => {
    const unacknowledged = notice({ revisionClass: 'safety_withdrawal', status: 'delivered', itemsRemoved: 1 });
    const markup = renderToMarkup(view({ notices: [unacknowledged] }));
    expect(markup).toContain('data-testid="notice-unacknowledged-safety"');
    expect(renderToText(view({ notices: [unacknowledged] }))).toContain('Contact them directly');
    const done = notice({ revisionClass: 'safety_withdrawal', status: 'acknowledged', acknowledgedAt: '2026-09-30T12:00:00.000Z' });
    expect(renderToMarkup(view({ notices: [done] }))).not.toContain('data-testid="notice-unacknowledged-safety"');
  });

  it('says nothing reaches a patient automatically when no revision was announced', () => {
    expect(renderToText(view())).toContain('nothing reaches them automatically');
  });

  it('separates loading from empty on both halves', () => {
    const markup = renderToMarkup(view({ disputes: null, notices: null }));
    expect(markup).toContain('data-testid="dispute-queue-loading"');
    expect(markup).toContain('data-testid="notice-loading"');
    expect(markup).not.toContain('data-testid="dispute-queue-empty"');
  });
});
