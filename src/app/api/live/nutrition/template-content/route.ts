import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — replace a draft template version’s content. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.templateVersionId !== "string" || !b.templateVersionId) {
      throw new AdapterError("invalid", "templateVersionId is required");
    }
    const session = await getRequestSession();
    return nutritionLive.saveTemplateContent(
      { templateVersionId: b.templateVersionId, content: b.content ?? {} },
      session.orgId,
      session.token,
    );
  });
}
