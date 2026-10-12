import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FunnelPage } from "@/components/funnels/FunnelPage";
import { resolvePublicFunnel } from "@/server/commerce/journey-fixture";
import { consultLinkUrl } from "@/lib/consultLinkUrl";
import { funnelPageUrl, indexingAllowed, publicSiteOrigin } from "@/lib/publicSite";
import { funnelPurchaseAvailability } from "@/server/commerce/funnel-purchase";

/**
 * A program funnel page. Public, rendered on the server from the definition and one server-side read
 * of the program's offer: no session, no browser request, no clinical data. A draft and an unknown
 * slug answer the same not-found. Search engines may index it only on the production origin;
 * everywhere else it is served noindex and its canonical address is omitted, whatever the definition
 * says. The buy choice is a link only when the offer is available now; otherwise the page says why.
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

export default async function FunnelRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const funnel = await resolvePublicFunnel(slug);
  if (!funnel) notFound();
  const consultHref = consultLinkUrl(funnel.consultSlug, publicSiteOrigin() ?? undefined) ?? `/consult/${funnel.consultSlug}`;
  const purchase = await funnelPurchaseAvailability(funnel);
  return <FunnelPage funnel={funnel} consultHref={consultHref} purchase={purchase} buyHref={`/buy/${funnel.slug}`} />;
}
