if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import type {
  LiveAppointmentStatusResult,
  LiveBookInput,
  LiveBookResult,
  LiveCalendar,
  LiveRescheduleResult,
} from "./live-types";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";

interface CalendarRpcAppointment {
  id: string;
  patient_id: string | null;
  patient_name: string | null;
  practitioner_user_id: string | null;
  practitioner_name: string | null;
  title: string | null;
  appointment_type: string | null;
  location: string | null;
  telehealth_url: string | null;
  status: string;
  /** Optimistic-concurrency token for status transitions (migration 20260730042846). */
  version: number | null;
  starts_at: string | null;
  ends_at: string | null;
}

interface CalendarRpcResult {
  appointments: CalendarRpcAppointment[];
  practitioners: Array<{
    user_id: string;
    display_name: string | null;
    credentials: string | null;
    specialty: string | null;
  }>;
  patients: Array<{ id: string; name: string }>;
}

/**
 * Live `schedule` namespace (server-only).
 *
 * Calendar reads and atomic writes go directly to the Desktop clinical
 * Supabase project as the signed-in caller. The bounded calendar RPC returns
 * only scheduling fields, including a minimal patient picker for authorized
 * front-desk roles. Booking and rescheduling serialize same-practitioner and
 * same-patient requests before overlap checks; every mutation is audited.
 */
export const scheduleLive = {
  async getCalendar(
    fromIso: string,
    toIso: string,
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<LiveCalendar> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<CalendarRpcResult>("get_desktop_calendar", {
      _organization_id: resolveOrgId(orgId),
      _from: fromIso,
      _to: toIso,
    }, token);
    return {
      appointments: result.appointments.map((row) => ({
        id: row.id,
        patientId: row.patient_id,
        patientName: row.patient_name,
        practitionerUserId: row.practitioner_user_id,
        practitionerName: row.practitioner_name,
        title: row.title,
        appointmentType: row.appointment_type,
        location: row.location,
        telehealthUrl: row.telehealth_url,
        status: row.status,
        // Carried through so the drawer can send the version it actually
        // rendered: without it a transition would either clobber a concurrent
        // change or conflict against a token the client never saw.
        version: typeof row.version === "number" ? row.version : undefined,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
      })),
      practitioners: result.practitioners.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        credentials: row.credentials,
        specialty: row.specialty,
      })),
      patients: result.patients,
    };
  },

  async book(
    input: LiveBookInput,
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<LiveBookResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      id: string;
      status: string;
      starts_at: string;
      ends_at: string;
    }>("book_appointment", {
      _organization_id: resolveOrgId(orgId),
      _practitioner_user_id: input.practitionerUserId,
      _appointment_type: input.appointmentType,
      _starts_at: input.startsAtIso,
      _ends_at: input.endsAtIso,
      _patient_id: input.patientId ?? null,
      _location: input.location ?? null,
      _telehealth_url: null,
      _title: null,
    }, token);
    return {
      ok: true,
      id: result.id,
      status: result.status,
      startsAt: result.starts_at,
      endsAt: result.ends_at,
      message: "Appointment booked.",
    };
  },

  async updateStatus(
    appointmentId: string,
    status: string,
    sessionToken?: string | null,
  ): Promise<LiveAppointmentStatusResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      id: string;
      status: string;
      previous_status: string;
      already_set: boolean;
    }>("update_appointment_status", {
      _appointment_id: appointmentId,
      _status: status,
    }, token);
    return {
      ok: true,
      id: result.id,
      status: result.status,
      previousStatus: result.previous_status,
      alreadySet: result.already_set,
      message: result.already_set
        ? `Appointment is already ${result.status.replaceAll("_", "-")}.`
        : `Appointment ${result.status.replaceAll("_", "-")}.`,
    };
  },

  async reschedule(
    appointmentId: string,
    startsAtIso: string,
    endsAtIso: string,
    sessionToken?: string | null,
  ): Promise<LiveRescheduleResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      id: string;
      status: string;
      starts_at: string;
      ends_at: string;
    }>("reschedule_appointment", {
      _appointment_id: appointmentId,
      _starts_at: startsAtIso,
      _ends_at: endsAtIso,
    }, token);
    return {
      ok: true,
      id: result.id,
      status: result.status,
      startsAt: result.starts_at,
      endsAt: result.ends_at,
      message: "Appointment rescheduled.",
    };
  },
};
