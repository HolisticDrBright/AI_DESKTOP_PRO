import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { describeChannelLink, describeHandoff, FunnelsView, type ConsultLinkState, type LinkRead } from './FunnelsScreen';
import type { QueueRead } from './funnelRequestCounts';
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

describe('requests per program and channel on the Funnels screen', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const read: LinkRead = { state: 'read', links: [link(), link({ linkId: '70000000-0000-4000-8000-000000000002', slug: 'longevity-program-email', label: 'Longevity consult (email)', openRequests: 1 })] };
  const queue: QueueRead = { state: 'read', requests: [
    { slug: 'longevity-program', receivedAt: ago(1) }, { slug: 'longevity-program', receivedAt: ago(12) },
    { slug: 'longevity-program-email', receivedAt: ago(3) }, { slug: 'diabetes-program-email', receivedAt: ago(40) },
  ] };
  const screen = (q: QueueRead, updatesOrigin: string | null = null, links: LinkRead = read) =>
    createElement(FunnelsView, { funnels: FUNNELS, read: links, queue: q, origin: 'https://clinic.fictional.example', updatesOrigin, now, onRetry: noop });

  it('counts requests per channel for the last 7 and 30 days, and shows counts only', () => {
    const element = screen(queue);
    const markup = renderToMarkup(element);
    expect(markup).toContain('data-testid="funnel-counts-longevity-program" data-counts="read"');
    expect(renderToText(createElement('div', null, element))).toMatch(/web \(longevity-program\)\s*1\s*2/);
    expect(renderToText(element)).toMatch(/email \(longevity-program-email\)\s*1\s*1/);
    // The diabetes email request is 40 days old: outside both windows.
    expect(renderToText(element)).toMatch(/email \(diabetes-program-email\)\s*0\s*0/);
    expect(markup).not.toMatch(/reference|@|receivedAt/);
  });
  it('shows a queue that could not be read as a failure, never as zero requests', () => {
    const failed = screen({ state: 'failed' });
    expect(renderToMarkup(failed)).toContain('data-testid="funnels-queue-failed"');
    expect(renderToMarkup(failed)).toContain('data-counts="failed"');
    expect(renderToText(failed)).toContain('Requests could not be counted: the queue could not be read. This is not the same as no requests.');
    expect(renderToText(failed)).not.toMatch(/Last 7 days/);
    const empty = screen({ state: 'read', requests: [] });
    expect(renderToMarkup(empty)).not.toContain('funnels-queue-failed');
    expect(renderToText(empty)).toMatch(/web \(longevity-program\)\s*0\s*0/);
  });
  it('reads each program\'s email link from the link list, and says when it does not exist yet', () => {
    expect(describeChannelLink(longevityProgram, 'longevity-program-email', read)).toEqual({ tone: 'ok', text: '"Longevity consult (email)", active and accepting requests; 1 waiting.' });
    expect(describeChannelLink(longevityProgram, 'longevity-program-email', { state: 'read', links: [] })).toMatchObject({ tone: 'unknown', text: expect.stringContaining('Create it through the link administration') });
    expect(describeChannelLink(published(), 'longevity-program-email', { state: 'read', links: [] })).toMatchObject({ tone: 'warning' });
    expect(describeChannelLink(longevityProgram, 'longevity-program-email', { state: 'failed' })).toMatchObject({ tone: 'unknown', text: expect.stringContaining('could not be read') });
    expect(renderToText(screen(queue))).toContain('Email link: No consult link with slug "weight-loss-program-email" exists.');
  });
  it('says whether each page shows "Get updates", from the sign-up origin the server read', () => {
    const off = screen(queue);
    expect(renderToMarkup(off)).toContain('data-testid="funnels-no-updates-origin"');
    expect(renderToText(off)).toContain('Get updates: not shown on the page; the campaign sign-up address is not configured.');
    const on = screen(queue, 'https://updates.fictional.example');
    expect(renderToMarkup(on)).not.toContain('funnels-no-updates-origin');
    for (const funnel of FUNNELS) expect(renderToText(on)).toContain(`Get updates: https://updates.fictional.example/signup/${funnel.updates!.programKey}`);
  });
});
