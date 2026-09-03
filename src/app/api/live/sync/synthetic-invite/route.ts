import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { issueSyntheticPatientInvitation } from "@/server/clinical-core/synthetic-api-client";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;

  return runLive(async () => {
    if (process.env.CLINICAL_AWS_RUNTIME_MODE !== "synthetic" || process.env.PHI_ALLOWED === "true") {
      throw new AdapterError("forbidden", "This test connection flow is not available here.");
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || typeof body.patientId !== "string" || !UUID.test(body.patientId)) {
      throw new AdapterError("invalid", "Select a valid anonymous test chart.");
    }
    const session = await getRequestSession();
    if (!session.token) throw new AdapterError("unauthenticated");
    try {
      return await issueSyntheticPatientInvitation(session.token, body.patientId);
    } catch (cause) {
      throw new AdapterError(
        "unavailable",
        "A connection code could not be created. Refresh the chart and try again.",
        cause instanceof Error ? cause.message : undefined,
      );
    }
  });
}
