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

const SUBJECT_TYPES = new Set(["product", "preview_item", "knowledge_reference"]);

/**
 * GET — restricted-review history for a specific subject.
 *
 * Accepts either the legacy `productId` query param (routes to
 * `subjectType=product`) or the new `subjectType`/`subjectId` pair for
 * preview items and governed knowledge references.
 */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const productId = req.nextUrl.searchParams.get("productId");
    const subjectType = req.nextUrl.searchParams.get("subjectType");
    const subjectId = req.nextUrl.searchParams.get("subjectId");
    const session = await getRequestSession();
    if (productId && !subjectType) {
      return importReviewLive.restrictedReviewHistory(productId, session.orgId, session.token);
    }
    if (!subjectType || !SUBJECT_TYPES.has(subjectType)) {
      throw new AdapterError(
        "invalid",
        "subjectType must be one of: product, preview_item, knowledge_reference.",
      );
    }
    if (!subjectId) {
      throw new AdapterError("invalid", "A subject id is required.");
    }
    return importReviewLive.restrictedReviewHistory(
      {
        subjectType: subjectType as "product" | "preview_item" | "knowledge_reference",
        subjectId,
      },
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
 *
 * Phase 9E-A.1 continuation: accepts `subjectType`/`subjectId` to review a
 * preview import item or governed knowledge reference in addition to a
 * committed catalog product. The legacy `productId` field is still accepted
 * and routes to `subjectType=product`.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const hasNewShape = typeof b.subjectType === "string" && typeof b.subjectId === "string";
    const hasLegacyShape = typeof b.productId === "string";
    if (!hasNewShape && !hasLegacyShape) {
      throw new AdapterError("invalid", "subjectType/subjectId (or legacy productId) is required.");
    }
    if (hasNewShape) {
      if (!SUBJECT_TYPES.has(b.subjectType as string)) {
        throw new AdapterError(
          "invalid",
          "subjectType must be one of: product, preview_item, knowledge_reference.",
        );
      }
      if (typeof b.subjectId !== "string" || !b.subjectId) {
        throw new AdapterError("invalid", "A subject id is required.");
      }
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
        subjectType: hasNewShape
          ? (b.subjectType as "product" | "preview_item" | "knowledge_reference")
          : "product",
        subjectId: hasNewShape ? (b.subjectId as string) : (b.productId as string),
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
