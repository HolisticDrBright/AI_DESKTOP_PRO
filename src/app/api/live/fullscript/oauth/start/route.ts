import { getRequestSession } from "@/server/session";
import { currentFullscriptSession } from "@/server/fullscript/clinic-authority";
import { beginFullscriptAuthorization } from "@/server/fullscript/runtime";
import { liveGuard, runLive } from "../../../route-helpers";

export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const { url } = beginFullscriptAuthorization(await currentFullscriptSession(await getRequestSession()));
    return { authorizationUrl: url };
  });
}
