import { NextRequest } from "next/server";
import { importReviewLive } from "@/adapters/import-review.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const SUBJECT_TYPES = new Set(["preview_item", "product", "knowledge_reference"]);
const DISPOSITIONS = new Set(["resolved", "superseded", "accepted_risk", "not_applicable"]);

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.subjectType !== "string" || !SUBJECT_TYPES.has(b.subjectType))
      throw new AdapterError("invalid", "subjectType must be preview_item / product / knowledge_reference.");
    if (typeof b.subjectId !== "string" || !b.subjectId)
      throw new AdapterError("invalid", "subjectId is required.");
    if (typeof b.warningKey !== "string" || !b.warningKey.trim())
      throw new AdapterError("invalid", "warningKey is required.");
    if (typeof b.disposition !== "string" || !DISPOSITIONS.has(b.disposition))
      throw new AdapterError("invalid", "disposition must be one of the four governed dispositions.");
    if (typeof b.reason !== "string" || !b.reason.trim())
      throw new AdapterError("invalid", "reason is required.");
    const session = await getRequestSession();
    return importReviewLive.recordWarningResolution(
      {
        subjectType: b.subjectType as "preview_item" | "product" | "knowledge_reference",
        subjectId: b.subjectId,
        warningKey: b.warningKey,
        disposition: b.disposition as "resolved" | "superseded" | "accepted_risk" | "not_applicable",
        reason: b.reason,
      },
      session.orgId,
      session.token,
    );
  });
}

export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const subjectType = req.nextUrl.searchParams.get("subjectType");
    const subjectId = req.nextUrl.searchParams.get("subjectId");
    if (!subjectType || !SUBJECT_TYPES.has(subjectType))
      throw new AdapterError("invalid", "subjectType is required.");
    if (!subjectId) throw new AdapterError("invalid", "subjectId is required.");
    const session = await getRequestSession();
    return importReviewLive.listWarningResolutions(
      { subjectType: subjectType as "preview_item" | "product" | "knowledge_reference", subjectId },
      session.orgId,
      session.token,
    );
  });
}
