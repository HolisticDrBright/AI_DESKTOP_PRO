import { telehealthRequestsLive } from "@/adapters/telehealth-requests.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../route-helpers";

export async function POST(request: Request) {
  const blocked = liveGuard(); if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession(); const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return telehealthRequestsLive.payment(session.token, body as Record<string, unknown>);
  });
}
