import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const POLICIES = ["consume", "release", "review"];

/** POST — set the org's explicit no-show / late-cancel credit policy. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!POLICIES.includes(String(b.noShowPolicy))) {
      throw new Error("noShowPolicy must be consume, release, or review");
    }
    if (!POLICIES.includes(String(b.lateCancelPolicy))) {
      throw new Error("lateCancelPolicy must be consume, release, or review");
    }
    if (b.consumeOn !== "arrived" && b.consumeOn !== "completed") {
      throw new Error("consumeOn must be arrived or completed");
    }
    const session = await getRequestSession();
    return plansLive.setBillingPolicy(
      {
        noShowPolicy: String(b.noShowPolicy),
        lateCancelPolicy: String(b.lateCancelPolicy),
        lateCancelWindowHours:
          typeof b.lateCancelWindowHours === "number" ? b.lateCancelWindowHours : 24,
        consumeOn: b.consumeOn,
      },
      session.orgId,
      session.token,
    );
  });
}
