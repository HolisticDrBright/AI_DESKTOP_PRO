import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { FunnelPage } from './FunnelPage';
import { FUNNELS, type FunnelDefinition } from '@/funnels';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import { unavailable, type PurchaseAvailability } from '@/contracts/programOffers';

/**
 * A funnel page rendered for real: every section kind in the words the visitor reads, the
 * "what is included" section honest when the program has not been read, and the page's only
 * outbound link the consult address. No form control, no image, no script and no external
 * address anywhere in the markup.
 */
const practitioner = { kind: 'practitioner', heading: 'Your practitioner', name: 'Fictional Practitioner', credentials: 'Fictional credentials', about: 'A fictional description of the practitioner.' } as const;
const withEverySection = (): FunnelDefinition => ({
  ...structuredClone(longevityProgram),
  sections: [...longevityProgram.sections.slice(0, 4), practitioner, ...longevityProgram.sections.slice(4)],
});
const consultHref = 'https://clinic.fictional.example/consult/longevity-program';
const buyHref = '/buy/longevity-program';
const held: PurchaseAvailability = unavailable('program_unbound');
const available: PurchaseAvailability = { available: true, offerId: '11111111-1111-4111-8111-111111111111', revision: 3, name: 'Fictional program', pricing: { currency: 'USD', amountMinor: 1999, billing: { kind: 'one_time' } }, curriculum: { versionId: '22222222-2222-4222-8222-222222222222', version: 2, sourceDigest: 'a'.repeat(64) }, accessTermsVersion: 'education-access-terms/1', accessDurationDays: 90, providerPriceRef: 'price_FictionalAbc123' };
const render = (funnel: FunnelDefinition, href = consultHref, purchase: PurchaseAvailability = held) => createElement(FunnelPage, { funnel, consultHref: href, purchase, buyHref });

