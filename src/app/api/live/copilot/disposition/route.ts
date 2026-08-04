import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

const DISP = new Set(["accepted", "dismissed", "info_requested", "superseded"]);

/**
 * POST — record the practitioner's disposition on a copilot run. Never
 * touches a clinical row; never signs a note, activates a protocol,
 * orders a lab, prescribes, bills, or sends a message.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runId !== "string" || !b.runId)
      throw new AdapterError("invalid", "runId is required.");
    if (typeof b.disposition !== "string" || !DISP.has(b.disposition))
      throw new AdapterError("invalid", "disposition must be one of the four governed values.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "record_copilot_disposition",
      {
        _organization_id: resolveOrgId(session.orgId),
        _run_id: b.runId,
        _disposition: b.disposition,
      },
      token,
    );
  });
}
