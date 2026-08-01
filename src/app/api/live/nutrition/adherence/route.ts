import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — adherence over a window, counting missing days as missing. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) throw new AdapterError("invalid", "patientId is required");
    const days = typeof b.days === "number" ? b.days : 30;
    const session = await getRequestSession();
    return nutritionLive.getAdherenceSummary(
      { patientId: b.patientId, days },
      session.orgId,
      session.token,
    );
  });
}
