import { NextRequest } from "next/server";
import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET ?appointmentId= -> the visit record including its note (if any). */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return telehealthLive.note(req.nextUrl.searchParams.get("appointmentId") ?? "", session.token);
  });
}
