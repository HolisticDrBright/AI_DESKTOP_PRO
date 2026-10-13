import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PurchasePage, holdWords } from "@/components/funnels/PurchasePage";
import { PURCHASE_HOLD_EXPLANATIONS } from "@/contracts/programOffers";
import { resolvePurchaseRuntime } from "@/server/commerce/program-commerce-runtime";
import { resolvePublicFunnel } from "@/server/commerce/journey-fixture";
import { consultLinkUrl } from "@/lib/consultLinkUrl";
import { funnelPageUrl, publicSiteOrigin } from "@/lib/publicSite";
import { funnelPurchaseAvailability } from "@/server/commerce/funnel-purchase";

/**
 * The purchase page behind a funnel's buy choice. Public, server-rendered, never indexed: it shows
 * the exact terms the server read for the bound program, or the specific reason direct purchase is
 * unavailable, and offers the consult address either way. Starting checkout is the program-checkout
 * boundary of a later unit; this page reports it as not configured rather than pretending.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const funnel = await resolvePublicFunnel(slug);
  return { title: funnel ? `Buy the ${funnel.programLabel} — The Holistic Approach` : "Page not found", robots: { index: false, follow: false } };
}

export default async function BuyRoute({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const query = await searchParams;
  const funnel = await resolvePublicFunnel(slug);
  if (!funnel) notFound();
  const consultHref = consultLinkUrl(funnel.consultSlug, publicSiteOrigin() ?? undefined) ?? `/consult/${funnel.consultSlug}`;
  const purchase = await funnelPurchaseAvailability(funnel);
  const runtime = (await resolvePurchaseRuntime()).kind;
  const checkout = runtime === "fictional" || runtime === "reviewed"
    ? { ready: true as const }
    : { ready: false as const, reason: "checkout_unconfigured" as const, explanation: PURCHASE_HOLD_EXPLANATIONS.checkout_unconfigured };
  return (
    <PurchasePage funnel={funnel} consultHref={consultHref} purchase={purchase} learnHref={funnelPageUrl(funnel.slug) ?? `/learn/${funnel.slug}`} checkout={checkout}
      hold={holdWords(typeof query.hold === "string" ? query.hold : undefined)} />
  );
}
