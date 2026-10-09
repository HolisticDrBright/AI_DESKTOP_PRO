import { NextRequest } from "next/server";
import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET ?appointmentId=&date= -> one telehealth appointment with its visit record. */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return telehealthLive.visit(
      req.nextUrl.searchParams.get("appointmentId") ?? "",
      req.nextUrl.searchParams.get("date") ?? "",
      session.token,
      session.orgId,
    );
  });
}
