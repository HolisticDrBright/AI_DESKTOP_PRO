import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";

/**
 * GET — copilot run history for a patient. Tenant-scoped through the RPC.
 */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const patientId = req.nextUrl.searchParams.get("patientId");
    if (!patientId) throw new AdapterError("invalid", "patientId is required.");
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "get_copilot_runs_for_patient",
      {
        _organization_id: resolveOrgId(session.orgId),
        _patient_id: patientId,
        _limit: 50,
      },
      token,
    );
  });
}
