import { NextRequest } from "next/server";
import { encountersLive } from "@/adapters/encounters.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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
    if (!patientId || !UUID.test(patientId)) {
      throw new AdapterError("invalid", "A valid patient is required.");
    }
    const session = await getRequestSession();
    return encountersLive.timeline(patientId, session.token);
  });
}
