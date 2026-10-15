import { describe, expect, it, vi } from 'vitest';
import { FUNNELS } from '@/funnels';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import { marketingSignupDirectory } from '@/funnels/marketingSignup';
import { funnelUpdatesUrl, joinPath, NO_MARKETING_SIGNUP, type MarketingSignupDirectory } from './marketingSignupLink';
import { funnelPageLinks } from './funnelPageLinks';

/**
 * A funnel page's outbound addresses, decided from the definition, configuration, the marketing directory
 * and `?via=` alone: the consult link for the visitor's channel, and the practice's own sign-up page only
 * when a practice offering the list holds the `marketing` entitlement.
 */
const site = { NEXT_PUBLIC_SITE_ORIGIN: 'https://clinic.fictional.example' };
const entitled: MarketingSignupDirectory = { practiceFor: async () => ({ practiceSlug: 'fictional-practice' }) };

describe('the "Get updates" address', () => {
  it('is the practice\'s /join/<practice>/<program> page, for a funnel with a list, when a practice holds the entitlement', async () => {
    for (const funnel of FUNNELS) {
      expect(await funnelUpdatesUrl(funnel, entitled, site)).toBe(`https://clinic.fictional.example/join/fictional-practice/${funnel.updates!.programKey}`);
    }
    // Without a public origin it stays a same-origin path.
    expect(await funnelUpdatesUrl(longevityProgram, entitled, {})).toBe('/join/fictional-practice/longevity-program');
    const { updates: _none, ...withoutList } = longevityProgram;
    expect(await funnelUpdatesUrl(withoutList, entitled, site)).toBeNull();
  });
  it('is absent with no entitled practice, an unreadable directory, or a practice that is not a plain slug', async () => {
    expect(await funnelUpdatesUrl(longevityProgram, NO_MARKETING_SIGNUP, site)).toBeNull();
    expect(await funnelUpdatesUrl(longevityProgram, { practiceFor: async () => { throw new Error('store unavailable'); } }, site)).toBeNull();
    for (const practiceSlug of ['', 'Fictional', 'a/b', '../x', 'x?y=1', 'https://evil.example', '-x', 'x-']) {
      expect(await funnelUpdatesUrl(longevityProgram, { practiceFor: async () => ({ practiceSlug }) }, site), practiceSlug).toBeNull();
    }
    expect(joinPath('fictional-practice', 'longevity-program')).toBe('/join/fictional-practice/longevity-program');
  });
  it('asks the directory only for the list\'s program key', async () => {
    const practiceFor = vi.fn(async () => null);
    await funnelUpdatesUrl(longevityProgram, { practiceFor }, site);
    expect(practiceFor).toHaveBeenCalledWith('longevity-program');
  });
  it('names no practice while the campaign engine is switched off (the default)', async () => {
    for (const funnel of FUNNELS) expect(await funnelUpdatesUrl(funnel, marketingSignupDirectory(), site)).toBeNull();
  });
});

describe('a funnel page\'s links', () => {
  it('point the consult button at the email link for ?via=email, and at the web link otherwise', async () => {
    expect((await funnelPageLinks(longevityProgram, 'email', NO_MARKETING_SIGNUP, site)).consultHref).toBe('https://clinic.fictional.example/consult/longevity-program-email');
    for (const via of [undefined, 'web', 'Email', 'newsletter', ['email'], 'text']) {
      expect((await funnelPageLinks(longevityProgram, via, NO_MARKETING_SIGNUP, site)).consultHref, JSON.stringify(via)).toBe('https://clinic.fictional.example/consult/longevity-program');
    }
    // Without a public origin the page keeps a same-origin path, for the chosen channel too.
    expect((await funnelPageLinks(longevityProgram, 'email', NO_MARKETING_SIGNUP, {})).consultHref).toBe('/consult/longevity-program-email');
  });
  it('carry the updates link only when a practice holds the marketing entitlement', async () => {
    expect((await funnelPageLinks(longevityProgram, undefined, NO_MARKETING_SIGNUP, site)).updatesUrl).toBeNull();
    expect((await funnelPageLinks(longevityProgram, undefined, entitled, site)).updatesUrl).toBe('https://clinic.fictional.example/join/fictional-practice/longevity-program');
  });
  it('return the two addresses and nothing else: the via value is never echoed or kept', async () => {
    const links = await funnelPageLinks(longevityProgram, 'email', entitled, site);
    expect(Object.keys(links).sort()).toEqual(['consultHref', 'updatesUrl']);
    expect(JSON.stringify(links)).not.toContain('via');
  });
});
