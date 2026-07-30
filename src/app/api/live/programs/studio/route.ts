import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { programId } -> LiveProgramStudio (program, versions, offers, roster). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as { programId?: unknown };
    if (typeof b.programId !== "string" || !b.programId) {
      throw new Error("programId is required");
    }
    const session = await getRequestSession();
    return programsLive.getStudio(b.programId, session.token);
  });
}
