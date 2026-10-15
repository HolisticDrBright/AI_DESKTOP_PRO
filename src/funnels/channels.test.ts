import { describe, expect, it } from 'vitest';
import { consultSlug as consultContractSlug } from '@/contracts/consultRequests';
import { FUNNELS, consultSlugFor, funnelChannelFrom, funnelConsultSlugs, funnelDefinition, funnelSourceOf } from '@/funnels';
import { longevityProgram } from './definitions/longevity-program';

/**
 * The channel a visitor came through, as a funnel page may know it: one value from a fixed list, used only
 * to choose the consult link. Every consult slug a funnel uses is a valid consult link slug, belongs to
 * exactly one funnel and one channel, and maps back to that funnel and channel from the slug alone.
 */
describe('?via=', () => {
  it('is accepted from the fixed list only; anything else is the web', () => {
    expect(funnelChannelFrom('email')).toBe('email');
    expect(funnelChannelFrom('text')).toBe('text');
    for (const value of [undefined, null, '', 'web', 'EMAIL', ' email', 'email ', 'sms', 'email&x=1', 'facebook', 7, ['email'], ['email', 'text'], { via: 'email' }]) {
      expect(funnelChannelFrom(value), JSON.stringify(value)).toBe('web');
    }
  });
  it('chooses the channel\'s own consult link, falling back to the web link when a channel has none', () => {
    expect(consultSlugFor(longevityProgram, 'web')).toBe('longevity-program');
    expect(consultSlugFor(longevityProgram, 'email')).toBe('longevity-program-email');
    // No text link exists yet: a text visitor reaches the web link rather than a link that does not exist.
    expect(consultSlugFor(longevityProgram, 'text')).toBe('longevity-program');
  });
});

describe('the consult slugs the funnels hand off to', () => {
  it('are one web and one email link per program, each a valid consult link slug, none shared', () => {
    expect(FUNNELS.map(funnelConsultSlugs)).toEqual([
      [{ channel: 'web', slug: 'longevity-program' }, { channel: 'email', slug: 'longevity-program-email' }],
      [{ channel: 'web', slug: 'weight-loss-program' }, { channel: 'email', slug: 'weight-loss-program-email' }],
      [{ channel: 'web', slug: 'diabetes-program' }, { channel: 'email', slug: 'diabetes-program-email' }],
    ]);
    const all = FUNNELS.flatMap(funnel => funnelConsultSlugs(funnel).map(entry => entry.slug));
    for (const slug of all) expect(consultContractSlug.safeParse(slug).success, slug).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });
  it('map back to their funnel and channel from the slug alone, and an unrelated link maps to nothing', () => {
    expect(funnelSourceOf(FUNNELS, 'diabetes-program-email')).toMatchObject({ funnel: { slug: 'diabetes-program' }, channel: 'email' });
    expect(funnelSourceOf(FUNNELS, 'weight-loss-program')).toMatchObject({ funnel: { slug: 'weight-loss-program' }, channel: 'web' });
    expect(funnelSourceOf(FUNNELS, 'fictional-clinic-link')).toBeNull();
  });
  it('a definition cannot give two channels the same link, or name a channel outside the list', () => {
    expect(funnelDefinition.safeParse({ ...longevityProgram, channelConsultSlugs: { email: 'longevity-program' } }).success).toBe(false);
    expect(funnelDefinition.safeParse({ ...longevityProgram, channelConsultSlugs: { email: 'shared-link', text: 'shared-link' } }).success).toBe(false);
    expect(funnelDefinition.safeParse({ ...longevityProgram, channelConsultSlugs: { facebook: 'longevity-program-fb' } }).success).toBe(false);
    expect(funnelDefinition.safeParse({ ...longevityProgram, channelConsultSlugs: { email: 'https://elsewhere.example/x' } }).success).toBe(false);
    expect(funnelDefinition.safeParse({ ...longevityProgram, channelConsultSlugs: { email: 'a-consult-slug-that-is-longer-than-forty-characters' } }).success).toBe(false);
  });
  it('each program names its campaign list by key only; no address is written into a definition', () => {
    expect(FUNNELS.map(funnel => funnel.updates)).toEqual([
      { programKey: 'longevity-program' }, { programKey: 'weight-loss-program' }, { programKey: 'diabetes-program' },
    ]);
    expect(funnelDefinition.safeParse({ ...longevityProgram, updates: { programKey: 'https://updates.example/signup' } }).success).toBe(false);
    expect(funnelDefinition.safeParse({ ...longevityProgram, updates: { programKey: 'longevity-program', url: 'https://updates.example' } }).success).toBe(false);
    const { updates: _updates, channelConsultSlugs: _channels, ...withoutEither } = longevityProgram;
    expect(funnelDefinition.safeParse(withoutEither).success).toBe(true);
  });
});
