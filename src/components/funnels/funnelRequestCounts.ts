import { funnelConsultSlugs, type FunnelChannel, type FunnelDefinition } from '@/funnels';

/**
 * Requests per program and per channel, counted from what the clinic's queue already records: each
 * request carries the slug of the link it came through, and each funnel channel has its own slug. Counts
 * only; no name, address, reference or reason leaves this function.
 *
 * The queue list is the newest requests first, at most `QUEUE_READ_LIMIT` of them. When a full page comes
 * back, anything older than its oldest row was not seen, so a window reaching past that row is a lower
 * bound ("at least"), never presented as the whole count.
 */
export const QUEUE_READ_LIMIT = 200;
export const COUNT_WINDOWS = [7, 30] as const;
export type CountWindow = typeof COUNT_WINDOWS[number];
export type QueueRow = { slug: string; receivedAt: string };
export type QueueRead = { state: 'loading' } | { state: 'failed' } | { state: 'read'; requests: QueueRow[] };
export type WindowCount = { count: number; atLeast: boolean };
export type ChannelCounts = { channel: FunnelChannel; slug: string; windows: Record<CountWindow, WindowCount> };

const DAY = 86_400_000;

export function funnelRequestCounts(funnel: FunnelDefinition, requests: readonly QueueRow[], now: Date): ChannelCounts[] {
  const truncated = requests.length >= QUEUE_READ_LIMIT;
  const oldestSeen = requests.reduce((oldest, row) => Math.min(oldest, Date.parse(row.receivedAt)), Number.POSITIVE_INFINITY);
  return funnelConsultSlugs(funnel).map(({ channel, slug }) => {
    const windows = {} as Record<CountWindow, WindowCount>;
    for (const days of COUNT_WINDOWS) {
      const from = now.getTime() - days * DAY;
      const count = requests.filter(row => row.slug === slug && Date.parse(row.receivedAt) >= from).length;
      windows[days] = { count, atLeast: truncated && oldestSeen >= from };
    }
    return { channel, slug, windows };
  });
}

export function formatWindowCount(value: WindowCount): string {
  return value.atLeast ? `at least ${value.count}` : String(value.count);
}
