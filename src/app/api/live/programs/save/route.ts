import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import type { LiveProgramDraftPayload } from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { versionId, payload, expectedUpdatedAt } -> wholesale autosave.
 * A stale token surfaces as a conflict; the database validates every block.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      versionId?: unknown;
      payload?: unknown;
      expectedUpdatedAt?: unknown;
    };
    if (typeof b.versionId !== "string" || !b.versionId) {
      throw new Error("versionId is required");
    }
    if (b.payload === null || typeof b.payload !== "object") {
      throw new Error("payload is required");
    }
    const session = await getRequestSession();
    return programsLive.saveDraft(
      b.versionId,
      b.payload as LiveProgramDraftPayload,
      typeof b.expectedUpdatedAt === "string" ? b.expectedUpdatedAt : null,
      session.token,
    );
  });
}
