import { NextRequest } from "next/server";
import { billingLive } from "@/adapters/billing.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST — the practice-level billing workspace. Read-only projection. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      from?: unknown;
      to?: unknown;
      status?: unknown;
      practitionerUserId?: unknown;
      locationId?: unknown;
      method?: unknown;
    };
    const session = await getRequestSession();
    return billingLive.getWorkspace(
      {
        from: typeof b.from === "string" ? b.from : null,
        to: typeof b.to === "string" ? b.to : null,
        status: typeof b.status === "string" ? b.status : null,
        practitionerUserId:
          typeof b.practitionerUserId === "string" ? b.practitionerUserId : null,
        locationId: typeof b.locationId === "string" ? b.locationId : null,
        method: typeof b.method === "string" ? b.method : null,
      },
      session.orgId,
      session.token,
    );
  });
}
