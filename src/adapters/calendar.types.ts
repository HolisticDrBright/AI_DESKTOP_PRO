import type { Tone } from "./types";

/**
 * Calendar vocabulary — appointment types, statuses, display metadata, and
 * row shapes — shared by the live schedule adapter and the calendar UI.
 * Extracted from the mock so the clinical runtime never imports fixtures;
 * the synthetic weekday-pattern calendar stays there, test-only.
 */

export type AppointmentType =
  | "initial"
  | "follow-up"
  | "lab-review"
  | "supplement"
  | "telehealth"
  | "group"
  | "break";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "arrived"
  | "in-encounter"
  | "completed"
  | "no-show"
  | "cancelled";

export interface AppointmentTypeMeta {
  type: AppointmentType;
  label: string;
  short: string;
  tone: Tone;
}

/** The color key. Type → tone drives every appointment's color + the legend. */
export const APPOINTMENT_TYPES: AppointmentTypeMeta[] = [
  { type: "initial", label: "Initial consult", short: "Initial", tone: "action" },
  { type: "follow-up", label: "Follow-up visit", short: "Follow-up", tone: "teal" },
  { type: "lab-review", label: "Lab review", short: "Lab review", tone: "ai" },
  { type: "supplement", label: "Supplement consult", short: "Supplement", tone: "positive" },
  { type: "telehealth", label: "Telehealth", short: "Telehealth", tone: "navy" },
  { type: "group", label: "Group session", short: "Group", tone: "warning" },
  { type: "break", label: "Break / admin", short: "Admin", tone: "slate" },
];

export const APPOINTMENT_TYPE_META: Record<AppointmentType, AppointmentTypeMeta> =
  Object.fromEntries(APPOINTMENT_TYPES.map((t) => [t.type, t])) as Record<
    AppointmentType,
    AppointmentTypeMeta
  >;

export interface Practitioner {
  id: string;
  name: string;
  role: string;
  initials: string;
  tone: Tone;
}

export interface Appointment {
  id: string;
  practitionerId: string;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Minutes from midnight. */
  start: number;
  durationMin: number;
  type: AppointmentType;
  patientName: string;
  patientId?: string;
  location: string;
}

export interface CalendarData {
  practitioners: Practitioner[];
  appointments: Appointment[];
  /** Working-hours window shown in the grid, in minutes from midnight. */
  dayStart: number;
  dayEnd: number;
}
