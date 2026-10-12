import { describe, expect, it, vi } from 'vitest';
import { renderToMarkup, renderToText } from '@/test-support/renderToText';
import Preview, { metadata } from '@/app/funnels/[slug]/preview/page';
import { FUNNELS, publishedFunnel } from '@/funnels';
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));

describe('private draft review', () => {
  it('is noindex and never publishes a draft or connects a purchase', async () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    for (const funnel of FUNNELS) {
      const page = await Preview({ params: Promise.resolve({ slug: funnel.slug }) });
      expect(renderToText(page)).toContain('Private draft review — not published');
      // The buy choice is shown as the offer answers it: no page is bound to a program, so it is unavailable, with no link, no price and no button.
      expect(renderToText(page)).toContain('Direct purchase is unavailable: This page is not linked to a program that can be bought yet.');
      expect(renderToMarkup(page)).toContain('data-testid="funnel-buy-top" data-available="false"');
      expect(renderToMarkup(page)).not.toMatch(/<(button|form|input)\b/i);
      expect(renderToMarkup(page)).not.toContain('href="/buy/');
      expect(renderToText(page)).not.toMatch(/USD|\$\d/);
      expect(renderToMarkup(page)).toContain(`href="/consult/${funnel.consultSlug}"`);
      expect(publishedFunnel(funnel.slug)).toBeNull();
    }
  });
  it('unknown slugs stay not-found', async () => {
    await expect(Preview({ params: Promise.resolve({ slug: 'unknown' }) })).rejects.toThrow('not-found');
  });
});
