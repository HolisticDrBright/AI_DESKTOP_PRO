/**
 * Longitudinal chart timeline (MOCK). One filterable stream per patient
 * combining clinical + operational events. Live mode never uses this — the
 * real EMR timeline (migration 0021) renders instead.
 */
import type { Tone } from "./types";

export type TimelineKind =
  | "encounter"
  | "note"
  | "addendum"
  | "form"
  | "message"
  | "lab"
  | "prescription"
  | "supplement"
  | "protocol"
  | "wearable"
  | "payment"
  | "program";

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  atLabel: string;
  /** Sort key: bigger = newer. */
  order: number;
  title: string;
  detail: string;
  tone: Tone;
  href?: string;
  /** Signed/locked artifacts render a lock affordance. */
  locked?: boolean;
}

export const TIMELINE_KIND_META: Record<TimelineKind, { label: string; tone: Tone }> = {
  encounter: { label: "Encounters", tone: "action" },
  note: { label: "Notes", tone: "action" },
  addendum: { label: "Addenda", tone: "slate" },
  form: { label: "Forms", tone: "teal" },
  message: { label: "Messages", tone: "teal" },
  lab: { label: "Labs", tone: "navy" },
  prescription: { label: "Prescriptions", tone: "warning" },
  supplement: { label: "Supplements", tone: "positive" },
  protocol: { label: "Protocol changes", tone: "ai" },
  wearable: { label: "Wearable alerts", tone: "warning" },
  payment: { label: "Payments", tone: "slate" },
  program: { label: "Programs", tone: "ai" },
};

const E = (
  order: number,
  kind: TimelineKind,
  atLabel: string,
  title: string,
  detail: string,
  extra?: Partial<TimelineEvent>,
): TimelineEvent => ({
  id: `tl-${kind}-${order}`,
  kind,
  order,
  atLabel,
  title,
  detail,
  tone: TIMELINE_KIND_META[kind].tone,
  ...extra,
});

const ALEXANDRA: TimelineEvent[] = [
  E(100, "message", "Today 7:42 AM", "Portal message received", "Asked about evening supplement timing — awaiting reply.", { href: "/inbox?thread=th-avery-timing" }),
  E(98, "wearable", "Today 5:10 AM", "HRV low 3 nights running", "Overnight HRV 28 ms vs 30-day baseline 41 ms. Review in Tracking.", { href: "tracking?view=wearables" }),
  E(96, "supplement", "Jul 16", "Magnesium glycinate dispensed", "120 ct · invoice #1058 · picked up in clinic.", { href: "billing" }),
  E(94, "payment", "Jul 16", "Payment received — $211.72", "Follow-up visit + magnesium · Visa (test) ending 4242.", { href: "billing" }),
  E(92, "note", "Jul 9", "Follow-up note signed", "Sleep protocol adherence reviewed; morning-light block kept.", { locked: true, href: "chart" }),
  E(90, "encounter", "Jul 9", "Follow-up visit (30 min)", "In-clinic with Dr. Sarah Mitchell · Room 2.", { href: "chart" }),
  E(88, "form", "Jul 2", "PSS-10 completed", "Score 19 (moderate) — down from 24 in April.", { href: "tracking?view=assessments" }),
  E(86, "lab", "Jun 28", "Quest panel imported", "12 markers extracted · 2 needed confirmation · reviewed Jul 1.", { href: "labs" }),
  E(84, "protocol", "Jun 24", "Sleep protocol phase 2 approved", "Added 10-min morning light + magnesium timing shift.", { href: "care-plan" }),
  E(82, "addendum", "Jun 20", "Addendum to Jun 12 note", "Clarified alcohol intake context for cortisol read.", { locked: true, href: "chart" }),
  E(80, "note", "Jun 12", "Lab-review note signed", "hs-CRP trending down; vitamin D repletion continued.", { locked: true, href: "chart" }),
  E(78, "encounter", "Jun 12", "Lab review (30 min)", "Telehealth with Dr. Sarah Mitchell.", { href: "chart" }),
  E(76, "payment", "Jun 12", "Payment received — $180.24", "Lab review + D3/K2 drops · Visa (test) ending 4242.", { href: "billing" }),
  E(74, "program", "Jun 3", "Metabolic Reset — Phase 2 started", "Module 4 of 8 · adherence 84% last 30 days.", { href: "/programs" }),
  E(72, "message", "May 30", "Visit summary shared", "Patient confirmed receipt in portal.", { href: "messages" }),
  E(70, "lab", "May 13", "Quest panel imported", "hs-CRP 2.8 (high, improving) · vitamin D 24 (low).", { href: "labs" }),
  E(68, "prescription", "May 13", "Sertraline 50 mg recorded", "External prescriber — recorded for interaction screening.", { href: "labs?view=reasoning" }),
  E(66, "encounter", "Apr 22", "Initial consult (60 min)", "Comprehensive intake with Dr. Sarah Mitchell.", { href: "chart" }),
  E(64, "form", "Apr 20", "Intake — health history", "Completed via portal ahead of the initial consult.", { href: "tracking?view=assessments" }),
];

