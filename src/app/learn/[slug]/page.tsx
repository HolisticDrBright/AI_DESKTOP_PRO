import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FunnelPage } from "@/components/funnels/FunnelPage";
import { publishedFunnel } from "@/funnels";
import { consultLinkUrl } from "@/lib/consultLinkUrl";
import { funnelPageUrl, indexingAllowed, publicSiteOrigin } from "@/lib/publicSite";

/**
 * A program funnel page. Public, rendered on the server from the definition alone: no session,
 * no API call, no data read. A draft and an unknown slug answer the same not-found. Search
 * engines may index it only on the production origin; everywhere else it is served noindex and
 * its canonical address is omitted, whatever the definition says.
 */
export const dynamic = "force-static";
export const dynamicParams = true;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const funnel = publishedFunnel(slug);
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
  const funnel = publishedFunnel(slug);
  if (!funnel) notFound();
  const consultHref = consultLinkUrl(funnel.consultSlug, publicSiteOrigin() ?? undefined) ?? `/consult/${funnel.consultSlug}`;
  return <FunnelPage funnel={funnel} consultHref={consultHref} />;
}
