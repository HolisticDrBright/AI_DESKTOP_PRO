import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToMarkup } from '@/test-support/renderToText';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import type { FunnelDefinition } from '@/funnels';

/**
 * The public funnel route as the server renders it, for a published page (a fictional clone; every real
 * funnel is a draft): `?via=email` points the consult button at the program's email link and does nothing
 * else, the canonical address never carries it, and "Get updates about this program" appears only with the
 * campaign sign-up origin configured. The route keeps no record of the visitor: no cookie, header read or
 * log call exists in its source.
 */
const publishedClone: FunnelDefinition = {
  ...structuredClone(longevityProgram), status: 'published', draftNote: null,
  approval: { by: 'Fictional reviewer', on: '2026-10-14', attorneyReview: false },
  sections: longevityProgram.sections.map(s => s.kind === 'what-is-included' ? { ...s, source: 'published_program' as const, items: ['Fictional lesson one'] } : s),
};
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));
vi.mock('@/server/commerce/journey-fixture', () => ({ resolvePublicFunnel: async (slug: string) => (slug === 'longevity-program' ? publishedClone : null) }));
vi.mock('@/server/commerce/funnel-purchase', async () => {
  const { unavailable } = await import('@/contracts/programOffers');
  return { funnelPurchaseAvailability: async () => unavailable('program_unbound') };
});

const route = async () => await import('./[slug]/page');
const render = async (search: Record<string, string | string[] | undefined>) => {
  const { default: FunnelRoute } = await route();
  return renderToMarkup(await FunnelRoute({ params: Promise.resolve({ slug: 'longevity-program' }), searchParams: Promise.resolve(search) }));
};
const hrefs = (markup: string) => new Set([...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1]));

afterEach(() => { vi.unstubAllEnvs(); });

describe('the public funnel route', () => {
  it('points the consult button at the email link for ?via=email, and at the web link for anything else', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_ORIGIN', 'https://clinic.fictional.example');
    expect(hrefs(await render({ via: 'email' }))).toEqual(new Set(['https://clinic.fictional.example/consult/longevity-program-email']));
    for (const search of [{}, { via: 'web' }, { via: 'EMAIL' }, { via: ['email', 'email'] }, { via: 'partner-site' }]) {
      expect(hrefs(await render(search)), JSON.stringify(search)).toEqual(new Set(['https://clinic.fictional.example/consult/longevity-program']));
    }
    const markup = await render({ via: 'email' });
    expect(markup).not.toContain('via=');
  });
  it('adds "Get updates about this program" only when the campaign sign-up origin is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_ORIGIN', 'https://clinic.fictional.example');
    expect(await render({})).not.toContain('Get updates');
    vi.stubEnv('CAMPAIGN_SIGNUP_ORIGIN', 'https://updates.fictional.example');
    const markup = await render({ via: 'email' });
    expect(hrefs(markup)).toEqual(new Set(['https://clinic.fictional.example/consult/longevity-program-email', 'https://updates.fictional.example/signup/longevity-program']));
    expect(markup).not.toMatch(/<(form|input|button|script|iframe|img)\b/i);
  });
  it('never puts the channel in the canonical address', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_ORIGIN', 'https://clinic.fictional.example');
    vi.stubEnv('APP_RUNTIME_ENV', 'production-clinical');
    const { generateMetadata } = await route();
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: 'longevity-program' }) });
    expect(metadata.alternates?.canonical).toBe('https://clinic.fictional.example/learn/longevity-program');
  });
  it('keeps nothing about the visitor: no cookie, request header, storage or log call in the route or its link helpers', () => {
    for (const file of ['src/app/learn/[slug]/page.tsx', 'src/lib/funnelPageLinks.ts', 'src/lib/campaignSignupUrl.ts', 'src/funnels/channels.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bcookies\(|\bheaders\(|set-cookie|console\.|localStorage|sessionStorage|\bfetch\(/i);
    }
  });
});
