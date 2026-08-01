import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — publish a template version, freezing its content. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.templateVersionId !== "string" || !b.templateVersionId) {
      throw new Error("templateVersionId is required");
    }
    const session = await getRequestSession();
    return nutritionLive.publishTemplateVersion(b.templateVersionId, session.orgId, session.token);
  });
}
