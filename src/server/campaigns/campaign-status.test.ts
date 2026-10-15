import { describe, expect, it, vi } from 'vitest';
import { readCampaignStatus } from './campaign-status';

const env = { CAMPAIGN_STATS_URL: 'http://lead-signup.internal:8080/internal/counts', CAMPAIGN_STATS_TOKEN: 's'.repeat(40), CAMPAIGN_DASHBOARD_URL: 'https://campaigns.fictional.example/dashboard' };
const counts = { contract: 'lead-campaigns/1', sending: { ready: true, missing: [] }, lists: [{ program: 'longevity-program', confirmed: 3 }, { program: 'weight-loss-program', confirmed: 0 }, { program: 'diabetes-program', confirmed: 1 }],
  recentSends: [{ name: 'Fictional broadcast', sentAt: '2026-10-12T16:00:00.000Z', delivered: 4, bounced: 0, unsubscribed: null }] };
const reply = (body: unknown, ok = true) => vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({ ok, text: async () => JSON.stringify(body) }));

describe('the Desktop\'s read of the campaign service', () => {
  it('is not configured without the counts address and a long token; nothing is fetched', async () => {
    const fetcher = reply(counts);
    for (const partial of [{}, { ...env, CAMPAIGN_STATS_TOKEN: 'short' }, { ...env, CAMPAIGN_STATS_URL: 'http://lead-signup.internal:8080/admin' }]) {
      expect(await readCampaignStatus(partial, fetcher as never)).toEqual({ state: 'not_configured' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends the bearer token and accepts counts only', async () => {
    const fetcher = reply(counts);
    expect(await readCampaignStatus(env, fetcher as never)).toEqual({ state: 'ok', counts, dashboardUrl: env.CAMPAIGN_DASHBOARD_URL });
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${env.CAMPAIGN_STATS_TOKEN}`);
  });
  it('anything else is unavailable, never an empty list: an error, a person in the reply, a missing list', async () => {
    expect(await readCampaignStatus(env, reply(counts, false) as never)).toEqual({ state: 'unavailable' });
    expect(await readCampaignStatus(env, reply({ ...counts, subscribers: [{ email: 'ava@fictional.example' }] }) as never)).toEqual({ state: 'unavailable' });
    expect(await readCampaignStatus(env, reply({ ...counts, lists: counts.lists.slice(1) }) as never)).toEqual({ state: 'unavailable' });
    expect(await readCampaignStatus(env, vi.fn(async () => { throw new Error('down'); }) as never)).toEqual({ state: 'unavailable' });
  });
});
