if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type { LivePatientOverview } from "./live-types";

/**
 * Live patient overview (server-only).
 *
 * One bounded RPC — `get_patient_overview` — runs as the signed-in
 * practitioner (JWT), so the database enforces authentication, active org
 * membership, and patient access before a single row is aggregated. The DTO
 * arrives fully shaped from SQL: every list bounded, contact details reduced
 * to presence flags, and no field an invented value could fill. Absent data
 * renders as "Not enough verified data" — never as a fabricated number.
 */
export const overviewLive = {
  async getOverview(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePatientOverview> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePatientOverview>(
      "get_patient_overview",
      { _organization_id: orgId, _patient_id: patientId },
      token,
    );
  },
};
