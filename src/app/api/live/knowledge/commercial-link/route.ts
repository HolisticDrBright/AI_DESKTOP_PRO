import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — governed commercial-link actions:
 *   {action: "attach", labelVersionId, incomingSku|incomingUpc|incomingManufacturer|incomingProductName,
 *    affiliateUrl, disclosure, matchReason, [discountCode]}
 *   {action: "revoke", linkId, reason}
 *
 * GET — list active + superseded links for a label version.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();
    if (b.action === "attach") {
      if (typeof b.labelVersionId !== "string" || !b.labelVersionId)
        throw new AdapterError("invalid", "labelVersionId is required.");
      if (typeof b.affiliateUrl !== "string" || !b.affiliateUrl.trim())
        throw new AdapterError("invalid", "affiliateUrl is required.");
      if (typeof b.disclosure !== "string" || !b.disclosure.trim())
        throw new AdapterError("invalid", "disclosure is required.");
      if (typeof b.matchReason !== "string" || !b.matchReason.trim())
        throw new AdapterError("invalid", "matchReason is required.");
      const anyIdent =
        [b.incomingSku, b.incomingUpc, b.incomingManufacturer, b.incomingProductName]
          .some((v) => typeof v === "string" && v.trim().length > 0);
      if (!anyIdent)
        throw new AdapterError(
          "invalid",
          "An identifier is required (SKU, UPC, manufacturer, or product name).",
        );
      return importReviewLive.attachCommercialLink(
        {
          labelVersionId: b.labelVersionId,
          incomingSku: typeof b.incomingSku === "string" ? b.incomingSku : null,
          incomingUpc: typeof b.incomingUpc === "string" ? b.incomingUpc : null,
          incomingManufacturer:
            typeof b.incomingManufacturer === "string" ? b.incomingManufacturer : null,
          incomingProductName:
            typeof b.incomingProductName === "string" ? b.incomingProductName : null,
          affiliateUrl: b.affiliateUrl,
          discountCode: typeof b.discountCode === "string" ? b.discountCode : null,
          disclosure: b.disclosure,
          matchReason: b.matchReason,
        },
        session.orgId,
        session.token,
      );
    }
    if (b.action === "revoke") {
      if (typeof b.linkId !== "string" || !b.linkId)
        throw new AdapterError("invalid", "linkId is required.");
      if (typeof b.reason !== "string" || !b.reason.trim())
        throw new AdapterError("invalid", "reason is required.");
      return importReviewLive.revokeCommercialLink(
        { linkId: b.linkId, reason: b.reason },
        session.orgId,
        session.token,
      );
    }
    throw new AdapterError("invalid", "unknown action; use attach or revoke.");
  });
}

export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const labelVersionId = req.nextUrl.searchParams.get("labelVersionId");
    if (!labelVersionId) throw new AdapterError("invalid", "labelVersionId is required.");
    const session = await getRequestSession();
    return importReviewLive.listCommercialLinks(labelVersionId, session.orgId, session.token);
  });
}
