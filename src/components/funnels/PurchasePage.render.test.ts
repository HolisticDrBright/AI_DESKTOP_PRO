import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { PurchasePage } from './PurchasePage';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import { PURCHASE_HOLD_EXPLANATIONS, unavailable, type PurchaseAvailability } from '@/contracts/programOffers';
import { funnelTextIssue } from '@/funnels/schema';

/**
 * The purchase page as rendered: the exact terms only when the offer is available, what a purchase
 * does not include, checkout honestly "not available yet", and the consult address either way. No
 * form control and no payment field exist on it.
 */
const consultHref = 'https://clinic.fictional.example/consult/longevity-program';
const available: PurchaseAvailability = { available: true, offerId: '11111111-1111-4111-8111-111111111111', revision: 3, name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'recurring', interval: 'month', intervalCount: 1 } }, curriculum: { versionId: '22222222-2222-4222-8222-222222222222', version: 2, sourceDigest: 'a'.repeat(64) }, accessTermsVersion: 'education-access-terms/1', accessDurationDays: null, providerPriceRef: 'price_FictionalAbc123' };
const checkout = { ready: false as const, reason: 'checkout_unconfigured' as const, explanation: PURCHASE_HOLD_EXPLANATIONS.checkout_unconfigured };
const render = (purchase: PurchaseAvailability) => createElement(PurchasePage, { funnel: longevityProgram, consultHref, purchase, checkout, learnHref: '/learn/longevity-program' });

describe('the purchase page', () => {
  it('shows the exact terms, what is excluded, and checkout as not available yet', () => {
    const element = render(available);
    const text = renderToText(element);
    const markup = renderToMarkup(element);
    expect(markup).toContain('data-purchase="available"');
    expect(markup).toContain('data-testid="purchase-terms"');
    expect(text).toContain('Price 19.99 USD every month');
    expect(text).toContain('as published in version 2');
    expect(text).toContain('The access duration has not been decided');
    expect(text).toContain('Access terms version education-access-terms/1');
    expect(text).toContain('A purchase does not include a consultation, a prescription, a supplement, any clinical decision, or a connection to the clinic.');
    expect(markup).toContain('data-testid="purchase-start" data-ready="false"');
    expect(text).toContain('Checkout is not available yet. Online payment is not set up for this site.');
    expect(markup).not.toMatch(/<(form|input|textarea|select|button|img|script|iframe)\b/i);
    expect(new Set([...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]))).toEqual(new Set(['/learn/longevity-program', consultHref]));
  });
  it('says why direct purchase is unavailable and still offers the consultation, printing no price', () => {
    for (const reason of ['program_unbound', 'commerce_disabled', 'offer_draft', 'offer_retired', 'commerce_unverifiable'] as const) {
      const element = render(unavailable(reason));
      const markup = renderToMarkup(element);
      expect(markup, reason).toContain(`data-testid="purchase-unavailable" data-reason="${reason}"`);
      expect(markup, reason).not.toContain('purchase-terms');
      const text = renderToText(element);
      expect(text, reason).toContain(PURCHASE_HOLD_EXPLANATIONS[reason]);
      expect(text, reason).toContain('You can still request a consultation');
      expect(text, reason).not.toMatch(/USD|\$\d/);
      expect(markup, reason).toContain('data-testid="purchase-cta-consult"');
    }
  });
  it('uses words that pass the funnel text rules', () => {
    for (const purchase of [available, unavailable('offer_draft')]) {
      const text = renderToText(render(purchase)).replace(/\d+\.\d+ USD[^.]*/g, '');
      expect(funnelTextIssue(text)).toBeNull();
    }
  });
});
