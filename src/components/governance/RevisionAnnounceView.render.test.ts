import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { RevisionAnnounceView, type RevisionAnnounceState } from './RevisionAnnounceView';

/**
 * Announcing a revision to the people already holding an older version.
 *
 * The assertions are about not misleading the practitioner: publishing does not re-send the
 * program, a count is shown before anything goes out, and a safety withdrawal cannot be sent
 * with no words in it.
 */
const uuid = (n: number) => 'd0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const preview = (affected: number) => ({
  action: 'preview' as const, toVersionId: uuid(1), affected,
  assignments: Array.from({ length: affected }, (_unused, index) => ({
    assignmentId: uuid(10 + index), connectionId: uuid(50 + index), fromVersion: 1,
    itemsAdded: 1, itemsRemoved: 1, itemsChanged: 1,
  })),
});
const view = (over: Partial<RevisionAnnounceState> = {}) => createElement(RevisionAnnounceView, {
  state: {
    preview: null, revisionClass: 'correction', statement: '', busy: false, error: null, notice: null,
    onPreview: () => {}, onClass: () => {}, onStatement: () => {}, onPublish: () => {}, ...over,
  } as RevisionAnnounceState,
});

describe('announcing a revision', () => {
  it('says publishing does not change what a patient already holds', () => {
    const text = renderToText(view());
    expect(text).toContain('Their copy is never changed underneath them');
    expect(text).toContain('you re-share the new version separately');
  });

  it('shows the count before anything is sent', () => {
    const text = renderToText(view({ preview: preview(3) }));
    expect(text).toContain('3 patients hold an older version');
    expect(renderToMarkup(view({ preview: preview(3) }))).toContain('Notify 3 patients');
  });

  it('offers nothing to send when nobody is on an older version', () => {
    const markup = renderToMarkup(view({ preview: preview(0) }));
    expect(markup).toContain('data-testid="revision-none-affected"');
    expect(markup).not.toContain('data-testid="revision-publish"');
  });

  it('will not send a safety withdrawal with no words in it', () => {
    const empty = view({ preview: preview(1), revisionClass: 'safety_withdrawal', statement: '  ' });
    // `disabled=""` is the attribute. Matching bare "disabled" would also match Tailwind's
    // `disabled:opacity-50` class and pass whatever the button's real state was.
    expect(renderToMarkup(empty)).toMatch(/data-testid="revision-publish"[^>]*disabled=""/);
    expect(renderToText(empty)).toContain('asks the patient to confirm they have read it');
    const filled = view({ preview: preview(1), revisionClass: 'safety_withdrawal', statement: 'Stop the phase-one supplement.' });
    expect(renderToMarkup(filled)).not.toMatch(/data-testid="revision-publish"[^>]*disabled=""/);
  });

  it('does not warn about acknowledgement for an ordinary correction', () => {
    expect(renderToMarkup(view({ preview: preview(1), revisionClass: 'correction' })))
      .not.toContain('data-testid="revision-safety-warning"');
  });
});