const MICHAEL: TimelineEvent[] = [
  E(90, "message", "Today 8:15 AM", "Reschedule requested", "Thursday follow-up → Friday AM or Monday.", { href: "/inbox?thread=th-michael-reschedule" }),
  E(88, "payment", "Jul 12", "Partial payment — $150.00", "Initial consult · balance open $125.00.", { href: "billing" }),
  E(86, "encounter", "Jul 12", "Initial consult (60 min)", "Cardiometabolic intake with Dr. James Okafor.", { href: "chart" }),
  E(84, "lab", "Jul 10", "LabCorp panel imported", "ApoB 112 (high) · fasting insulin 14.2 (high).", { href: "labs" }),
  E(82, "wearable", "Jul 8", "Evening glucose spikes", "CGM shows post-dinner spikes >160 mg/dL on 4 of 7 days.", { href: "tracking?view=wearables" }),
  E(80, "protocol", "Jul 5", "Post-dinner walk protocol started", "20-min walk after dinner · N-of-1 design pending.", { href: "care-plan" }),
  E(78, "form", "Jul 1", "Cardiometabolic questionnaire assigned", "Not yet returned — flagged overdue Jul 10.", { href: "tracking?view=assessments" }),
];

const PRIYA: TimelineEvent[] = [
  E(90, "message", "Today 6:58 AM", "Fatigue worsening", "Winded on stairs; asked to move up the iron panel.", { href: "/inbox?thread=th-priya-labs" }),
  E(88, "lab", "Jul 15", "Ferritin 9 ng/mL — critical low", "Confirmed on repeat draw; hemoglobin 11.2 trending down.", { href: "labs" }),
  E(86, "encounter", "Jul 15", "Lab review (30 min)", "Reviewed iron studies with Dr. Sarah Mitchell.", { href: "chart" }),
  E(84, "protocol", "Jul 15", "Iron repletion protocol drafted", "Phase 1 pending practitioner approval.", { href: "care-plan" }),
  E(82, "payment", "Jun 3", "Refund issued — $150.00", "Initial consult partially refunded (scheduling error).", { href: "billing" }),
  E(80, "encounter", "Jun 3", "Initial consult (60 min)", "Intake with Dr. Sarah Mitchell.", { href: "chart" }),
];

const BY_PATIENT: Record<string, TimelineEvent[]> = {
  "p-78435": ALEXANDRA,
  "p-64201": MICHAEL,
  "p-59318": PRIYA,
};

export function getTimeline(patientId: string): TimelineEvent[] {
  return (BY_PATIENT[patientId] ?? []).slice().sort((a, b) => b.order - a.order);
}
