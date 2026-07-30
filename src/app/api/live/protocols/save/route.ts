import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import type { LiveProtocolDraftPayload } from "@/adapters/live-types";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { versionId, payload, expectedUpdatedAt } -> autosave.
 * `expectedUpdatedAt` is the optimistic-concurrency token; the RPC returns a
 * conflict when the draft moved elsewhere.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.versionId !== "string" || !b.versionId) {
      throw new AdapterError("invalid", "A version id is required.");
    }
    if (!b.payload || typeof b.payload !== "object") {
      throw new AdapterError("invalid", "A draft payload is required.");
    }
    const session = await getRequestSession();
    return protocolsLive.saveDraft(
      b.versionId,
      b.payload as LiveProtocolDraftPayload,
      typeof b.expectedUpdatedAt === "string" ? b.expectedUpdatedAt : null,
      session.token,
    );
  });
}
