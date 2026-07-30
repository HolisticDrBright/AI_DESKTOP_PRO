import { NextRequest } from "next/server";
import { reasoningLive } from "@/adapters/reasoning.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { patientId } -> LiveReasoningWorkspace (RLS + access gated). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as { patientId?: unknown };
    if (typeof body.patientId !== "string" || !body.patientId) {
      throw new AdapterError("invalid", "A patient id is required.");
    }
    const session = await getRequestSession();
    return reasoningLive.getWorkspace(body.patientId, session.orgId, session.token);
  });
}
