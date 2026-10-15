import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JoinConfirm } from '@/components/campaigns/JoinPages';
import { campaignEngineEnabled } from '@/server/campaign-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Confirm your sign-up', robots: { index: false, follow: false } };

/** Following the link shows a button; only pressing it confirms (a mail scanner that opens links confirms nobody). */
export default async function JoinConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!campaignEngineEnabled()) notFound();
  const { t, o } = await searchParams;
  const token = typeof t === 'string' && /^[A-Za-z0-9_-]{40,600}$/.test(t) ? t : null;
  return <JoinConfirm token={token} outcome={typeof o === 'string' ? o : null} />;
}
