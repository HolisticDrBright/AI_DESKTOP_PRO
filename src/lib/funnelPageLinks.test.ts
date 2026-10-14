import { describe, expect, it } from 'vitest';
import { FUNNELS } from '@/funnels';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import { campaignSignupOrigin, funnelUpdatesUrl } from './campaignSignupUrl';
import { funnelPageLinks } from './funnelPageLinks';

/**
 * A funnel page's outbound addresses, decided from the definition, configuration and `?via=` alone: the
 * consult link for the visitor's channel, and the campaign sign-up page only when its origin is configured.
 */
const site = { NEXT_PUBLIC_SITE_ORIGIN: 'https://clinic.fictional.example' };
const updates = { CAMPAIGN_SIGNUP_ORIGIN: 'https://updates.fictional.example' };

describe('the campaign sign-up address', () => {
  it('is the configured https origin plus /signup/<program key>, for a funnel with a list', () => {
    for (const funnel of FUNNELS) {
      expect(funnelUpdatesUrl(funnel, updates)).toBe(`https://updates.fictional.example/signup/${funnel.updates!.programKey}`);
    }
    expect(funnelUpdatesUrl(longevityProgram, { CAMPAIGN_SIGNUP_ORIGIN: 'https://updates.fictional.example/' })).toBe('https://updates.fictional.example/signup/longevity-program');
    const { updates: _none, ...withoutList } = longevityProgram;
    expect(funnelUpdatesUrl(withoutList, updates)).toBeNull();
  });
  it('is absent when the setting is unset or is anything but a bare https origin', () => {
    for (const value of [undefined, '', '   ', 'http://updates.fictional.example', 'https://updates.fictional.example/signup', 'https://updates.fictional.example/?a=1',
      'https://updates.fictional.example/#x', 'https://user:pass@updates.fictional.example', 'https://updates.fictional.example:8443', 'not a url', 'javascript:alert(1)']) {
      expect(campaignSignupOrigin({ CAMPAIGN_SIGNUP_ORIGIN: value }), String(value)).toBeNull();
      expect(funnelUpdatesUrl(longevityProgram, { CAMPAIGN_SIGNUP_ORIGIN: value }), String(value)).toBeNull();
    }
  });
});

describe('a funnel page\'s links', () => {
  it('point the consult button at the email link for ?via=email, and at the web link otherwise', () => {
    expect(funnelPageLinks(longevityProgram, 'email', site).consultHref).toBe('https://clinic.fictional.example/consult/longevity-program-email');
    for (const via of [undefined, 'web', 'Email', 'newsletter', ['email'], 'text']) {
      expect(funnelPageLinks(longevityProgram, via, site).consultHref, JSON.stringify(via)).toBe('https://clinic.fictional.example/consult/longevity-program');
    }
    // Without a public origin the page keeps a same-origin path, for the chosen channel too.
    expect(funnelPageLinks(longevityProgram, 'email', {}).consultHref).toBe('/consult/longevity-program-email');
  });
  it('carry the updates link only when the campaign sign-up origin is configured', () => {
    expect(funnelPageLinks(longevityProgram, undefined, site).updatesUrl).toBeNull();
    expect(funnelPageLinks(longevityProgram, undefined, { ...site, ...updates }).updatesUrl).toBe('https://updates.fictional.example/signup/longevity-program');
  });
  it('return the two addresses and nothing else: the via value is never echoed or kept', () => {
    const links = funnelPageLinks(longevityProgram, 'email', { ...site, ...updates });
    expect(Object.keys(links).sort()).toEqual(['consultHref', 'updatesUrl']);
    expect(JSON.stringify(links)).not.toContain('via');
  });
});
