import { NextRequest } from "next/server";
import { encountersLive } from "@/adapters/encounters.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { patientId } -> the patient's documentable encounters (in progress or
 * completed), so "add message to note" targets a REAL encounter's unsigned
 * draft instead of a free-text id.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { patientId?: unknown };
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new Error("patientId is required");
    }
    const session = await getRequestSession();
    const encounters = await encountersLive.forPatient(b.patientId, session.token);
    return encounters
      .filter((e) => e.status === "in_progress" || e.status === "completed")
      .map((e) => ({
        encounterId: e.encounterId,
        visitType: e.visitType,
        status: e.status,
        startedAt: e.startedAt,
      }));
  });
}
