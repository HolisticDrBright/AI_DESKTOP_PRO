import { getRequestSession } from "@/server/session";
import { beginFullscriptAuthorization } from "@/server/fullscript/runtime";
import { liveGuard, runLive } from "../../../route-helpers";

export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const { url } = beginFullscriptAuthorization(await getRequestSession());
    return { authorizationUrl: url };
  });
}
