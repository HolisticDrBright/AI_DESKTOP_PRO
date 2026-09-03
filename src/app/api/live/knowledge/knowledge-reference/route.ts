import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — governed knowledge-reference editor actions.
 * GET  — list references for the caller's organization.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();
    const action = b.action;
    if (action === "create_draft") {
      if (typeof b.claim !== "string" || !b.claim.trim())
        throw new AdapterError("invalid", "claim is required.");
      return importReviewLive.createKnowledgeReferenceDraft(
        b as Parameters<typeof importReviewLive.createKnowledgeReferenceDraft>[0],
        session.orgId,
        session.token,
      );
    }
    if (action === "approve") {
      if (typeof b.referenceId !== "string" || !b.referenceId)
        throw new AdapterError("invalid", "referenceId is required.");
      if (typeof b.verificationReason !== "string" || !b.verificationReason.trim())
        throw new AdapterError("invalid", "verificationReason is required.");
      return importReviewLive.approveKnowledgeReference(
        { referenceId: b.referenceId, verificationReason: b.verificationReason },
        session.orgId,
        session.token,
      );
    }
    if (action === "supersede") {
      if (typeof b.supersedesId !== "string" || !b.supersedesId)
        throw new AdapterError("invalid", "supersedesId is required.");
      if (typeof b.newClaim !== "string" || !b.newClaim.trim())
        throw new AdapterError("invalid", "newClaim is required.");
      if (typeof b.reason !== "string" || !b.reason.trim())
        throw new AdapterError("invalid", "reason is required.");
      return importReviewLive.supersedeKnowledgeReference(
        { supersedesId: b.supersedesId, newClaim: b.newClaim, reason: b.reason },
        session.orgId,
        session.token,
      );
    }
    throw new AdapterError("invalid", "unknown action.");
  });
}

export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return importReviewLive.listKnowledgeReferences(session.orgId, session.token);
  });
}
