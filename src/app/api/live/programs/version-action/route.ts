import { NextRequest } from "next/server";
import { programsLive } from "@/adapters/programs.live";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST { action, versionId?, programId?, note? } — the explicit lifecycle
 * actions. `approve` freezes without publishing; `publish` is separate and
 * confirmed in the UI; `revise` copies a frozen version into a new draft;
 * `archive`/`restore` act on the program without touching history.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      versionId?: unknown;
      programId?: unknown;
      note?: unknown;
    };
    const session = await getRequestSession();
    const versionId = typeof b.versionId === "string" ? b.versionId : "";
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
    switch (b.action) {
      case "submit":
        return programsLive.submitVersion(versionId, session.token);
      case "return":
        return programsLive.returnVersion(versionId, note, session.token);
      case "approve":
        return programsLive.approveVersion(versionId, note, session.token);
      case "publish":
        return programsLive.publishVersion(versionId, session.token);
      case "revise":
        return programsLive.reviseVersion(versionId, session.token);
      case "archive":
      case "restore": {
        if (typeof b.programId !== "string" || !b.programId) {
          throw new Error("programId is required");
        }
        return programsLive.archiveProgram(b.programId, b.action === "archive", session.token);
      }
      default:
        throw new Error("unknown program action");
    }
  });
}
