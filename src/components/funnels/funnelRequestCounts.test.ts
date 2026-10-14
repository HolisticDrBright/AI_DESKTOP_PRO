import { describe, expect, it } from 'vitest';
import { longevityProgram } from '@/funnels/definitions/longevity-program';
import { formatWindowCount, funnelRequestCounts, QUEUE_READ_LIMIT, type QueueRow } from './funnelRequestCounts';

/**
 * Requests per program and per channel over 7 and 30 days, counted from the slug each queue row already
 * carries. A full page of the newest requests is a lower bound for any window reaching past its oldest row.
 */
const now = new Date('2026-10-14T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const row = (slug: string, days: number): QueueRow => ({ slug, receivedAt: daysAgo(days) });

describe('request counts', () => {
  it('count by the channel link a request came through, in each window, and ignore other links', () => {
    const requests = [
      row('longevity-program', 1), row('longevity-program', 6.9), row('longevity-program', 8), row('longevity-program', 31),
      row('longevity-program-email', 2), row('longevity-program-email', 20),
      row('diabetes-program', 1), row('fictional-clinic-link', 1),
    ];
    expect(funnelRequestCounts(longevityProgram, requests, now)).toEqual([
      { channel: 'web', slug: 'longevity-program', windows: { 7: { count: 2, atLeast: false }, 30: { count: 3, atLeast: false } } },
      { channel: 'email', slug: 'longevity-program-email', windows: { 7: { count: 1, atLeast: false }, 30: { count: 2, atLeast: false } } },
    ]);
  });
  it('are zero, exactly, for an empty queue', () => {
    expect(funnelRequestCounts(longevityProgram, [], now).map(c => c.windows)).toEqual([
      { 7: { count: 0, atLeast: false }, 30: { count: 0, atLeast: false } },
      { 7: { count: 0, atLeast: false }, 30: { count: 0, atLeast: false } },
    ]);
  });
  it('are a lower bound when a full page was read and the window reaches past its oldest row', () => {
    const full = Array.from({ length: QUEUE_READ_LIMIT }, (_, i) => row(i % 2 ? 'longevity-program' : 'other-link', 10 + i * 0.05));
    const [web] = funnelRequestCounts(longevityProgram, full, now);
    // The oldest row seen is about 20 days old: the 7-day window is complete, the 30-day window is not.
    expect(web!.windows[7]).toEqual({ count: 0, atLeast: false });
    expect(web!.windows[30]).toEqual({ count: 100, atLeast: true });
    expect(formatWindowCount(web!.windows[30])).toBe('at least 100');
    expect(formatWindowCount(web!.windows[7])).toBe('0');
    // A full page that already reaches past the window is exact for it.
    const deep = Array.from({ length: QUEUE_READ_LIMIT }, (_, i) => row('longevity-program', i * 0.19));
    expect(funnelRequestCounts(longevityProgram, deep, now)[0]!.windows).toEqual({ 7: { count: 37, atLeast: false }, 30: { count: 158, atLeast: false } });
  });
});
