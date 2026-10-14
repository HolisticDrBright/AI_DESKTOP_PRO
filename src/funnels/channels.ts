import type { FunnelDefinition } from './schema';

/**
 * The channel a visitor arrived through, as far as a funnel page is allowed to know it.
 *
 * A campaign email links to a program page with `?via=email`. The value is accepted from this fixed list
 * and nothing else, and it is used for exactly one thing: choosing which consult link the page's button
 * points at. It is not stored, logged or set as a cookie, and it never names a person. Because each
 * request in the queue already carries its link's slug, the clinic can count requests per program and per
 * channel without the page remembering anything.
 */
export const FUNNEL_CHANNELS = ['web', 'email', 'text'] as const;
export type FunnelChannel = typeof FUNNEL_CHANNELS[number];

/** `?via=` as the page reads it: one exact value from the list, otherwise the web. Never echoed anywhere. */
export function funnelChannelFrom(via: unknown): FunnelChannel {
  const value = Array.isArray(via) ? undefined : via;
  return value === 'email' || value === 'text' ? value : 'web';
}

/** The consult slug a page's button points at for a channel; a channel without its own link falls back to the web link. */
export function consultSlugFor(funnel: FunnelDefinition, channel: FunnelChannel): string {
  if (channel === 'web') return funnel.consultSlug;
  return funnel.channelConsultSlugs?.[channel] ?? funnel.consultSlug;
}

/** Every consult slug a funnel hands off to, by channel. A channel with no link of its own is absent. */
export function funnelConsultSlugs(funnel: FunnelDefinition): Array<{ channel: FunnelChannel; slug: string }> {
  return FUNNEL_CHANNELS.flatMap((channel): Array<{ channel: FunnelChannel; slug: string }> => {
    if (channel === 'web') return [{ channel, slug: funnel.consultSlug }];
    const slug = funnel.channelConsultSlugs?.[channel];
    return slug ? [{ channel, slug }] : [];
  });
}

/** Which funnel and channel a consult slug belongs to, or null for a link no funnel uses. */
export function funnelSourceOf(funnels: readonly FunnelDefinition[], slug: string): { funnel: FunnelDefinition; channel: FunnelChannel } | null {
  for (const funnel of funnels) {
    const match = funnelConsultSlugs(funnel).find(entry => entry.slug === slug);
    if (match) return { funnel, channel: match.channel };
  }
  return null;
}

export const CHANNEL_LABEL: Record<FunnelChannel, string> = { web: 'web', email: 'email', text: 'text' };
