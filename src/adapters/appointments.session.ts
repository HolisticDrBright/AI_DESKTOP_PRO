"use client";

/**
 * Front-desk appointment state (MOCK). The calendar template stays fixed;
 * arrivals, check-ins, no-shows, cancellations, reschedules, copies, and
 * per-appointment notes are session overlays — visibly demo, never
 * persisted. Every change writes a session audit entry.
 */
import type { Appointment, AppointmentType } from "./calendar.mock";
import { createSessionStore, newSessionId } from "./session-kv";
import { recordAuditEntry } from "./session-store";

export type FrontDeskStatus =
  | "arrived"
  | "checked-in"
  | "no-show"
  | "cancelled"
  | "completed"
  | "rescheduled";

export interface ApptOverride {
  status?: FrontDeskStatus;
  note?: string;
  rescheduledToLabel?: string;
  checkoutInvoiceId?: string;
}

export interface SessionAppointment extends Appointment {
  sessionAdded: true;
}

interface ApptSessionState {
  overrides: Record<string, ApptOverride>;
  added: SessionAppointment[];
}

const store = createSessionStore<ApptSessionState>("aidp:demo:appts", {
  overrides: {},
  added: [],
});

export function useApptSession(): ApptSessionState {
  return store.use();
}

export function getApptSession(): ApptSessionState {
  return store.get();
}

export function getApptOverride(id: string): ApptOverride | undefined {
  return store.get().overrides[id];
}

function patch(id: string, patchValue: Partial<ApptOverride>) {
  store.update((s) => ({
    ...s,
    overrides: { ...s.overrides, [id]: { ...s.overrides[id], ...patchValue } },
  }));
}

export function setFrontDeskStatus(
  appt: Pick<Appointment, "id" | "patientName" | "type">,
  status: FrontDeskStatus,
  detail?: string,
) {
  patch(appt.id, { status, ...(detail ? { rescheduledToLabel: detail } : {}) });
  recordAuditEntry({
    kind: "appointment_status",
    subjectType: "appointment",
    subjectLabel: `${statusLabel(status)}${detail ? ` → ${detail}` : ""} · ${appt.type}`,
    patientName: appt.patientName,
    reviewed: true,
  });
  return {
    ok: true,
    message: `${statusLabel(status)} recorded for ${appt.patientName}. (demo — this session only)`,
  };
}

export function setAppointmentNote(
  appt: Pick<Appointment, "id" | "patientName">,
  note: string,
) {
  patch(appt.id, { note });
  recordAuditEntry({
    kind: "appointment_status",
    subjectType: "appointment note",
    subjectLabel: note.length > 42 ? `${note.slice(0, 42)}…` : note,
    patientName: appt.patientName,
    reviewed: true,
  });
  return { ok: true, message: "Appointment note saved. (demo — this session only)" };
}

export function linkCheckoutInvoice(apptId: string, invoiceId: string) {
  patch(apptId, { checkoutInvoiceId: invoiceId, status: "completed" });
}

/** Copy an appointment into a nearby slot this session. */
export function copyAppointment(src: Appointment): SessionAppointment {
  const copy: SessionAppointment = {
    ...src,
    id: `appt-s-${newSessionId().slice(0, 8)}`,
    start: Math.min(src.start + 60, 18 * 60),
    sessionAdded: true,
  };
  store.update((s) => ({ ...s, added: [...s.added, copy] }));
  recordAuditEntry({
    kind: "schedule_appointment",
    subjectType: "appointment",
    subjectLabel: `Copied ${src.type} slot`,
    patientName: src.patientName,
    reviewed: true,
  });
  return copy;
}

/** Reschedule = mark original + add the new session slot. */
export function rescheduleAppointment(
  src: Appointment,
  target: { weekday: number; start: number; label: string },
) {
  const moved: SessionAppointment = {
    ...src,
    id: `appt-s-${newSessionId().slice(0, 8)}`,
    weekday: target.weekday,
    start: target.start,
    sessionAdded: true,
  };
  store.update((s) => ({
    ...s,
    added: [...s.added, moved],
    overrides: {
      ...s.overrides,
      [src.id]: { ...s.overrides[src.id], status: "rescheduled", rescheduledToLabel: target.label },
    },
  }));
  recordAuditEntry({
    kind: "appointment_status",
    subjectType: "appointment",
    subjectLabel: `Rescheduled → ${target.label} · ${src.type}`,
    patientName: src.patientName,
    reviewed: true,
  });
  return { ok: true, message: `Rescheduled to ${target.label}. (demo — this session only)` };
}

export function statusLabel(s: FrontDeskStatus): string {
  switch (s) {
    case "arrived": return "Arrived";
    case "checked-in": return "Checked in";
    case "no-show": return "No-show";
    case "cancelled": return "Cancelled";
    case "completed": return "Completed";
    case "rescheduled": return "Rescheduled";
  }
}

export const STATUS_TONE: Record<FrontDeskStatus, "positive" | "teal" | "critical" | "slate" | "action"> = {
  arrived: "teal",
  "checked-in": "positive",
  "no-show": "critical",
  cancelled: "slate",
  completed: "positive",
  rescheduled: "action",
};

/** Sensible telehealth-readiness fixture for a telehealth appointment. */
export function telehealthReadiness(appt: Appointment): {
  ready: boolean;
  detail: string;
} {
  if (appt.type !== "telehealth") return { ready: true, detail: "In-clinic visit" };
  // Deterministic per id so the demo is stable.
  const ready = appt.id.charCodeAt(appt.id.length - 1) % 3 !== 0;
  return ready
    ? { ready: true, detail: "Room link ready · patient confirmed" }
    : { ready: false, detail: "Patient has not confirmed the room link" };
}

export function typeLabel(t: AppointmentType): string {
  return t === "follow-up" ? "Follow-up" : t.charAt(0).toUpperCase() + t.slice(1).replace("-", " ");
}
