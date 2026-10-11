import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import { FunnelPage } from './FunnelPage';
import { FUNNELS, type FunnelDefinition } from '@/funnels';
import { longevityProgram } from '@/funnels/definitions/longevity-program';

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
const render = (funnel: FunnelDefinition, href = consultHref) => createElement(FunnelPage, { funnel, consultHref: href });

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
  it('falls back to a same-origin consult path when no public address is configured', () => {
    const markup = renderToMarkup(render(longevityProgram, '/consult/longevity-program'));
    const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    expect(new Set(hrefs)).toEqual(new Set(['/consult/longevity-program']));
    expect(markup).not.toMatch(/https?:\/\//);
  });
});
