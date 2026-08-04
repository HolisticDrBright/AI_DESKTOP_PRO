import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

const DISPOSITIONS = new Set([
  "accepted",
  "dismissed",
  "info_requested",
  "superseded",
  "flagged_unsafe",
  "regeneration_requested",
  "citation_failure",
]);

const REQUIRES_NOTE = new Set(["flagged_unsafe", "regeneration_requested", "citation_failure"]);

/**
 * POST — extended practitioner disposition on a copilot run. Superset of
 * the Phase 10A four values. Never signs, activates, orders, bills,
 * messages, or publishes.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.runId !== "string" || !b.runId)
      throw new AdapterError("invalid", "runId is required.");
    if (typeof b.disposition !== "string" || !DISPOSITIONS.has(b.disposition))
      throw new AdapterError("invalid", "disposition must be one of the governed values.");
    if (REQUIRES_NOTE.has(b.disposition) && (typeof b.note !== "string" || !b.note.trim()))
      throw new AdapterError("invalid", "note is required for this disposition.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "record_copilot_disposition_extended",
      {
        _organization_id: resolveOrgId(session.orgId),
        _run_id: b.runId,
        _disposition: b.disposition,
        _note: typeof b.note === "string" ? b.note : null,
      },
      token,
    );
  });
}
