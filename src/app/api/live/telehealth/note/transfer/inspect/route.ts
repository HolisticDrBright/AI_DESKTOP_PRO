import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../../../route-helpers";
import { jsonBody } from "../../../_shared";

/** POST inspect -> read the chart's receipt back for an admitted transfer; never writes the chart. */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.inspectTransfer(String(body.appointmentId ?? ""), session.token);
  });
}
