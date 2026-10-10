import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../../route-helpers";
import { jsonBody } from "../../_shared";

/** POST transfer -> place the SIGNED visit record into the chart as an UNSIGNED draft (bound, idempotent). */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.transferToChart(body as unknown as Parameters<typeof telehealthLive.transferToChart>[0], session.token, session.orgId);
  });
}
