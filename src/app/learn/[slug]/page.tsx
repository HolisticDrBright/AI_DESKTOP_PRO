import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FunnelPage } from "@/components/funnels/FunnelPage";
import { resolvePublicFunnel } from "@/server/commerce/journey-fixture";
import { funnelPageLinks } from "@/lib/funnelPageLinks";
import { funnelPageUrl, indexingAllowed } from "@/lib/publicSite";
import { funnelPurchaseAvailability } from "@/server/commerce/funnel-purchase";

/**
 * A program funnel page. Public, rendered on the server from the definition and one server-side read
 * of the program's offer: no session, no browser request, no clinical data. A draft and an unknown
 * slug answer the same not-found. Search engines may index it only on the production origin;
 * everywhere else it is served noindex and its canonical address is omitted, whatever the definition
 * says. The buy choice is a link only when the offer is available now; otherwise the page says why.
 *
 * `?via=` is read from a fixed list only to choose which consult link the button points at (a campaign
 * email's visitor reaches the program's email link). Nothing about it is stored, logged or set as a
 * cookie, and the canonical address never carries it. "Get updates about this program" appears only when
 * the campaign service's sign-up origin is configured.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const funnel = await resolvePublicFunnel(slug);
  if (!funnel) return { title: "Page not found", robots: { index: false, follow: false } };
  const allowed = indexingAllowed() && funnel.indexable;
  const canonical = allowed ? funnelPageUrl(funnel.slug) : null;
  return {
    title: `${funnel.title} — The Holistic Approach`,
    description: funnel.description,
    robots: allowed ? { index: true, follow: true } : { index: false, follow: false },
    ...(canonical ? { alternates: { canonical } } : {}),
  };
}

export default async function FunnelRoute({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const funnel = await resolvePublicFunnel(slug);
  if (!funnel) notFound();
  const { consultHref, updatesUrl } = funnelPageLinks(funnel, (await searchParams).via);
  const purchase = await funnelPurchaseAvailability(funnel);
  return <FunnelPage funnel={funnel} consultHref={consultHref} purchase={purchase} buyHref={`/buy/${funnel.slug}`} updatesUrl={updatesUrl} />;
}
