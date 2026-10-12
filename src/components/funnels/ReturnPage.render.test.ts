import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { RETURN_WORDS, ReturnPage } from './ReturnPage';
import { ORDER_STATES } from '@/contracts/programCheckout';
import { funnelTextIssue } from '@/funnels/schema';

/**
 * The return page says the order's state, not what the address claimed: "success" in the address with
 * an order still open is "being confirmed" plus a line that the redirect is not proof; only
 * payment_verified is "confirmed"; an unknown order is unknown. It mints nothing and offers the
 * program page and the consultation.
 */
const render = (returned: 'success' | 'cancel' | 'unknown', state: Parameters<typeof ReturnPage>[0]['state'], links = true) =>
  createElement(ReturnPage, { returned, state, learnHref: links ? '/learn/longevity-program' : null, consultHref: links ? 'https://clinic.fictional.example/consult/longevity-program' : null });

describe('the return page', () => {
  it('has words for every order state and the unknown case, all passing the funnel text rules', () => {
    for (const state of [...ORDER_STATES, 'unknown'] as const) {
      expect(RETURN_WORDS[state]).toBeDefined();
      expect(funnelTextIssue(RETURN_WORDS[state].heading + ' ' + RETURN_WORDS[state].detail), state).toBeNull();
    }
  });
  it('treats the address as a claim and the ledger as the fact', () => {
    const open = render('success', 'checkout_open');
    expect(renderToMarkup(open)).toContain('data-returned="success" data-state="checkout_open"');
    expect(renderToText(open)).toContain('Your payment is being confirmed');
    expect(renderToMarkup(open)).toContain('data-testid="return-not-proof"');
    const verified = render('success', 'payment_verified');
    expect(renderToText(verified)).toContain('Your payment is confirmed');
    expect(renderToText(verified)).toContain('Nothing on this page is your access.');
    expect(renderToMarkup(verified)).not.toContain('return-not-proof');
    expect(renderToText(render('cancel', 'checkout_open'))).toContain('being confirmed');
    expect(renderToText(render('success', 'payment_failed'))).toContain('The payment did not go through');
    expect(renderToText(render('success', 'unknown'))).toContain('We do not recognise this order');
    expect(renderToText(render('success', 'checkout_expired'))).toContain('The checkout expired');
  });
  it('offers the program page and the consultation when known, never a form or a payment field, and nothing when the order is unknown', () => {
    const markup = renderToMarkup(render('success', 'checkout_open'));
    expect(markup).toContain('data-testid="return-learn"');
    expect(markup).toContain('data-testid="return-consult"');
    expect(markup).not.toMatch(/<(form|input|button|script|iframe)\b/i);
    const unknown = renderToMarkup(render('success', 'unknown', false));
    expect(unknown).not.toMatch(/href=/);
  });
});
