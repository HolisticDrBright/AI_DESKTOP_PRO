import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — archive a template, preserving every version. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.templateId !== "string" || !b.templateId) throw new AdapterError("invalid", "templateId is required");
    if (typeof b.reason !== "string" || !b.reason.trim()) throw new AdapterError("invalid", "reason is required");
    const session = await getRequestSession();
    return nutritionLive.archiveTemplate(
      { templateId: b.templateId, reason: b.reason },
      session.orgId,
      session.token,
    );
  });
}
