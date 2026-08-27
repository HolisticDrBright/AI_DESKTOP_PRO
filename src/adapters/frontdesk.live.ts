if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type { LiveAppointmentStatus, LiveTransitionResult } from "./live-types";

/**
 * Live front-desk namespace (server-only).
 *
 * `transition_appointment` is the single transition authority: the database
 * enforces the state machine, the optimistic version check, and the
 * idempotency-key replay, then appends the status event and audit row in one
 * transaction. NOTE there is no organization argument — membership is checked
 * against the appointment ROW's organization, so a forged org id has nothing
 * to attach to.
 *
 * Corrections out of a terminal status are a separate, admin-only RPC.
 */
export const frontDeskLive = {
  async transition(
    input: {
      appointmentId: string;
      toStatus: LiveAppointmentStatus;
      expectedVersion?: number | null;
      idempotencyKey?: string | null;
      reason?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveTransitionResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveTransitionResult>(
      "transition_appointment",
      {
        _appointment_id: input.appointmentId,
        _to_status: input.toStatus,
        _expected_version: input.expectedVersion ?? null,
        _idempotency_key: input.idempotencyKey ?? null,
        _reason: input.reason ?? null,
      },
      token,
    );
  },

  async correct(
    input: {
      appointmentId: string;
      toStatus: LiveAppointmentStatus;
      reason: string;
      expectedVersion?: number | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveTransitionResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveTransitionResult>(
      "correct_appointment_status",
      {
        _appointment_id: input.appointmentId,
        _to_status: input.toStatus,
        _reason: input.reason,
        _expected_version: input.expectedVersion ?? null,
      },
      token,
    );
  },
};
