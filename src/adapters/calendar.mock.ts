import type { Tone } from "./types";

/**
 * MOCK calendar / scheduling data.
 *
 * A recurring weekly template (by weekday) so any week the practitioner
 * navigates to is populated realistically. Appointments are color-coded by
 * TYPE (each type carries a semantic tone); status is derived at render time
 * from the slot's date vs. now, so past slots read as completed and today's
 * upcoming ones as confirmed. Session/demo only — nothing is persisted.
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

export const PRACTITIONERS: Practitioner[] = [
  { id: "pr-sarah", name: "Dr. Sarah Mitchell", role: "Functional Medicine", initials: "SM", tone: "action" },
  { id: "pr-james", name: "Dr. James Okafor", role: "Integrative MD", initials: "JO", tone: "teal" },
  { id: "pr-rachel", name: "Rachel Nguyen, RD", role: "Dietitian", initials: "RN", tone: "positive" },
];

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

const T = (h: number, m = 0) => h * 60 + m;

// [practitionerId, weekday, start, duration, type, patientName, patientId|null, location]
type Row = [
  string,
  number,
  number,
  number,
  AppointmentType,
  string,
  string | null,
  string,
];

const ROWS: Row[] = [
  // ── Dr. Sarah Mitchell ───────────────────────────────────────────────────
  ["pr-sarah", 1, T(8, 0), 45, "initial", "Priya Shah", null, "Room 2"],
  ["pr-sarah", 1, T(9, 0), 30, "follow-up", "Michael Johnson", "p-64201", "Room 2"],
  ["pr-sarah", 1, T(9, 45), 30, "lab-review", "David Chen", null, "Room 2"],
  ["pr-sarah", 1, T(10, 30), 30, "break", "—", null, "Admin block"],
  ["pr-sarah", 1, T(11, 15), 45, "initial", "Sofia Ramirez", null, "Room 2"],
  ["pr-sarah", 1, T(13, 0), 30, "telehealth", "Ethan Brooks", null, "Telehealth"],
  ["pr-sarah", 1, T(14, 0), 60, "supplement", "Alexandra Morgan", "p-78435", "Room 2"],
  ["pr-sarah", 1, T(15, 30), 30, "follow-up", "Olivia Bennett", null, "Room 2"],
  ["pr-sarah", 2, T(8, 30), 30, "follow-up", "Marcus Lee", null, "Room 2"],
  ["pr-sarah", 2, T(9, 15), 45, "initial", "Hannah Kim", null, "Room 2"],
  ["pr-sarah", 2, T(10, 30), 30, "lab-review", "Robert Diaz", null, "Room 2"],
  ["pr-sarah", 2, T(11, 15), 30, "telehealth", "Grace Park", null, "Telehealth"],
  ["pr-sarah", 2, T(13, 30), 60, "group", "Metabolic reset cohort", null, "Group room"],
  ["pr-sarah", 2, T(15, 0), 30, "follow-up", "Liam Walsh", null, "Room 2"],
  ["pr-sarah", 3, T(8, 0), 45, "initial", "Nadia Hassan", null, "Room 2"],
  ["pr-sarah", 3, T(9, 0), 30, "follow-up", "Alexandra Morgan", "p-78435", "Room 2"],
  ["pr-sarah", 3, T(9, 45), 30, "supplement", "Tom Fletcher", null, "Room 2"],
  ["pr-sarah", 3, T(11, 0), 30, "lab-review", "Michael Johnson", "p-64201", "Room 2"],
  ["pr-sarah", 3, T(13, 0), 45, "initial", "Priya Shah", null, "Room 2"],
  ["pr-sarah", 3, T(14, 15), 30, "telehealth", "David Chen", null, "Telehealth"],
  ["pr-sarah", 4, T(8, 30), 30, "follow-up", "Sofia Ramirez", null, "Room 2"],
  ["pr-sarah", 4, T(9, 15), 60, "initial", "Ethan Brooks", null, "Room 2"],
  ["pr-sarah", 4, T(10, 30), 30, "lab-review", "Olivia Bennett", null, "Room 2"],
  ["pr-sarah", 4, T(13, 0), 30, "follow-up", "Marcus Lee", null, "Room 2"],
  ["pr-sarah", 4, T(14, 0), 45, "supplement", "Hannah Kim", null, "Room 2"],
  ["pr-sarah", 4, T(15, 0), 30, "telehealth", "Grace Park", null, "Telehealth"],
  ["pr-sarah", 5, T(8, 0), 30, "follow-up", "Robert Diaz", null, "Room 2"],
  ["pr-sarah", 5, T(8, 45), 45, "initial", "Liam Walsh", null, "Room 2"],
  ["pr-sarah", 5, T(10, 0), 30, "lab-review", "Nadia Hassan", null, "Room 2"],
  ["pr-sarah", 5, T(11, 0), 30, "supplement", "Tom Fletcher", null, "Room 2"],
  ["pr-sarah", 5, T(13, 0), 60, "group", "Sleep & circadian workshop", null, "Group room"],
  // ── Dr. James Okafor ─────────────────────────────────────────────────────
  ["pr-james", 1, T(8, 30), 45, "initial", "Grace Park", null, "Room 4"],
  ["pr-james", 1, T(9, 30), 30, "follow-up", "Ethan Brooks", null, "Room 4"],
  ["pr-james", 1, T(10, 30), 30, "telehealth", "Hannah Kim", null, "Telehealth"],
  ["pr-james", 1, T(13, 30), 45, "initial", "Robert Diaz", null, "Room 4"],
  ["pr-james", 1, T(15, 0), 30, "lab-review", "Priya Shah", null, "Room 4"],
  ["pr-james", 2, T(9, 0), 30, "follow-up", "Olivia Bennett", null, "Room 4"],
  ["pr-james", 2, T(9, 45), 45, "initial", "Tom Fletcher", null, "Room 4"],
  ["pr-james", 2, T(11, 0), 30, "lab-review", "Sofia Ramirez", null, "Room 4"],
  ["pr-james", 2, T(14, 0), 30, "telehealth", "Marcus Lee", null, "Telehealth"],
  ["pr-james", 3, T(8, 30), 30, "follow-up", "David Chen", null, "Room 4"],
  ["pr-james", 3, T(9, 30), 45, "initial", "Liam Walsh", null, "Room 4"],
  ["pr-james", 3, T(11, 0), 30, "telehealth", "Nadia Hassan", null, "Telehealth"],
  ["pr-james", 3, T(13, 30), 30, "lab-review", "Grace Park", null, "Room 4"],
  ["pr-james", 4, T(9, 0), 45, "initial", "Marcus Lee", null, "Room 4"],
  ["pr-james", 4, T(10, 15), 30, "follow-up", "Robert Diaz", null, "Room 4"],
  ["pr-james", 4, T(13, 0), 30, "telehealth", "Sofia Ramirez", null, "Telehealth"],
  ["pr-james", 5, T(9, 0), 30, "follow-up", "Priya Shah", null, "Room 4"],
  ["pr-james", 5, T(10, 0), 45, "initial", "Olivia Bennett", null, "Room 4"],
  ["pr-james", 5, T(11, 15), 30, "lab-review", "Ethan Brooks", null, "Room 4"],
  // ── Rachel Nguyen, RD (Mon / Wed / Fri) ──────────────────────────────────
  ["pr-rachel", 1, T(9, 0), 45, "supplement", "Hannah Kim", null, "Room 1"],
  ["pr-rachel", 1, T(10, 0), 30, "follow-up", "Sofia Ramirez", null, "Room 1"],
  ["pr-rachel", 1, T(11, 0), 45, "initial", "David Chen", null, "Room 1"],
  ["pr-rachel", 1, T(13, 30), 60, "group", "Nutrition foundations", null, "Group room"],
  ["pr-rachel", 3, T(9, 0), 30, "follow-up", "Tom Fletcher", null, "Room 1"],
  ["pr-rachel", 3, T(9, 45), 45, "supplement", "Nadia Hassan", null, "Room 1"],
  ["pr-rachel", 3, T(11, 0), 30, "follow-up", "Liam Walsh", null, "Room 1"],
  ["pr-rachel", 3, T(14, 0), 45, "initial", "Grace Park", null, "Room 1"],
  ["pr-rachel", 5, T(9, 30), 45, "supplement", "Olivia Bennett", null, "Room 1"],
  ["pr-rachel", 5, T(10, 30), 30, "follow-up", "Marcus Lee", null, "Room 1"],
  ["pr-rachel", 5, T(11, 15), 30, "follow-up", "David Chen", null, "Room 1"],
];

const TITLE: Record<AppointmentType, string> = {
  initial: "Initial consult",
  "follow-up": "Follow-up",
  "lab-review": "Lab review",
  supplement: "Supplement consult",
  telehealth: "Telehealth",
  group: "Group session",
  break: "Break / admin",
};

export function getCalendar(): CalendarData {
  const appointments: Appointment[] = ROWS.map((r, i) => {
    const [practitionerId, weekday, start, durationMin, type, patientName, patientId, location] = r;
    return {
      id: `appt-${i}`,
      practitionerId,
      weekday,
      start,
      durationMin,
      type,
      patientName,
      patientId: patientId ?? undefined,
      location,
    };
  });
  return { practitioners: PRACTITIONERS, appointments, dayStart: T(7), dayEnd: T(19) };
}

/** Human label for a type, for detail views. */
export function appointmentTitle(type: AppointmentType): string {
  return TITLE[type];
}
