/**
 * Telehealth vocabulary shared by the live adapter, the same-origin routes,
 * and the Telehealth screens. Client-safe: types only, no fixtures.
 *
 * A telehealth VISIT is one appointment's video-visit record on the AWS
 * telehealth boundary: the combined telehealth + recording/AI-notes consent,
 * the Zoom meeting the practitioner joins from inside Desktop Pro, and the
 * post-visit note that starts as Zoom AI Companion's summary and becomes a
 * chart note only when the practitioner signs it.
 */

export const TELEHEALTH_CONSENT_TYPE = "telehealth_recording_combined";

/** Consent wording version recorded with every signature. Bump when the text changes. */
export const TELEHEALTH_CONSENT_VERSION = "2026-10";

export interface TelehealthConsent {
  consentId: string;
  consentType: typeof TELEHEALTH_CONSENT_TYPE;
  consentVersion: string;
  signerName: string;
  /** `patient_app` = typed by the patient at booking; `staff_attested` = recorded on the desktop. */
  method: "patient_app" | "staff_attested";
  signedAt: string;
  recordedBy: string;
  patientLocation: string | null;
}

export const VISIT_NOTE_SECTIONS: { key: TelehealthNoteSectionKey; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "patient_reported", label: "What the patient reported" },
  { key: "results_reviewed", label: "Results reviewed" },
  { key: "plan_discussed", label: "Plan discussed" },
];

export type TelehealthNoteSectionKey = "summary" | "patient_reported" | "results_reviewed" | "plan_discussed";

export interface TelehealthActionItem {
  id: string;
  text: string;
  /** Suggestions never create a task, order, or appointment on their own. */
  status: "suggested" | "approved" | "dismissed";
}

export interface TelehealthVisitNote {
  status: "not_reviewed" | "signed";
  source: "zoom_ai_companion";
  zoomSummaryId: string | null;
  aiSections: Record<TelehealthNoteSectionKey, string>;
  /** Zoom's summary exactly as received, kept beside the mapped sections. */
  aiOriginal: Record<string, unknown>;
  practitionerNotes: string;
  actionItems: TelehealthActionItem[];
  revision: number;
  importedAt: string;
  signedAt: string | null;
  signedBy: string | null;
}

export interface TelehealthFlag {
  atSeconds: number;
  label: string;
}

export interface TelehealthVisit {
  appointmentId: string;
  organizationId: string;
  requestId: string | null;
  status: "scheduled" | "in_visit" | "ended";
  consents: TelehealthConsent[];
  consentSigned: boolean;
  providerMeetingId: string | null;
  joinUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
  flags: TelehealthFlag[];
  quickNotes: string;
  note: TelehealthVisitNote | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One row of the day view: the appointment plus whatever the visit boundary knows about it. */
export interface TelehealthDayVisit {
  appointmentId: string;
  /** `clinical_calendar` = booked on the desktop calendar; `patient_app` = requested in the patient app. */
  source: "clinical_calendar" | "patient_app";
  patientId: string | null;
  patientName: string | null;
  practitionerName: string | null;
  appointmentStatus: string;
  startsAt: string;
  endsAt: string;
  requestId: string | null;
  /** The visit record, or null when the visit service has none yet / is unreachable. */
  visit: TelehealthVisit | null;
}

export interface TelehealthDay {
  /** Local calendar day as YYYY-MM-DD. */
  date: string;
  from: string;
  to: string;
  visits: TelehealthDayVisit[];
  /**
   * Whether the AWS telehealth visit service answered. When it did not, the
   * calendar rows still render but consent and meeting state are unknown —
   * which the screen says, instead of showing "not signed".
   */
  visitService: { available: true } | { available: false; message: string };
}

/** What the browser needs to embed the meeting as host. Short-lived; never stored. */
export interface TelehealthSession {
  meetingNumber: string;
  passcode: string;
  signature: string;
  sdkKey: string;
  zak: string;
  hostDisplayName: string;
  expiresAt: string;
}

export interface TelehealthStartResult {
  visit: TelehealthVisit;
  session: TelehealthSession;
}

export interface TelehealthImportResult {
  visit: TelehealthVisit;
  /** False while Zoom has not produced the AI Companion summary yet. */
  summaryReady: boolean;
}

export interface TelehealthConsentInput {
  appointmentId: string;
  requestId?: string | null;
  signerName: string;
  patientLocation?: string | null;
  /** The staff member's attestation that the patient agreed to the combined consent. */
  agreed: true;
}

export interface TelehealthStartInput {
  appointmentId: string;
  requestId?: string | null;
  start: string;
  end: string;
  timeZone: string;
  hostDisplayName: string;
}

export interface TelehealthEndInput {
  appointmentId: string;
  expectedVersion: number;
  flags: TelehealthFlag[];
  quickNotes: string;
}

export interface TelehealthSignInput {
  appointmentId: string;
  expectedVersion: number;
  practitionerNotes: string;
  aiSections: Record<TelehealthNoteSectionKey, string>;
  actionItems: { id: string; status: TelehealthActionItem["status"] }[];
}
