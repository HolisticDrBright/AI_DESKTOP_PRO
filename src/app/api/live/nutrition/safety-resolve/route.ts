import { NextRequest } from "next/server";
import { nutritionLive } from "@/adapters/nutrition.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — acknowledge, override or resolve a safety flag. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.flagId !== "string" || !b.flagId) throw new AdapterError("invalid", "flagId is required");
    if (b.action !== "acknowledge" && b.action !== "override" && b.action !== "resolve") {
      throw new AdapterError("invalid", "action must be acknowledge, override or resolve");
    }
    // The reason is required for an override at the database too; refusing it
    // here means the practitioner gets a useful message instead of a SQLSTATE.
    if (b.action === "override" && (typeof b.reason !== "string" || !b.reason.trim())) {
      throw new AdapterError("invalid", "overriding a safety flag requires a reason");
    }
    const session = await getRequestSession();
    return nutritionLive.resolveSafetyFlag(
      { flagId: b.flagId, action: b.action, reason: typeof b.reason === "string" ? b.reason : null },
      session.orgId,
      session.token,
    );
  });
}
