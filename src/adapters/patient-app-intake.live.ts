if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type { LivePatientAppIntake } from "./live-types";

export const patientAppIntakeLive = {
  async get(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePatientAppIntake> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientAppIntake>("get_patient_app_intake", {
      _organization_id: resolveOrgId(organizationId),
      _patient_id: patientId,
    }, token);
  },
};

