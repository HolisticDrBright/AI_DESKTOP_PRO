import { NextRequest } from "next/server";
import { encountersLive } from "@/adapters/encounters.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../../route-helpers";

/**
 * POST { action, noteId, ... } — the note state machine's explicit actions:
 *   ready    {}                          draft → ready_for_review
 *   sign     { expectedVersion }         freeze content, idempotent
 *   addendum { reason, content }         append-only correction to a signed note
 *   error    { reason }                  entered_in_error (kept, never deleted)
 * All rules live in the SECURITY DEFINER RPCs; this route only shapes input.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const noteId = typeof body.noteId === "string" ? body.noteId : "";
    if (!noteId) throw new AdapterError("invalid", "A note is required.");
    const session = await getRequestSession();

    switch (action) {
      case "ready":
        return encountersLive.markNoteReady(noteId, session.token);
      case "sign": {
        const expectedVersion = Number(body.expectedVersion);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
          throw new AdapterError("invalid", "A valid version is required to sign.");
        }
        return encountersLive.signNote({ noteId, expectedVersion }, session.token);
      }
      case "addendum": {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!reason) throw new AdapterError("invalid", "A reason is required for an addendum.");
        if (!content) throw new AdapterError("invalid", "Addendum text is required.");
        return encountersLive.addAddendum({ noteId, reason, content }, session.token);
      }
      case "error": {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!reason) throw new AdapterError("invalid", "A reason is required.");
        return encountersLive.markNoteError({ noteId, reason }, session.token);
      }
      default:
        throw new AdapterError("invalid", "Unknown note action.");
    }
  });
}
