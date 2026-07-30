import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { patientId } -> LivePatientProtocol (honest empty state when absent). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { patientId?: unknown };
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new AdapterError("invalid", "A patient id is required.");
    }
    const session = await getRequestSession();
    return protocolsLive.getPatientProtocol(b.patientId, session.orgId, session.token);
  });
}
