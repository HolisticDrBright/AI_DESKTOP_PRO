import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { knowledgeLive } from "@/adapters/knowledge.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      itemId?: unknown;
      decision?: unknown;
      reviewNote?: unknown;
    };
    if (
      typeof body.itemId !== "string"
      || (body.decision !== "accept" && body.decision !== "reject")
    ) {
      throw new AdapterError("invalid", "A review item and decision are required.");
    }
    const session = await getRequestSession();
    if (!session.orgId) throw new AdapterError("forbidden", "An active organization is required.");
    return knowledgeLive.reviewImportItem(
      session.orgId,
      body.itemId,
      body.decision,
      typeof body.reviewNote === "string" ? body.reviewNote : undefined,
      session.token,
    );
  });
}
