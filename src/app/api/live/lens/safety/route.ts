import { NextRequest } from "next/server";
import { lensLive } from "@/adapters/lens.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { blockId, resolution } → review a safety block. Blocks are the
 * REVIEWABLE record of a failed safety rule — evidence is immutable; review
 * adds who/when/how it was resolved.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const blockId = typeof body.blockId === "string" ? body.blockId : "";
    const resolution = typeof body.resolution === "string" ? body.resolution.trim() : "";
    if (!blockId) throw new AdapterError("invalid", "A safety block is required.");
    if (!resolution) throw new AdapterError("invalid", "A resolution note is required.");
    const session = await getRequestSession();
    return lensLive.reviewSafetyBlock({ blockId, resolution }, session.token);
  });
}
