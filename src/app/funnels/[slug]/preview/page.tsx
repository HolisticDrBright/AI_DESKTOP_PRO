import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FunnelPage } from '@/components/funnels/FunnelPage';
import { allFunnels } from '@/funnels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Private funnel draft review', robots: { index: false, follow: false } };

// This is deliberately outside the public /learn/<slug> allow-list. It displays
// repository text only, never clinical data, and cannot publish or charge.
export default async function FunnelDraftPreview({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const funnel = allFunnels().find(item => item.slug === slug);
  if (!funnel) notFound();
  return <section className="mx-auto max-w-[960px] px-5 py-8">
    <a href="/funnels" className="text-action underline">Back to Funnels</a>
    <aside className="my-5 rounded-lg border border-line bg-card p-5" aria-label="Draft purchase status">
      <h1 className="text-xl font-bold">Private draft review — not published</h1>
      <p>{funnel.draftNote}</p>
      <p>Planned choices: book a consultation or buy this program. Prices are not selected; paid checkout and automatic access are not connected. This is not a live offer.</p>
      <button type="button" disabled className="mt-3 rounded-lg bg-line px-5 py-3">Buy program — not configured</button>
    </aside>
    <FunnelPage funnel={funnel} consultHref={`/consult/${funnel.consultSlug}`} />
  </section>;
}
