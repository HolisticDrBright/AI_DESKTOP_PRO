import { NextRequest } from "next/server";
import { protocolTemplateLive } from "@/adapters/product-catalog.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — one template: versions, items, safety reviews, patient preview. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { templateId?: unknown };
    if (typeof b.templateId !== "string" || !b.templateId) {
      throw new AdapterError("invalid", "A template id is required.");
    }
    const session = await getRequestSession();
    return protocolTemplateLive.detail(b.templateId, session.token);
  });
}
