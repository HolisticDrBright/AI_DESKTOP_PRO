import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JoinUnsubscribed } from '@/components/campaigns/JoinPages';
import { campaignApiCall, campaignEngineEnabled } from '@/server/campaign-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };

/**
 * The unsubscribe link in every email's footer: one click, and it takes effect at once. (A scanner that opens the
 * link unsubscribes the reader; that errs toward fewer emails, never more.)
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!campaignEngineEnabled()) notFound();
  const { t } = await searchParams;
  if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{40,600}$/.test(t)) return <JoinUnsubscribed outcome="invalid" />;
  try {
    const { outcome } = await campaignApiCall<{ outcome: 'unsubscribed' | 'invalid' }>({ method: 'POST', path: '/campaigns/public/unsubscribe', body: { token: t } });
    return <JoinUnsubscribed outcome={outcome === 'unsubscribed' ? 'unsubscribed' : 'invalid'} />;
  } catch { return <JoinUnsubscribed outcome="unavailable" />; }
}
