import { lensLive } from "@/adapters/lens.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * GET → paradigms, versioned domains, the governed knowledge registry, and
 * the AI posture in one round trip. Registry attributes that are null are
 * UNKNOWN — the UI renders them as "unknown", never invents them.
 */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const [paradigms, domains, knowledgeSources, ai] = await Promise.all([
      lensLive.paradigms(session.token),
      lensLive.domains(session.token),
      lensLive.knowledgeSources(session.token),
      lensLive.aiStatus(session.token),
    ]);
    return { paradigms, domains, knowledgeSources, ai };
  });
}
