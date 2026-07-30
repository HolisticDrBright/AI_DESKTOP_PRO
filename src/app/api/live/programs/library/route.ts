import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { query?, status?, limit? } -> LiveProgramLibrary (persisted rows only). */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      query?: unknown;
      status?: unknown;
      limit?: unknown;
    };
    const query = typeof b.query === "string" && b.query.trim() ? b.query.trim() : null;
    const status = typeof b.status === "string" && b.status ? b.status : null;
    const limit = typeof b.limit === "number" && Number.isFinite(b.limit) ? b.limit : 50;
    const session = await getRequestSession();
    return programsLive.listPrograms(query, status, limit, session.orgId, session.token);
  });
}
