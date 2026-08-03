import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const OUTCOMES = new Set([
  "retain_restricted",
  "request_evidence",
  "defer",
  "reject",
  "clinician_reviewed_for_jurisdiction",
]);

/** GET — restricted-review history for a specific product. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const productId = req.nextUrl.searchParams.get("productId");
    if (!productId) {
      throw new AdapterError("invalid", "A product id is required.");
    }
    const session = await getRequestSession();
    return importReviewLive.restrictedReviewHistory(
      productId,
      session.orgId,
      session.token,
    );
  });
}

/**
 * POST — record one of five governed restricted-review outcomes.
 *
 * `retain_restricted`, `request_evidence`, `defer`, `reject`, or
 * `clinician_reviewed_for_jurisdiction`. Every outcome requires a stated
 * reason; the clinician outcome additionally requires a jurisdiction. None
 * of these clears the restriction — clearance is a separate governed action.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.productId !== "string" || !b.productId) {
      throw new AdapterError("invalid", "A product id is required.");
    }
    if (typeof b.outcome !== "string" || !OUTCOMES.has(b.outcome)) {
      throw new AdapterError(
        "invalid",
        "Outcome must be one of: retain_restricted, request_evidence, defer, reject, clinician_reviewed_for_jurisdiction.",
      );
    }
    if (typeof b.reason !== "string" || !b.reason.trim()) {
      throw new AdapterError("invalid", "A stated reason is required.");
    }
    if (
      b.outcome === "clinician_reviewed_for_jurisdiction" &&
      (typeof b.jurisdiction !== "string" || !b.jurisdiction.trim())
    ) {
      throw new AdapterError(
        "invalid",
        "clinician_reviewed_for_jurisdiction requires a jurisdiction.",
      );
    }
    const session = await getRequestSession();
    return importReviewLive.recordRestrictedReviewOutcome(
      {
        productId: b.productId,
        outcome: b.outcome as
          | "retain_restricted"
          | "request_evidence"
          | "defer"
          | "reject"
          | "clinician_reviewed_for_jurisdiction",
        reason: b.reason,
        jurisdiction: typeof b.jurisdiction === "string" ? b.jurisdiction : null,
      },
      session.orgId,
      session.token,
    );
  });
}
