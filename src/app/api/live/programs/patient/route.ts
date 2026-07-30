import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { patientId } -> LivePatientPrograms (patient-access gated). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { patientId?: unknown };
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new Error("patientId is required");
    }
    const session = await getRequestSession();
    return programsLive.getPatientPrograms(b.patientId, session.token);
  });
}
