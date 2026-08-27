import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/aws-clinical-data.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

/**
 * POST — attach the copilot summary to a new DRAFT protocol version. Status
 * is always 'draft' — never approved, activated, or published by this call.
 * Never orders, bills, or messages.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runId !== "string" || !b.runId)
      throw new AdapterError("invalid", "runId is required.");
    if (typeof b.protocolId !== "string" || !b.protocolId)
      throw new AdapterError("invalid", "protocolId is required.");
    if (typeof b.title !== "string" || !b.title.trim())
      throw new AdapterError("invalid", "title is required.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "apply_copilot_run_to_protocol_draft",
      {
        _organization_id: resolveOrgId(session.orgId),
        _run_id: b.runId,
        _protocol_id: b.protocolId,
        _title: b.title,
        _summary: typeof b.summary === "string" ? b.summary : null,
      },
      token,
    );
  });
}
