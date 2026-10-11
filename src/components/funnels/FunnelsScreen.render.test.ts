import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { describeHandoff, FunnelsView, type ConsultLinkState, type LinkRead } from './FunnelsScreen';
import { FUNNELS, type FunnelDefinition } from '@/funnels';
import { longevityProgram } from '@/funnels/definitions/longevity-program';

/**
 * The staff Funnels screen as rendered: no public address says so instead of printing a link
 * that would not work; a failed link read is a failure, not "no links"; a published funnel that
 * points at a missing, disabled or paused link is called out; a draft is told it has no public
 * page.
 */
const link = (over: Partial<ConsultLinkState> = {}): ConsultLinkState => ({ linkId: '70000000-0000-4000-8000-000000000001', slug: 'longevity-program', label: 'Longevity consult', status: 'active', acceptingRequests: true, openRequests: 2, ...over });
const published = (): FunnelDefinition => ({ ...structuredClone(longevityProgram), status: 'published', draftNote: null, approval: { by: 'Brandon Bright', on: '2026-10-11', attorneyReview: false } });
const noop = () => undefined;
const view = (read: LinkRead, origin: string | null = 'https://clinic.fictional.example', funnels: readonly FunnelDefinition[] = FUNNELS) =>
  createElement(FunnelsView, { funnels, read, origin, onRetry: noop });

describe('the hand-off description', () => {
  it('reads the link list, not assumptions', () => {
    expect(describeHandoff(published(), { state: 'loading' })).toMatchObject({ tone: 'unknown' });
    expect(describeHandoff(published(), { state: 'failed' })).toMatchObject({ tone: 'unknown', text: expect.stringContaining('could not be read') });
    expect(describeHandoff(published(), { state: 'read', links: [] })).toMatchObject({ tone: 'warning', text: expect.stringContaining('No consult link with slug "longevity-program"') });
    expect(describeHandoff(published(), { state: 'read', links: [link({ status: 'disabled' })] })).toMatchObject({ tone: 'warning', text: expect.stringContaining('disabled') });
    expect(describeHandoff(published(), { state: 'read', links: [link({ acceptingRequests: false })] })).toMatchObject({ tone: 'warning', text: expect.stringContaining('paused') });
    expect(describeHandoff(published(), { state: 'read', links: [link()] })).toEqual({ tone: 'ok', text: 'Hands off to "Longevity consult", active and accepting requests; 2 waiting.' });
    // A draft pointing at a missing link is a thing to do before publishing, not a warning that visitors are stranded.
    expect(describeHandoff(longevityProgram, { state: 'read', links: [] })).toMatchObject({ tone: 'unknown', text: expect.stringContaining('Create it before publishing') });
  });
});

describe('the Funnels screen', () => {
  it('says when no public address is configured and shows paths instead of links', () => {
    const element = view({ state: 'read', links: [link()] }, null);
    const text = renderToText(element);
    expect(renderToMarkup(element)).toContain('data-testid="funnels-no-origin"');
    expect(text).toContain('No public web address is configured for this deployment');
    expect(text).toContain('/learn/longevity-program (no public address configured)');
    expect(text).toContain('/consult/longevity-program (no public address configured)');
    expect(renderToMarkup(element)).not.toMatch(/https?:\/\//);
  });
  it('shows a failed link read as a failure that is different from an empty list', () => {
    const failed = view({ state: 'failed' });
    expect(renderToMarkup(failed)).toContain('data-testid="funnels-links-failed"');
    expect(renderToText(failed)).toContain('The consult link list could not be read. Nothing below says whether a link exists.');
    const empty = view({ state: 'read', links: [] });
    expect(renderToMarkup(empty)).not.toContain('funnels-links-failed');
    expect(renderToText(empty)).toContain('No consult link with slug "longevity-program" exists. Create it before publishing.');
  });
  it('shows every funnel with its status, its public and consult addresses, and its draft note', () => {
    const element = view({ state: 'read', links: [link()] });
    const text = renderToText(element);
    const markup = renderToMarkup(element);
    for (const funnel of FUNNELS) {
      expect(markup).toContain(`data-testid="funnel-${funnel.slug}" data-status="draft"`);
      expect(text).toContain(`https://clinic.fictional.example/learn/${funnel.slug}`);
      expect(text).toContain(`https://clinic.fictional.example/consult/${funnel.consultSlug}`);
      expect(text).toContain(funnel.draftNote!);
    }
    expect(text).toContain('Draft: not public');
    expect(text).toContain('A draft has no public page');
    expect(text).toContain('may be listed by search engines on the production origin');
    expect(markup).not.toContain('Open the public page');
  });
  it('warns loudly when a published funnel points at a missing, disabled or paused link, and offers the public page when it is live', () => {
    const live = view({ state: 'read', links: [link()] }, 'https://clinic.fictional.example', [published()]);
    expect(renderToMarkup(live)).toContain('data-handoff="ok"');
    expect(renderToMarkup(live)).toContain('Open the public page');
    for (const links of [[], [link({ status: 'disabled' })], [link({ acceptingRequests: false })]]) {
      const element = view({ state: 'read', links }, 'https://clinic.fictional.example', [published()]);
      expect(renderToMarkup(element)).toContain('data-handoff="warning"');
      expect(renderToText(element)).toMatch(/A published funnel points at it|Visitors who follow this published page reach nothing/);
    }
    expect(renderToText(view({ state: 'read', links: [] }, 'https://clinic.fictional.example', [published()]))).toContain('Visitors who follow this published page reach nothing.');
  });
});
