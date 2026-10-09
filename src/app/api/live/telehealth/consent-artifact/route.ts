import { telehealthLive } from "@/adapters/telehealth.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** GET -> the practice's current approved telehealth consent artifact (id, version, hash, jurisdiction). */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return telehealthLive.consentArtifact(session.token);
  });
}
