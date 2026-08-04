import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — governed product-label editor actions.
 *   {action: "create_draft", productCode, productName, brand, exactLabel, ...}
 *   {action: "verify", labelVersionId, verificationNote}
 *   {action: "supersede", supersedesId, exactLabel, reason, ...}
 *
 * GET — list versions for a product_code.
 *   ?productCode=<code>
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();
    const action = b.action;
    if (action === "create_draft") {
      if (typeof b.productCode !== "string" || !b.productCode)
        throw new AdapterError("invalid", "productCode is required.");
      if (typeof b.productName !== "string" || !b.productName)
        throw new AdapterError("invalid", "productName is required.");
      if (typeof b.brand !== "string" || !b.brand)
        throw new AdapterError("invalid", "brand is required.");
      if (typeof b.exactLabel !== "object" || b.exactLabel === null)
        throw new AdapterError("invalid", "exactLabel is required.");
      return importReviewLive.createProductLabelDraft(b as Parameters<typeof importReviewLive.createProductLabelDraft>[0], session.orgId, session.token);
    }
    if (action === "verify") {
      if (typeof b.labelVersionId !== "string" || !b.labelVersionId)
        throw new AdapterError("invalid", "labelVersionId is required.");
      if (typeof b.verificationNote !== "string" || !b.verificationNote.trim())
        throw new AdapterError("invalid", "verificationNote is required.");
      return importReviewLive.verifyProductLabelVersion(
        { labelVersionId: b.labelVersionId, verificationNote: b.verificationNote },
        session.orgId,
        session.token,
      );
    }
    if (action === "supersede") {
      if (typeof b.supersedesId !== "string" || !b.supersedesId)
        throw new AdapterError("invalid", "supersedesId is required.");
      if (typeof b.reason !== "string" || !b.reason.trim())
        throw new AdapterError("invalid", "reason is required.");
      if (typeof b.exactLabel !== "object" || b.exactLabel === null)
        throw new AdapterError("invalid", "exactLabel is required.");
      return importReviewLive.supersedeProductLabelVersion(b as Parameters<typeof importReviewLive.supersedeProductLabelVersion>[0], session.orgId, session.token);
    }
    throw new AdapterError("invalid", "unknown action.");
  });
}

export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const productCode = req.nextUrl.searchParams.get("productCode");
    if (!productCode) throw new AdapterError("invalid", "productCode is required.");
    const session = await getRequestSession();
    return importReviewLive.listProductLabelVersions(productCode, session.orgId, session.token);
  });
}
