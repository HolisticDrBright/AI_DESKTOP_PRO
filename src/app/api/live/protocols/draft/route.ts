import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { patientId, title, fromTemplateId? } -> new draft version. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new AdapterError("invalid", "A patient id is required.");
    }
    if (typeof b.title !== "string" || !b.title.trim()) {
      throw new AdapterError("invalid", "A protocol title is required.");
    }
    const session = await getRequestSession();
    return protocolsLive.createDraft(
      {
        patientId: b.patientId,
        title: b.title,
        fromTemplateId: typeof b.fromTemplateId === "string" ? b.fromTemplateId : null,
      },
      session.orgId,
      session.token,
    );
  });
}
