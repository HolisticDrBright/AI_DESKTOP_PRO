import { NextRequest } from "next/server";
import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { dayContext } from "../_shared";

/** GET ?appointmentId=&date=&timeZone= -> one telehealth appointment (resolved through the calendar) with its visit record. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const { date, timeZone } = dayContext(req.nextUrl.searchParams);
    return telehealthLive.visit(req.nextUrl.searchParams.get("appointmentId") ?? "", date, timeZone, session.token, session.orgId);
  });
}
