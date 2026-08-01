import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — a patient’s nutrition plans, versions, flags and check-ins. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { patientId?: unknown };
    if (typeof b.patientId !== "string" || !b.patientId) throw new AdapterError("invalid", "patientId is required");
    const session = await getRequestSession();
    return nutritionLive.getPatientNutrition(b.patientId, session.orgId, session.token);
  });
}
