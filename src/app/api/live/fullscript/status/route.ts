import { getRequestSession } from "@/server/session";
import { fullscriptPosture } from "@/server/fullscript/runtime";
import { liveGuard, runLive } from "../../route-helpers";

export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => fullscriptPosture(await getRequestSession()));
}
