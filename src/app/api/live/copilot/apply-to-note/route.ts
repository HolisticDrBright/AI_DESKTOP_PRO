import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/aws-clinical-data.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

/**
 * POST — attach the copilot excerpt to an UNSIGNED clinical note as a new
 * draft version. The parent note is never signed by this call. Never orders,
 * bills, or messages.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runId !== "string" || !b.runId)
      throw new AdapterError("invalid", "runId is required.");
    if (typeof b.noteId !== "string" || !b.noteId)
      throw new AdapterError("invalid", "noteId is required.");
    if (!b.content || typeof b.content !== "object")
      throw new AdapterError("invalid", "content is required.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const contentJson = JSON.stringify(b.content);
    const contentSha256 = createHash("sha256").update(contentJson).digest("hex");
    return clinicalRpc(
      "apply_copilot_run_to_note",
      {
        _organization_id: resolveOrgId(session.orgId),
        _run_id: b.runId,
        _note_id: b.noteId,
        _content: b.content,
        _content_sha256: contentSha256,
      },
      token,
    );
  });
}
