import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/** POST { name, fromTemplateId? } -> blank draft or detached template copy. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      fromTemplateId?: unknown;
    };
    if (typeof b.name !== "string" || !b.name.trim()) {
      throw new Error("a program name is required");
    }
    const session = await getRequestSession();
    return programsLive.createProgram(
      {
        name: b.name.trim(),
        fromTemplateId: typeof b.fromTemplateId === "string" ? b.fromTemplateId : null,
      },
      session.orgId,
      session.token,
    );
  });
}
