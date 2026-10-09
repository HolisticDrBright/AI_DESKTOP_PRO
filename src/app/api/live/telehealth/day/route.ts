import { NextRequest } from "next/server";
import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { dayContext } from "../_shared";

/** GET ?date=YYYY-MM-DD&timeZone=IANA -> the day's telehealth visits in the viewer's zone (calendar + visit boundary). */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const { date, timeZone } = dayContext(req.nextUrl.searchParams);
    return telehealthLive.day(date, timeZone, session.token, session.orgId);
  });
}