describe('a funnel page', () => {
  it('renders every section kind with its heading and the program label', () => {
    const funnel = withEverySection();
    const markup = renderToMarkup(render(funnel));
    for (const kind of ['hero', 'who-it-is-for', 'what-is-included', 'how-it-works', 'practitioner', 'faq', 'call-to-action']) {
      expect(markup).toContain(`data-testid="funnel-section-${kind}"`);
    }
    const text = renderToText(render(funnel));
    for (const section of funnel.sections) expect(text).toContain(section.heading);
    expect(text).toContain('Longevity Program');
    expect(text).toContain('Fictional Practitioner');
    expect(text).toContain('Not for');
    expect(text).toContain('offered by The Holistic Approach LLC');
    expect(text).toContain('does not replace your own doctor');
  });
  it('says plainly when the "what is included" section has not been written from the program yet, and lists items when it has', () => {
    const text = renderToText(render(longevityProgram));
    expect(text).toContain('are being written from the program itself and are not shown yet');
    expect(renderToMarkup(render(longevityProgram))).toContain('data-source="pending"');
    const filled = withEverySection();
    filled.sections = filled.sections.map(s => s.kind === 'what-is-included' ? { ...s, source: 'published_program', items: ['Fictional lesson one', 'Fictional habit two'] } : s);
    const filledText = renderToText(render(filled));
    expect(filledText).toContain('Fictional lesson one');
    expect(filledText).not.toContain('not shown yet');
  });
  it('shows the buy choice as the specific reason it is unavailable, with no price and no link, until the offer is available', () => {
    for (const reason of ['program_unbound', 'commerce_disabled', 'offer_absent', 'offer_draft', 'curriculum_changed', 'commerce_unverifiable'] as const) {
      const element = render(longevityProgram, consultHref, unavailable(reason));
      const markup = renderToMarkup(element);
      expect(markup, reason).toContain(`data-purchase="${reason}"`);
      expect(markup, reason).toContain('data-testid="funnel-buy-top" data-available="false"');
      expect(markup, reason).toContain('data-testid="funnel-buy-bottom" data-available="false"');
      const text = renderToText(element);
      expect(text, reason).toContain('Direct purchase is not available right now.');
      expect(text, reason).not.toMatch(/USD|\$\d/);
      expect([...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]).every(h => h === consultHref), reason).toBe(true);
    }
    const live = render(longevityProgram, consultHref, available);
    const markup = renderToMarkup(live);
    expect(markup).toContain('data-purchase="available"');
    expect(markup).toContain('data-testid="funnel-buy-top" data-available="true"');
    expect(renderToText(live)).toContain('Buy the program 19.99 USD, one payment, 90 days of access');
    expect(new Set([...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]))).toEqual(new Set([consultHref, buyHref]));
    expect(renderToText(live)).toContain('two choices: to request a consultation, or to buy the program when it is available');
  });
  it('has no form control, no image, no script and no external address; its only links are the consult address', () => {
    for (const funnel of [withEverySection(), ...FUNNELS]) {
      const markup = renderToMarkup(render(funnel));
      expect(markup, funnel.slug).not.toMatch(/<(form|input|textarea|select|button|img|script|iframe|video|audio|object|embed)\b/i);
      expect(markup, funnel.slug).not.toMatch(/\bsrc=/i);
      const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
      expect(hrefs.length, funnel.slug).toBeGreaterThanOrEqual(2);
      expect(new Set(hrefs), funnel.slug).toEqual(new Set([consultHref]));
      expect(markup.replaceAll(consultHref, ''), funnel.slug).not.toMatch(/https?:\/\//);
    }
  });
  it('with the campaign sign-up page configured, its outbound addresses are exactly the consult page and the sign-up page, and it still has no form', () => {
    const updatesUrl = 'https://updates.fictional.example/signup/longevity-program';
    for (const funnel of [withEverySection(), ...FUNNELS]) {
      const element = createElement(FunnelPage, { funnel, consultHref, purchase: held, buyHref, updatesUrl });
      const markup = renderToMarkup(element);
      expect(markup, funnel.slug).not.toMatch(/<(form|input|textarea|select|button|img|script|iframe|video|audio|object|embed)\b/i);
      expect(markup, funnel.slug).not.toMatch(/\bsrc=/i);
      expect(new Set([...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1])), funnel.slug).toEqual(new Set([consultHref, updatesUrl]));
      expect(markup.replaceAll(consultHref, '').replaceAll(updatesUrl, ''), funnel.slug).not.toMatch(/https?:\/\//);
      expect(markup, funnel.slug).toContain('data-testid="funnel-updates-top"');
      expect(markup, funnel.slug).toContain('data-testid="funnel-updates-bottom"');
      const text = renderToText(element);
      expect(text, funnel.slug).toContain('Get updates about this program');
      expect(text, funnel.slug).toContain('You can also ask for email updates about this program on a separate sign-up page; nothing is entered on this page.');
    }
    // With the offer available the buy page joins them, and nothing else does.
    const live = renderToMarkup(createElement(FunnelPage, { funnel: longevityProgram, consultHref, purchase: available, buyHref, updatesUrl }));
    expect(new Set([...live.matchAll(/href="([^"]*)"/g)].map(m => m[1]))).toEqual(new Set([consultHref, buyHref, updatesUrl]));
  });
  it('shows no updates link, and no word of one, when the sign-up page is not configured', () => {
    for (const updatesUrl of [undefined, null]) {
      const element = createElement(FunnelPage, { funnel: longevityProgram, consultHref, purchase: held, buyHref, updatesUrl });
      expect(renderToMarkup(element)).not.toContain('funnel-updates');
      expect(renderToText(element)).not.toMatch(/Get updates|email updates/);
    }
  });
  it('falls back to a same-origin consult path when no public address is configured', () => {
    const markup = renderToMarkup(render(longevityProgram, '/consult/longevity-program'));
    const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    expect(new Set(hrefs)).toEqual(new Set(['/consult/longevity-program']));
    expect(markup).not.toMatch(/https?:\/\//);
  });
});
