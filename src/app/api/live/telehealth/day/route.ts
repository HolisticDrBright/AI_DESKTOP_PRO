import { NextRequest } from "next/server";
import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET ?date=YYYY-MM-DD -> the day's telehealth visits (calendar + visit boundary). */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return telehealthLive.day(req.nextUrl.searchParams.get("date") ?? "", session.token, session.orgId);
  });
}
