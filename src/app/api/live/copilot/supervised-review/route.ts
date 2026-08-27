import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/aws-clinical-data.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

const DRAFT_ACTIONS = new Set(["apply_to_note", "apply_to_protocol_draft", "create_task"]);

/**
 * POST — record a secondary clinical review of a completed copilot run.
 * The author of the run CANNOT self-approve. No signing, activation,
 * ordering, billing, messaging, or publishing.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runId !== "string" || !b.runId)
      throw new AdapterError("invalid", "runId is required.");
    if (typeof b.draftAction !== "string" || !DRAFT_ACTIONS.has(b.draftAction))
      throw new AdapterError("invalid", "draftAction must be apply_to_note / apply_to_protocol_draft / create_task.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "approve_supervised_copilot_run",
      {
        _organization_id: resolveOrgId(session.orgId),
        _run_id: b.runId,
        _draft_action: b.draftAction,
        _note: typeof b.note === "string" ? b.note : null,
      },
      token,
    );
  });
}
