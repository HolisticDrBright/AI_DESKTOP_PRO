import { NextRequest } from "next/server";
import { encountersLive } from "@/adapters/encounters.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * GET ?patientId= → the longitudinal CLINICAL timeline (encounters, notes,
 * signatures, addenda, appointments). Security-audit events stay in
 * /audit-log — they are never mixed into the chart.
 */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const patientId = req.nextUrl.searchParams.get("patientId");
    if (!patientId) throw new AdapterError("invalid", "A patient is required.");
    const session = await getRequestSession();
    return encountersLive.timeline(patientId, session.token);
  });
}
