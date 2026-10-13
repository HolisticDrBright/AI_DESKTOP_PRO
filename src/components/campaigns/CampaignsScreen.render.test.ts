import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { CampaignsView, type CampaignsRead } from './CampaignsScreen';

const counts = { contract: 'lead-campaigns/1' as const, lists: [{ program: 'longevity-program' as const, confirmed: 3 }, { program: 'weight-loss-peptide-program' as const, confirmed: 0 }, { program: 'diabetes-program' as const, confirmed: 1 }],
  recentSends: [{ name: 'Fictional broadcast', sentAt: '2026-10-12T16:00:00.000Z', delivered: 4, bounced: 1, unsubscribed: null }] };
const view = (read: CampaignsRead) => createElement(CampaignsView, { read, onRetry: () => {} });

describe('the Campaigns screen', () => {
  it('an unreachable service, an unconfigured one and an empty list are three different things on screen', () => {
    const failed = renderToText(view({ state: 'failed' })), off = renderToText(view({ state: 'not_configured' }));
    const empty = renderToText(view({ state: 'ok', counts: { ...counts, lists: counts.lists.map(l => ({ ...l, confirmed: 0 })), recentSends: [] }, dashboardUrl: null }));
    expect(failed).toContain('could not be reached. Nothing below says how many people are on a list');
    expect(failed).not.toContain('0 confirmed');
    expect(off).toContain('No campaign service is configured');
    expect(empty).toContain('Longevity Program: 0 confirmed subscribers');
    expect(empty).toContain('reports no sends yet');
    expect(new Set([failed, off, empty]).size).toBe(3);
  });
  it('shows counts per program and send totals; a total the service does not report is Unknown, never zero', () => {
    const text = renderToText(view({ state: 'ok', counts, dashboardUrl: 'https://campaigns.fictional.example/dashboard' }));
    expect(text).toContain('Longevity Program: 3 confirmed subscribers');
    expect(text).toContain('Diabetes program: 1 confirmed subscriber');
    expect(text).toContain('4 delivered · 1 bounced · Unknown unsubscribed');
    expect(renderToMarkup(view({ state: 'ok', counts, dashboardUrl: 'https://campaigns.fictional.example/dashboard' }))).toContain('href="https://campaigns.fictional.example/dashboard"');
    expect(text).not.toMatch(/@/);
  });
});
