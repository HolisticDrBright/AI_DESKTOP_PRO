import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — read the content of exactly one version. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const templateVersionId = typeof b.templateVersionId === "string" ? b.templateVersionId : null;
    const planVersionId = typeof b.planVersionId === "string" ? b.planVersionId : null;
    if ((templateVersionId === null) === (planVersionId === null)) {
      throw new AdapterError("invalid", "ask for exactly one of templateVersionId or planVersionId");
    }
    const session = await getRequestSession();
    return nutritionLive.getVersionContent(
      { templateVersionId, planVersionId },
      session.orgId,
      session.token,
    );
  });
}
