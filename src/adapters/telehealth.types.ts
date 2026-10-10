/**
 * Telehealth vocabulary shared by the live adapter, the same-origin routes,
 * and the Telehealth screens. Client-safe: types only, no fixtures.
 *
 * A telehealth VISIT is one appointment's video-visit record on the AWS
 * telehealth boundary: the combined telehealth + recording/AI-notes consent
 * (a receipt against the organization's approved consent artifact in the
 * governed consent authority), the Zoom meeting the practitioner joins from
 * inside Desktop Pro, and the post-visit note that starts as Zoom AI
 * Companion's summary and is signed as a TELEHEALTH visit record. It is not
 * the chart's signed clinical note (see docs/telehealth.md).
 */

export const TELEHEALTH_CONSENT_TYPE = "telehealth_recording_combined";
export const TELEHEALTH_CONSENT_SCOPE = "telehealth_recording";

/** The organization's current approved consent artifact for the telehealth scope. */
export interface TelehealthConsentArtifact {
  artifactId: string;
  artifactVersion: string;
  contentSha256: string;
  jurisdiction: string;
  approvedAt: string;
  scope: typeof TELEHEALTH_CONSENT_SCOPE;
}

export interface TelehealthConsent {
  consentId: string;
  consentType: typeof TELEHEALTH_CONSENT_TYPE;
  scope: typeof TELEHEALTH_CONSENT_SCOPE;
  /** The approved artifact the signer saw: id, version and content hash. */
  artifactId: string;
  artifactVersion: string;
  contentSha256: string;
  signerName: string;
  /** `patient_app` = typed by the patient at booking; `staff_attested` = recorded on the desktop. */
  method: "patient_app" | "staff_attested";
  representativeAuthority: "self" | "guardian" | "healthcare_proxy" | "legal_representative";
  signedAt: string;
  recordedBy: string;
  patientLocation: string | null;
  /** The governed grant this receipt stands on when the patient has an app connection. */
  grantId: string | null;
  connectionId: string | null;
  status: "granted" | "withdrawn";
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawalReason: string | null;
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
  /** Zoom's current API returns one Markdown document; it lands whole in `summary` as unreviewed text. */
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

/** The list projection of a note: state only, no bodies. */
export interface TelehealthVisitNoteSummary {
  status: TelehealthVisitNote["status"];
  source: TelehealthVisitNote["source"];
  zoomSummaryId: string | null;
  revision: number;
  importedAt: string;
  signedAt: string | null;
  signedBy: string | null;
}

export interface TelehealthFlag {
  atSeconds: number;
  label: string;
}

export interface TelehealthProviderShutdown {
  /** `pending`/`failed` = the meeting may still be running at the provider; `ended` = Zoom confirmed it stopped. */
  status: "not_started" | "pending" | "ended" | "failed";
  attemptedAt: string | null;
  confirmedAt: string | null;
  detail: string | null;
}

export type TelehealthVisitStatus = "scheduled" | "in_visit" | "ending" | "ended" | "cancelled";

/**
 * The visit-side record of a chart transfer. `admitted` = the exact source was
 * fixed and the chart write may be in flight (or its response was lost);
 * `completed` = the chart's authoritative receipt was read back. The chart is
 * the authority; this record is reconciled from it, never the other way.
 */
export interface TelehealthChartTransfer {
  transferId: string;
  state: "admitted" | "completed";
  sourceRevision: number;
  sourceDigest: string;
  admittedAt: string;
  admittedBy: string;
  encounterId: string | null;
  noteId: string | null;
  noteVersion: number | null;
  contentSha256: string | null;
  transferredAt: string | null;
  completedAt: string | null;
}

/** The chart's own view of the retained record (from `get_telehealth_record_authority`), attached to a completed visit's read. */
export interface TelehealthChartRecord {
  legalHold: boolean;
  appointment: { id: string; status: string; deleted: boolean; patientMatches: boolean } | null;
  transfer: { transferId: string; encounterId: string; noteId: string; noteVersion: number; noteStatus: string | null; noteCurrentVersion: number | null; noteDeleted: boolean; transferredAt: string } | null;
}

/** The outcome of one transfer attempt, as returned to the screen. */
export interface TelehealthTransferResult {
  visit: TelehealthVisit;
  transfer: TelehealthChartTransfer | null;
}

export interface TelehealthVisit {
  appointmentId: string;
  organizationId: string;
  requestId: string | null;
  consumerPersonId: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  timeZone: string | null;
  status: TelehealthVisitStatus;
  consents: TelehealthConsent[];
  /** True when at least one receipt is granted and not withdrawn. The server re-checks the authority on start. */
  consentSigned: boolean;
  providerMeetingId: string | null;
  joinUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
  providerShutdown: TelehealthProviderShutdown;
  flags: TelehealthFlag[];
  quickNotes: string;
  note: TelehealthVisitNote | TelehealthVisitNoteSummary | null;
  /** Prior note revisions, oldest first (bounded). Empty in list projections. */
  noteHistory: TelehealthVisitNote[];
  version: number;
  createdAt: string;
  updatedAt: string;
  /** The retained record's patient and practitioner, fixed when the visit was created. */
  patientRecordId?: string | null;
  practitionerUserId?: string | null;
  /** Chart transfer state recorded on the visit (null until a transfer is admitted). */
  chartTransfer?: TelehealthChartTransfer | null;
  /** The exact source a transfer must name (present only once the note is signed). */
  chartTransferSource?: { sourceRevision: number; sourceDigest: string } | null;
  /** Attached by the desktop for a completed visit: the chart's view of the retained record. */
  chartRecord?: TelehealthChartRecord | null;
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
  /** Calendar day as YYYY-MM-DD in `timeZone`. */
  date: string;
  /** IANA zone the day was computed in (the viewer's). */
  timeZone: string;
  from: string;
  to: string;
  visits: TelehealthDayVisit[];
  /**
   * Whether the AWS telehealth visit service answered, and whether its list
   * was complete. When it did not answer the calendar rows still render but
   * consent and meeting state are unknown — which the screen says, instead
   * of showing "not signed".
   */
  visitService: { available: true; complete: boolean } | { available: false; message: string };
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
  /** Day the appointment starts on (YYYY-MM-DD) and the viewer's zone, so the server can resolve the appointment. */
  date: string;
  timeZone: string;
  /** The approved artifact the staff member attested the patient agreed to. */
  artifactId: string;
  artifactVersion: string;
  contentSha256: string;
  signerName: string;
  patientLocation?: string | null;
  representativeAuthority?: TelehealthConsent["representativeAuthority"];
  /** The staff member's attestation that the patient agreed to the combined consent. */
  agreed: true;
}

export interface TelehealthWithdrawInput {
  appointmentId: string;
  date: string;
  timeZone: string;
  expectedVersion: number;
  reason?: string;
}

export interface TelehealthStartInput {
  appointmentId: string;
  date: string;
  timeZone: string;
  hostDisplayName?: string;
}

export interface TelehealthEndInput {
  appointmentId: string;
  date: string;
  timeZone: string;
  expectedVersion: number;
  flags: TelehealthFlag[];
  quickNotes: string;
}

/** An explicit chart transfer names the exact signed source the practitioner reviewed. */
export interface TelehealthTransferInput {
  appointmentId: string;
  sourceRevision: number;
  sourceDigest: string;
}

export interface TelehealthSignInput {
  appointmentId: string;
  date: string;
  timeZone: string;
  expectedVersion: number;
  practitionerNotes: string;
  aiSections: Record<TelehealthNoteSectionKey, string>;
  actionItems: { id: string; status: TelehealthActionItem["status"] }[];
}
