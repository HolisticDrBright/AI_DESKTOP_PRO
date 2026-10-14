import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FunnelPage } from '@/components/funnels/FunnelPage';
import { allFunnels } from '@/funnels';
import { funnelUpdatesUrl } from '@/lib/campaignSignupUrl';
import { funnelPurchaseAvailability } from '@/server/commerce/funnel-purchase';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Private funnel draft review', robots: { index: false, follow: false } };

// This is deliberately outside the public /learn/<slug> allow-list. It displays
// repository text only, never clinical data, and cannot publish or charge.
export default async function FunnelDraftPreview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const funnel = allFunnels().find(item => item.slug === slug);
  if (!funnel) notFound();
  const purchase = await funnelPurchaseAvailability(funnel);
  const updatesUrl = funnelUpdatesUrl(funnel);
  return <section className="mx-auto max-w-[960px] px-5 py-8">
    <a href="/funnels" className="text-action underline">Back to Funnels</a>
    <aside className="my-5 rounded-lg border border-line bg-card p-5" aria-label="Draft purchase status">
      <h1 className="text-xl font-bold">Private draft review — not published</h1>
      <p>{funnel.draftNote}</p>
      <p>Both choices are shown below exactly as a visitor would see them: the consultation request, and the buy choice as the offer for the program answers it right now. {purchase.available ? 'An offer is available on the terms shown.' : `Direct purchase is unavailable: ${purchase.explanation}`} {updatesUrl ? ' The "Get updates about this program" link leads to the campaign service\'s sign-up page.' : ' No "Get updates" link is shown: the campaign sign-up address is not configured.'} This is not a published page.</p>
    </aside>
    <FunnelPage funnel={funnel} consultHref={`/consult/${funnel.consultSlug}`} purchase={purchase} buyHref={`/buy/${funnel.slug}`} updatesUrl={updatesUrl} />
  </section>;
}
