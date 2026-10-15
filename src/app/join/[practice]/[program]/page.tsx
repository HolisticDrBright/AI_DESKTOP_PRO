import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { joinPageInfo } from '@/campaigns/contract';
import { JoinForm, JoinUnavailable } from '@/components/campaigns/JoinPages';
import { CampaignApiError, campaignApiCall, campaignEngineEnabled } from '@/server/campaign-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Get updates', robots: { index: false, follow: false } };

/** A practice's sign-up page for one program. It exists only while the engine is on and the practice can send. */
export default async function JoinPage({ params, searchParams }: { params: Promise<{ practice: string; program: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!campaignEngineEnabled()) notFound();
  const { practice, program } = await params;
  const problem = (await searchParams).problem;
  try {
    const info = joinPageInfo.parse(await campaignApiCall({ method: 'GET', path: `/campaigns/public/join/${encodeURIComponent(practice)}/${encodeURIComponent(program)}` }));
    return <JoinForm info={info} practice={practice} problem={typeof problem === 'string' ? problem : null} />;
  } catch (error) {
    if (error instanceof CampaignApiError && error.status === 404) notFound();
    return <JoinUnavailable />;
  }
}
