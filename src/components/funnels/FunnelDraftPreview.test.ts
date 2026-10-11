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
      expect(renderToText(page)).toContain('Prices are not selected');
      expect(renderToMarkup(page)).toContain('disabled=""');
      expect(renderToMarkup(page)).toContain(`href="/consult/${funnel.consultSlug}"`);
      expect(publishedFunnel(funnel.slug)).toBeNull();
    }
  });
  it('unknown slugs stay not-found', async () => {
    await expect(Preview({ params: Promise.resolve({ slug: 'unknown' }) })).rejects.toThrow('not-found');
  });
});
