import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { emptySettings, type CampaignOverview, type JoinPageInfo } from '@/campaigns/contract';
import { CampaignsView, type CampaignsState } from './CampaignsScreen';
import { JoinConfirm, JoinForm, JoinUnsubscribed } from './JoinPages';

/**
 * The Campaigns screen and the public sign-up pages as they render. A failed read never looks like "no subscribers";
 * a practice without the package sees what it does and nothing it can change; staff without the marketing role see
 * counts only. The sign-up page has no script, posts only to this origin, and its consent box starts unticked.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const overview = (over: Partial<CampaignOverview> = {}): CampaignOverview => ({
  contract: 'campaign-engine/1', role: 'marketing_admin',
  entitlement: { marketing: true, tier: 'growth', contactAllowance: 10_000, confirmedContacts: 0 },
  settings: emptySettings(PRACTICE), domain: null,
  readiness: { canSend: false, missing: ['No sender name is set.'] },
  lists: (['longevity-program', 'weight-loss-program', 'diabetes-program'] as const).map(programKey => ({ programKey, counts: { confirmed: 0, unsubscribed: 0, bounced: 0, complained: 0 } })),
  templates: [], sequences: (['longevity-program', 'weight-loss-program', 'diabetes-program'] as const).map(programKey => ({ programKey, version: 0, status: 'draft' as const, steps: [], updatedAt: null })),
  broadcasts: [], results: [], ...over,
});
const view = (state: CampaignsState) => createElement(CampaignsView, { state, busy: false, message: null, act: async () => null, onRetry: () => {} });

describe('the Campaigns screen', () => {
  it('switched off, loading, failed and refused are four different things, none of them "no subscribers"', () => {
    const ids = (['off', 'loading', 'failed', 'refused'] as const).map(status => renderToMarkup(view({ status } as CampaignsState)));
    expect(ids[0]).toContain('data-testid="campaigns-off"');
    expect(ids[1]).toContain('data-testid="campaigns-loading"');
    expect(ids[2]).toContain('data-testid="campaigns-failed"');
    expect(ids[3]).toContain('data-testid="campaigns-refused"');
    expect(renderToText(view({ status: 'failed' }))).toContain('This is not the same as having no subscribers.');
    for (const markup of ids) expect(markup).not.toContain('campaigns-no-subscribers');
  });
  it('a read of zero says "No subscribers yet"', () => {
    const markup = renderToMarkup(view({ status: 'loaded', overview: overview() }));
    expect(markup).toContain('data-testid="campaigns-no-subscribers"');
    expect(markup).toContain('data-testid="campaigns-lists"');
  });
  it('without the marketing package, says what it does and offers nothing to edit or send', () => {
    const markup = renderToMarkup(view({ status: 'loaded', overview: overview({ entitlement: { marketing: false, tier: null, contactAllowance: null, confirmedContacts: 0 } }) }));
    expect(markup).toContain('data-testid="campaigns-not-entitled"');
    expect(renderToText(view({ status: 'loaded', overview: overview({ entitlement: { marketing: false, tier: null, contactAllowance: null, confirmedContacts: 0 } }) }))).toContain('included in the Growth and Complete tiers, or as an add-on');
    expect(markup).not.toMatch(/<button|<input|<textarea|<select/);
  });
  it('staff without the marketing role see counts and results, and no editor, address or role control', () => {
    const markup = renderToMarkup(view({ status: 'loaded', overview: overview({ role: 'none' }) }));
    expect(markup).toContain('data-testid="campaigns-no-role"');
    for (const id of ['campaigns-settings', 'campaigns-templates', 'campaigns-sequences', 'campaigns-broadcasts', 'campaigns-roles']) expect(markup).not.toContain(id);
    expect(markup).not.toContain('Show addresses');
  });
  it('a marketing admin sees every editor, what is missing before sending, and an allowance nobody loaded as Unknown', () => {
    const markup = renderToMarkup(view({ status: 'loaded', overview: overview({ entitlement: { marketing: true, tier: 'growth', contactAllowance: null, confirmedContacts: 0 } }) }));
    for (const id of ['campaigns-readiness', 'campaigns-settings', 'campaigns-domain', 'campaigns-templates', 'campaigns-sequences', 'campaigns-broadcasts', 'campaigns-results', 'campaigns-roles']) expect(markup).toContain(id);
    const text = renderToText(view({ status: 'loaded', overview: overview({ entitlement: { marketing: true, tier: 'growth', contactAllowance: null, confirmedContacts: 0 } }) }));
    expect(text).toContain('No sender name is set.');
    expect(text).toContain('Contacts: 0 of Unknown allowed.');
    expect(text).toContain('Opens and clicks are not counted for this practice.');
  });
});

describe('the public sign-up pages', () => {
  const info: JoinPageInfo = { practiceName: 'Fictional Clinic', programKey: 'longevity-program', programLabel: 'Longevity Program', consentVersion: 'campaign-consent/1',
    consentLine: 'Yes, email me about the Longevity Program from Fictional Clinic: a few welcome emails and occasional updates. I can stop at any time.', formToken: 'T'.repeat(60) };
  it('is a plain form to this origin: email, an optional first name, an unticked consent box, a hidden field; no script, no health question', () => {
    const markup = renderToMarkup(createElement(JoinForm, { info, practice: 'fictional-clinic', problem: null }));
    expect(markup).not.toMatch(/<script|<iframe|<img|https?:\/\//);
    expect([...markup.matchAll(/action="([^"]+)"/g)].map(m => m[1])).toEqual(['/api/public/campaigns/join']);
    expect([...markup.matchAll(/name="([^"]+)"/g)].map(m => m[1]).sort()).toEqual(['consent', 'email', 'firstName', 'formToken', 'practice', 'program', 'website']);
    const consent = markup.match(/<input[^>]*name="consent"[^>]*>/)?.[0] ?? '';
    for (const attribute of ['type="checkbox"', 'value="yes"', 'required=""']) expect(consent).toContain(attribute);
    expect(consent).not.toContain('checked');
    expect(markup).toContain('data-testid="join-consent"');
    expect(renderToText(createElement(JoinForm, { info, practice: 'fictional-clinic', problem: 'email' }))).toContain('That email address does not look right.');
  });
  it('the confirmation link shows a button and confirms nothing by itself; each outcome says what happened', () => {
    const page = renderToMarkup(createElement(JoinConfirm, { token: 'T'.repeat(60), outcome: null }));
    expect(page).toContain('data-testid="join-confirm-button"');
    expect([...page.matchAll(/action="([^"]+)"/g)].map(m => m[1])).toEqual(['/api/public/campaigns/confirm']);
    expect(renderToText(createElement(JoinConfirm, { token: null, outcome: 'list_full' }))).toContain('you were not added');
    expect(renderToMarkup(createElement(JoinConfirm, { token: null, outcome: 'nonsense' }))).toContain('join-confirm-unavailable');
    expect(renderToText(createElement(JoinUnsubscribed, { outcome: 'unavailable' }))).toContain('not available right now');
  });
});
