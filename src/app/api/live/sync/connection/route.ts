import { NextRequest } from "next/server";
import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { connectionId, action: pause|resume|revoke, expectedVersion, reason? }. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      connectionId?: unknown;
      action?: unknown;
      expectedVersion?: unknown;
      reason?: unknown;
    };
    if (typeof b.connectionId !== "string" || !b.connectionId) {
      throw new Error("connectionId is required");
    }
    if (b.action !== "pause" && b.action !== "resume" && b.action !== "revoke") {
      throw new Error("action must be pause, resume, or revoke");
    }
    if (typeof b.expectedVersion !== "number") {
      throw new Error("expectedVersion is required");
    }
    const session = await getRequestSession();
    return patientSyncLive.connectionAction(
      {
        connectionId: b.connectionId,
        action: b.action,
        expectedVersion: b.expectedVersion,
        reason: typeof b.reason === "string" ? b.reason : null,
      },
      session.token,
    );
  });
}
