import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — create or rename a template. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.name !== "string" || !b.name.trim()) throw new AdapterError("invalid", "name is required");
    const session = await getRequestSession();
    return nutritionLive.upsertTemplate(
      {
        templateId: typeof b.templateId === "string" ? b.templateId : null,
        name: b.name,
        pattern: typeof b.pattern === "string" ? b.pattern : "custom",
        summary: typeof b.summary === "string" ? b.summary : null,
        expectedVersion: typeof b.expectedVersion === "number" ? b.expectedVersion : null,
      },
      session.orgId,
      session.token,
    );
  });
}
