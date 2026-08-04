import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — safe bulk operations. Only three actions are ever offered here:
 *   {action: "assign_reviewer", itemIds, assignee, reason}
 *   {action: "apply_org_tag", itemIds, tag, reason}
 *   {action: "mark_duplicate", itemIds, duplicateOfItemId, reason}
 *
 * Every clinically-loaded outcome — approval, label verification,
 * restriction clearance, jurisdictional clearance, evidence grading,
 * product-identity matching, commercial matching, protocol activation,
 * publishing — is deliberately NOT offered as a bulk action. Those live
 * on their own governed single-subject RPCs.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();
    if (!Array.isArray(b.itemIds) || b.itemIds.length === 0)
      throw new AdapterError("invalid", "itemIds must be a non-empty array.");
    if (b.itemIds.length > 500)
      throw new AdapterError("invalid", "bulk operation upper bound is 500 items.");
    if (typeof b.reason !== "string" || !b.reason.trim())
      throw new AdapterError("invalid", "reason is required.");

    if (b.action === "assign_reviewer") {
      if (typeof b.assignee !== "string" || !b.assignee)
        throw new AdapterError("invalid", "assignee is required.");
      return importReviewLive.bulkAssignReviewer(
        { itemIds: b.itemIds as string[], assignee: b.assignee, reason: b.reason },
        session.orgId,
        session.token,
      );
    }
    if (b.action === "apply_org_tag") {
      if (typeof b.tag !== "string" || !b.tag.trim())
        throw new AdapterError("invalid", "tag is required.");
      return importReviewLive.bulkApplyOrgTag(
        { itemIds: b.itemIds as string[], tag: b.tag, reason: b.reason },
        session.orgId,
        session.token,
      );
    }
    if (b.action === "mark_duplicate") {
      if (typeof b.duplicateOfItemId !== "string" || !b.duplicateOfItemId)
        throw new AdapterError("invalid", "duplicateOfItemId is required.");
      return importReviewLive.bulkMarkDuplicate(
        { itemIds: b.itemIds as string[], duplicateOfItemId: b.duplicateOfItemId, reason: b.reason },
        session.orgId,
        session.token,
      );
    }
    throw new AdapterError("invalid", "unknown action; only assign_reviewer / apply_org_tag / mark_duplicate are offered as bulk.");
  });
}
