import { NextRequest } from "next/server";
import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — read the reconciliation workspace, or resolve one exception. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await getRequestSession();

    if (b.action === "resolve") {
      if (typeof b.exceptionId !== "string" || !b.exceptionId) {
        throw new Error("exceptionId is required");
      }
      if (b.resolution !== "resolved" && b.resolution !== "dismissed") {
        throw new Error("resolution must be resolved or dismissed");
      }
      const reason = typeof b.reason === "string" ? b.reason.trim() : "";
      if (!reason) throw new Error("Resolving an exception needs a reason.");
      if (typeof b.expectedVersion !== "number" || !Number.isFinite(b.expectedVersion)) {
        throw new Error("expectedVersion is required");
      }
      return plansLive.resolveException(
        {
          exceptionId: b.exceptionId,
          resolution: b.resolution,
          reason,
          expectedVersion: b.expectedVersion,
        },
        session.orgId,
        session.token,
      );
    }

    return plansLive.getReconciliation(
      typeof b.status === "string" ? b.status : "open",
      session.orgId,
      session.token,
    );
  });
}
