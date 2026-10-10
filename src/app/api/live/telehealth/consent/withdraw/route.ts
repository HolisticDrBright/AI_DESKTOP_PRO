import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../../route-helpers";
import { jsonBody } from "../../_shared";

/** POST withdrawal -> receipts marked withdrawn, governed grant revoked; the visit cannot start afterwards. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.withdrawConsent(body as unknown as Parameters<typeof telehealthLive.withdrawConsent>[0], session.token, session.orgId);
  });
}
