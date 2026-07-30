import { patientSyncLive } from "@/adapters/patient-sync.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST {} -> organization-level synchronization operations posture. */
export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    return patientSyncLive.orgOperations(session.orgId, session.token);
  });
}
