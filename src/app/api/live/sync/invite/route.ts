import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { patientId } -> a scoped connection invitation. The response carries
 * the one-time token (only its hash exists server-side) and states honestly
 * that no delivery provider is configured.
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
    return patientSyncLive.createInvitation(b.patientId, session.orgId, session.token);
  });
}
