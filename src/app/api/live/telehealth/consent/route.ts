import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { jsonBody } from "../_shared";

/** POST consent attestation against the current approved artifact -> visit record (append-only consent). */
export async function POST(request: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const body = await jsonBody(request);
    return telehealthLive.recordConsent(body as unknown as Parameters<typeof telehealthLive.recordConsent>[0], session.token, session.orgId);
  });
}
