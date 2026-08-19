import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/aws-clinical-data.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

/**
 * POST — create an OPEN review task tied to the copilot run. Never sends a
 * notification, message, or external event.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runId !== "string" || !b.runId)
      throw new AdapterError("invalid", "runId is required.");
    if (typeof b.title !== "string" || !b.title.trim())
      throw new AdapterError("invalid", "title is required.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "create_copilot_review_task",
      {
        _organization_id: resolveOrgId(session.orgId),
        _run_id: b.runId,
        _title: b.title,
        _detail: typeof b.detail === "string" ? b.detail : null,
        _due_at: typeof b.dueAt === "string" ? b.dueAt : null,
      },
      token,
    );
  });
}
