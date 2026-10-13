import type { Metadata } from "next";

import { ReturnPage } from "@/components/funnels/ReturnPage";
import { knownFunnel } from "@/server/commerce/journey-fixture";
import { consultLinkUrl } from "@/lib/consultLinkUrl";
import { publicSiteOrigin } from "@/lib/publicSite";
import { resolvePurchaseRuntime } from "@/server/commerce/program-commerce-runtime";

/**
 * Where the processor sends the visitor back. The address names an opaque order and an outcome
 * kind, and nothing here treats either as evidence: the page reads the order's state from the
 * ledger and says what it is. A paid order is `payment_verified` only once the authoritative object
 * was retrieved and bound (the webhook path), so the usual honest answer on arrival is "being
 * confirmed". Never indexed; a missing or unknown order is said to be unknown, not failed.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Returning from checkout — The Holistic Approach", robots: { index: false, follow: false } };

export default async function BuyReturnRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const orderParam = typeof params.order === "string" ? params.order : "";
  const returned = params.returned === "success" ? "success" : params.returned === "cancel" ? "cancel" : "unknown";
  const orderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderParam) ? orderParam : null;
  const selection = await resolvePurchaseRuntime();
  const status = orderId && (selection.kind === "fictional" || selection.kind === "reviewed") ? await selection.checkout.returnStatus(orderId) : { state: "unknown" as const };
  const order = orderId && (selection.kind === "fictional" || selection.kind === "reviewed") ? await selection.ledger.readOrder(orderId).catch(() => null) : null;
  const funnel = order ? knownFunnel(order.funnelSlug) : null;
  const consultHref = funnel ? consultLinkUrl(funnel.consultSlug, publicSiteOrigin() ?? undefined) ?? `/consult/${funnel.consultSlug}` : null;
  return <ReturnPage returned={returned} state={status.state} learnHref={funnel ? `/learn/${funnel.slug}` : null} consultHref={consultHref} />;
}
