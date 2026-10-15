import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JoinSent } from '@/components/campaigns/JoinPages';
import { campaignEngineEnabled } from '@/server/campaign-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Check your email', robots: { index: false, follow: false } };

export default function JoinSentPage() {
  if (!campaignEngineEnabled()) notFound();
  return <JoinSent />;
}
