import { getRequestSession } from "@/server/session";
import { disconnectFullscript } from "@/server/fullscript/runtime";
import { liveGuard, runLive } from "../../route-helpers";

export async function POST() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    await disconnectFullscript(await getRequestSession());
    return { disconnected: true };
  });
}
