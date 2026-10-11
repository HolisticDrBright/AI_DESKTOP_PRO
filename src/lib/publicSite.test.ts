import { describe, expect, it } from 'vitest';
import { funnelPageUrl, indexingAllowed, isStagingOrSynthetic, publicSiteOrigin } from './publicSite';
import { funnelSitemap } from '@/app/sitemap';
import { generateMetadata } from '@/app/learn/[slug]/page';

/**
 * Indexing turns on only for the production origin. With no origin, on a staging or synthetic
 * deployment, or on a host whose name says so, every funnel page is noindex and the sitemap is
 * empty, whatever the definitions say. No host name is written in source: every address here is
 * built from the configured origin.
 */
const production = { NEXT_PUBLIC_SITE_ORIGIN: 'https://clinic.fictional.example', APP_RUNTIME_ENV: 'production-clinical', CLINICAL_AWS_ENVIRONMENT: 'production-clinical' };

describe('the public site origin', () => {
  it.each([
    ['https://clinic.fictional.example', 'https://clinic.fictional.example'],
    ['https://clinic.fictional.example/', 'https://clinic.fictional.example'],
    ['http://clinic.fictional.example', null],
    ['https://clinic.fictional.example/path', null],
    ['https://user:pw@clinic.fictional.example', null],
    ['not a url', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (value, expected) => {
    expect(publicSiteOrigin({ NEXT_PUBLIC_SITE_ORIGIN: value })).toBe(expected);
  });
  it('builds the funnel address from the origin or says there is none', () => {
    expect(funnelPageUrl('longevity-program', production)).toBe('https://clinic.fictional.example/learn/longevity-program');
    expect(funnelPageUrl('longevity-program', {})).toBeNull();
  });
});

describe('indexing posture', () => {
  it('is allowed only on the production origin', () => {
    expect(indexingAllowed(production)).toBe(true);
    expect(indexingAllowed({ ...production, NEXT_PUBLIC_SITE_ORIGIN: undefined })).toBe(false);
    expect(indexingAllowed({ ...production, APP_RUNTIME_ENV: 'staging' })).toBe(false);
    expect(indexingAllowed({ ...production, APP_RUNTIME_ENV: undefined })).toBe(false);
    expect(indexingAllowed({ ...production, CLINICAL_AWS_ENVIRONMENT: 'synthetic-staging' })).toBe(false);
    expect(indexingAllowed({ ...production, NEXT_PUBLIC_SITE_ORIGIN: 'https://staging.fictional.example' })).toBe(false);
    expect(indexingAllowed({ ...production, NEXT_PUBLIC_SITE_ORIGIN: 'https://synthetic-clinic.fictional.example' })).toBe(false);
    expect(isStagingOrSynthetic({ NEXT_PUBLIC_SITE_ORIGIN: 'https://localhost' })).toBe(true);
  });
  it('the sitemap is empty without the production origin, and lists only published, indexable funnels with it', () => {
    expect(funnelSitemap({})).toEqual([]);
    expect(funnelSitemap({ ...production, APP_RUNTIME_ENV: 'staging' })).toEqual([]);
    // Every funnel in the repository is a draft today, so the production sitemap is empty too; nothing unapproved is listed.
    expect(funnelSitemap(production)).toEqual([]);
    const entries = funnelSitemap(production);
    for (const entry of entries) expect(entry.url).toMatch(/^https:\/\/clinic\.fictional\.example\/learn\//);
  });
  it('a draft or unknown slug is noindex with no canonical, whatever the environment', async () => {
    for (const slug of ['longevity-program', 'no-such-program']) {
      const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
      expect(metadata.robots).toEqual({ index: false, follow: false });
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.title).toBe('Page not found');
    }
  });
});
