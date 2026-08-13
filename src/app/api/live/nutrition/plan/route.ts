import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — start a patient plan, snapshotting the source template. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) throw new AdapterError("invalid", "patientId is required");
    if (typeof b.title !== "string" || !b.title.trim()) throw new AdapterError("invalid", "title is required");
    const session = await getRequestSession();
    return nutritionLive.createPlan(
      {
        patientId: b.patientId,
        title: b.title,
        sourceTemplateVersionId:
          typeof b.sourceTemplateVersionId === "string" ? b.sourceTemplateVersionId : null,
      },
      session.orgId,
      session.token,
    );
  });
}
