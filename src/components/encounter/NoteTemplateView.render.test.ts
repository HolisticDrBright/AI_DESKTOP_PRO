import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PRACTICE_NOTE_STYLE } from '@/contracts/noteTemplates';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';

import { NoteTemplateView, type NoteTemplateState } from './NoteTemplateView';

/**
 * The practitioner's own note layout, and the house style a draft is written in.
 *
 * The assertions are about not misleading the practitioner. Guidance must not look like it can
 * make a draft state something the visit did not. A published version must not look editable.
 * A duplicate section key must be refused before it is sent, because a draft is matched to keys
 * and a duplicate could never be filled. And asking a draft to see more of the chart must say
 * both that it is a wider disclosure and whether it can actually be supplied.
 */
const sections = [
  { key: 'STORY', label: 'Their story', guidance: 'Their own words first.' },
  { key: 'FIND', label: 'What I found', guidance: null },
];
const state = (over: Partial<NoteTemplateState> = {}): NoteTemplateState => ({
  templateId: null, publishedVersion: null, draftDigest: null,
  draft: { name: 'My layout', sections }, style: DEFAULT_PRACTICE_NOTE_STYLE,
  contextAvailable: false, busy: false, error: null, notice: null,
  onDraft: () => {}, onStyle: () => {}, onSave: () => {}, onPublish: () => {}, onPublishStyle: () => {},
  ...over,
});
const view = (over: Partial<NoteTemplateState> = {}) =>
  createElement(NoteTemplateView, { state: state(over) });
/** Whether a button is really disabled. A bare `disabled` also matches `disabled:opacity-50`. */
const isDisabled = (markup: string, testid: string) =>
  new RegExp(`data-testid="${testid}"[^>]*disabled=""|disabled=""[^>]*data-testid="${testid}"`).test(markup);

describe('editing a note layout', () => {
  it('says guidance cannot make a draft state what the visit did not', () => {
    const text = renderToText(view());
    expect(text).toContain('it never lets a draft state something the visit did not');
    expect(text).toContain('comes back as a caution instead');
  });

  it('shows the version in force and does not offer to edit it', () => {
    const text = renderToText(view({ publishedVersion: 2, templateId: 'x' }));
    expect(text).toContain('Version 2 is in use');
    expect(text).toContain('Published versions are never edited');
    // Nothing to publish until a draft has been saved, whatever is on screen.
    expect(isDisabled(renderToMarkup(view({ publishedVersion: 2, templateId: 'x' })), 'note-template-publish')).toBe(true);
  });

  it('refuses a duplicate or malformed section key before anything is sent', () => {
    const duplicate = view({ draft: { name: 'My layout', sections: [sections[0], { ...sections[1], key: 'STORY' }] } });
    expect(renderToText(duplicate)).toContain('no two sections may share a key');
    expect(isDisabled(renderToMarkup(duplicate), 'note-template-save')).toBe(true);
    const blank = view({ draft: { name: 'My layout', sections: [{ key: '', label: '', guidance: null }] } });
    expect(isDisabled(renderToMarkup(blank), 'note-template-save')).toBe(true);
    // A valid layout with a name is savable; nothing about the published version blocks that.
    expect(isDisabled(renderToMarkup(view()), 'note-template-save')).toBe(false);
  });

  it('will not save a layout with no name', () => {
    expect(isDisabled(renderToMarkup(view({ draft: { name: '   ', sections } })), 'note-template-save')).toBe(true);
  });

  it('stops at eight sections and says why', () => {
    const eight = Array.from({ length: 8 }, (_unused, index) => ({ key: `K${index}`, label: `Section ${index}`, guidance: null }));
    const full = view({ draft: { name: 'My layout', sections: eight } });
    expect(renderToText(full)).toContain('Eight sections is the most a draft can fill');
    expect(isDisabled(renderToMarkup(full), 'note-template-add')).toBe(true);
  });

  it('does not offer to remove the only section', () => {
    const one = view({ draft: { name: 'My layout', sections: [sections[0]] } });
    expect(isDisabled(renderToMarkup(one), 'note-template-remove-0')).toBe(true);
  });
});

describe('the house style', () => {
  it('says the style is a closed set of choices', () => {
    expect(renderToText(view())).toContain('There is nowhere here to write an instruction');
  });

  it('says nothing about disclosure when a draft sees only the recording', () => {
    expect(renderToText(view())).not.toContain('sends more of the chart');
  });

  it('calls a wider context a wider disclosure, and says when it cannot be supplied', () => {
    const asked = view({ style: { ...DEFAULT_PRACTICE_NOTE_STYLE, contextBreadth: 'last_note' } });
    expect(renderToText(asked)).toContain('sends more of the chart to the drafting service');
    expect(renderToText(asked)).toContain('drafts will record that this context was withheld');
    const supplied = view({ contextAvailable: true, style: { ...DEFAULT_PRACTICE_NOTE_STYLE, contextBreadth: 'problem_list' } });
    expect(renderToText(supplied)).toContain('Every draft records what it was given');
    expect(renderToText(supplied)).not.toContain('was withheld');
  });
});
