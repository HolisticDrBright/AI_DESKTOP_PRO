import { plansLive } from "@/adapters/plans.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — sweep entitlements past their expiry into the expired bucket. */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return plansLive.expireCredits(session.orgId, session.token);
  });
}
