if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { ACTIVE_ORG_ID } from "./config";
import type {
  LiveAppointmentStatusResult,
  LiveBookInput,
  LiveBookResult,
  LiveCalendar,
} from "./live-types";

/**
 * Live `schedule` namespace (server-only).
 *
 * Reads a week of appointments through `clinical.schedule.getCalendar`
 * (RLS-scoped: patient rows require patient access; patient-NULL breaks are
 * org-visible — migration 0017). Writes go through the 0017 SECURITY DEFINER
 * RPCs via the backend: booking rejects double-booking for both the
 * practitioner and the patient, status changes follow the transition rules,
 * and every write appends an audit_events row atomically.
 */
export const scheduleLive = {
  getCalendar(fromIso: string, toIso: string, sessionToken?: string | null): Promise<LiveCalendar> {
    return trpcQuery<LiveCalendar>(
      "clinical.schedule.getCalendar",
      { organizationId: ACTIVE_ORG_ID, fromIso, toIso },
      sessionToken,
    );
  },

  book(input: LiveBookInput, sessionToken?: string | null): Promise<LiveBookResult> {
    return trpcMutation<LiveBookResult>(
      "clinical.schedule.book",
      { organizationId: ACTIVE_ORG_ID, ...input },
      sessionToken,
    );
  },

  updateStatus(
    appointmentId: string,
    status: string,
    sessionToken?: string | null,
  ): Promise<LiveAppointmentStatusResult> {
    return trpcMutation<LiveAppointmentStatusResult>(
      "clinical.schedule.updateStatus",
      { appointmentId, status },
      sessionToken,
    );
  },
};
