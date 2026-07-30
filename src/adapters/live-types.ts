/**
 * Wire shapes for the live path (client-safe types only — no runtime code).
 *
 * These are the PHI-safe DTOs that cross the client↔route-handler boundary.
 * Audit rows deliberately carry only safe_message + structured metadata, never
 * raw lab values or note text (the DB RPCs enforce this too — migration 0013).
 */

/** The review decision the UI can request, mapped to the RPC's enum. */
export type ReviewDecision = "accepted" | "flagged" | "rejected";

export interface LiveReviewResult {
  ok: true;
  reviewStatus: ReviewDecision;
  reviewedAt: string | null;
  previousStatus: string | null;
  message: string;
}

export interface LiveTaskResult {
  ok: true;
  id: string;
  status: string;
  message: string;
}

/** One live review-queue row (review_queue_items), as the backend returns it. */
export interface LiveQueueItem {
  id: string;
  /** review_queue_items.item_type enum value, e.g. "abnormal_result". */
  itemType: string;
  title: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_review" | "resolved" | "snoozed" | "dismissed";
  patientId: string | null;
  /** Display name resolved server-side (RLS-scoped join). */
  patientName: string | null;
  assigneeName: string | null;
  dueAt: string | null;
  createdAt: string;
}

export interface LiveResolveResult {
  id: string;
  status: string;
  previousStatus: string;
  alreadyResolved: boolean;
  auditEventId?: string;
}

/** One row from the append-only audit log, PHI-safe. */
export interface LiveAuditEvent {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  safeMessage: string | null;
  patientId: string | null;
  actorUserId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

/** Result of a live lab-PDF upload+ingestion (backend /api/clinical/labs/upload). */
export interface LiveUploadResult {
  documentId: string;
  status: "extracted" | "failed";
  /** extracted only */
  inserted?: number;
  matched?: number;
  lowConfidence?: number;
  queueItemId?: string | null;
  /** failed only — fixed vocabulary, never free text */
  failureReason?: "unreadable_pdf" | "no_text_extracted" | "no_markers_found";
}

/* ---------------------------------------------------------------- schedule */

/** One scheduling-safe appointment row returned by the Desktop calendar RPC. */
export interface LiveAppointment {
  id: string;
  patientId: string | null;
  patientName: string | null;
  practitionerUserId: string | null;
  practitionerName: string | null;
  title: string | null;
  appointmentType: string | null;
  location: string | null;
  telehealthUrl: string | null;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface LiveCalendarPractitioner {
  userId: string;
  displayName: string | null;
  credentials: string | null;
  specialty: string | null;
}

export interface LiveCalendarPatient {
  id: string;
  name: string;
}

export interface LiveCalendar {
  appointments: LiveAppointment[];
  practitioners: LiveCalendarPractitioner[];
  /** Scheduling-safe picker fields only; no clinical chart data. */
  patients: LiveCalendarPatient[];
}

export interface LiveBookResult {
  ok: true;
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  message: string;
}

export interface LiveAppointmentStatusResult {
  ok: true;
  id: string;
  status: string;
  previousStatus: string;
  alreadySet: boolean;
  message: string;
}

export interface LiveRescheduleResult {
  ok: true;
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  message: string;
}

export interface LiveBookInput {
  practitionerUserId: string;
  appointmentType: string;
  startsAtIso: string;
  endsAtIso: string;
  patientId?: string;
  location?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Patient overview (Phase 1 vertical slice).
 *
 * A bounded aggregate of VERIFIED data only. Every list is capped server-side;
 * every field that lacks a governed source is null/empty and the UI renders
 * "Not enough verified data" — the DTO has no place to put an invented value.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface OverviewSourceLink {
  /** What kind of record backs this item (drives the link target). */
  kind: "encounter" | "note" | "lab_observation" | "lab_document" | "appointment" | "queue_item" | "medication" | "condition" | "allergy";
  id: string;
  /** ISO timestamp of the source record — every item carries its date. */
  at: string;
}

export interface LiveOverviewAllergy {
  id: string;
  allergen: string;
  reaction: string | null;
  severity: "mild" | "moderate" | "severe" | "life_threatening" | null;
  status: string;
  recordedAt: string;
}

export interface LiveOverviewMedication {
  id: string;
  name: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  status: string;
  startDate: string | null;
}

export interface LiveOverviewCondition {
  id: string;
  name: string;
  icd10: string | null;
  status: string;
  onsetDate: string | null;
}

export interface LiveOverviewCareTeamMember {
  userId: string;
  displayName: string;
  role: string;
  relationship: string;
  isCaller: boolean;
}

export interface LiveOverviewAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  appointmentType: string;
}

export interface LiveOverviewEncounter {
  id: string;
  occurredAt: string;
  encounterType: string;
  /** Note lifecycle for the encounter's primary note ('none' when absent). */
  noteStatus: string;
  signedAt: string | null;
}

export interface LiveOverviewLabSummary {
  latestCollectedAt: string | null;
  markerCount: number;
  awaitingReview: number;
  abnormal: number;
  /** Most recent observations, bounded (≤5), for the snapshot strip. */
  recent: {
    id: string;
    markerName: string;
    valueDisplay: string;
    status: string;
    collectedAt: string;
    reviewState: string;
  }[];
}

export interface LiveOverviewTask {
  id: string;
  title: string;
  priority: "low" | "medium" | "high";
  itemType: string;
  createdAt: string;
}

export interface LiveChangeBriefItem {
  /** Human line, e.g. "New Quest panel — 12 markers". Verified data only. */
  label: string;
  /** Category of change for grouping/icons. */
  kind: "lab" | "note" | "encounter" | "appointment" | "medication" | "condition" | "task";
  source: OverviewSourceLink;
}

export interface LivePatientOverview {
  patientId: string;
  demographics: {
    fullName: string;
    dateOfBirth: string | null;
    sex: string | null;
    /** Presence flags only — contact values stay out of the overview DTO. */
    hasEmail: boolean;
    hasPhone: boolean;
  };
  careTeam: LiveOverviewCareTeamMember[];
  allergies: LiveOverviewAllergy[];
  medications: LiveOverviewMedication[];
  conditions: LiveOverviewCondition[];
  recentAppointments: LiveOverviewAppointment[];
  recentEncounters: LiveOverviewEncounter[];
  labs: LiveOverviewLabSummary;
  openTasks: LiveOverviewTask[];
  /**
   * Care plan / protocol and wearables have no governed live source yet.
   * `null` / empty = "Not enough verified data" in the UI — never a fabricated
   * status.
   */
  carePlan: null;
  wearableSources: string[];
  /** Named gaps the practitioner should know about (e.g. "No allergy list recorded"). */
  missingInformation: string[];
  /** "What changed since the last visit" — anchored to the previous signed encounter. */
  changesSinceLastVisit: {
    /** The visit the brief is anchored to; null = no prior signed encounter. */
    anchorEncounterAt: string | null;
    items: LiveChangeBriefItem[];
  };
  generatedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Clinical reasoning workspace (Phase 1 vertical slice).
 *
 * reasoning_strength wording is INTERNAL evidence weighting — surfaced with
 * its own label, never as a medical probability. Hypotheses are inferences.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface LiveEvidenceItem {
  id: string;
  /** measured | patient_reported | practitioner_confirmed | published_evidence | ai_inference | conflicting | missing */
  factType: string;
  label: string;
  observedAt: string | null;
  /** kind carries the source TABLE name (e.g. biomarker_observations). */
  source: { kind: string; id: string; at: string } | null;
}

export interface LiveMissingEvidence {
  id: string;
  label: string;
  recommendation: string | null;
}

export interface LiveHypothesis {
  id: string;
  title: string;
  status: string;
  /**
   * Internal evidence-weighting label, verbatim from the record (e.g.
   * "strong internal evidence weighting (78/100)"). NOT a probability.
   */
  strengthLabel: string;
  supporting: LiveEvidenceItem[];
  conflicting: LiveEvidenceItem[];
  missing: LiveMissingEvidence[];
  review: {
    state: "unreviewed" | "accepted" | "rejected" | "needs_data";
    reviewedAt: string | null;
    /** Reviewer display name; null when unreviewed. */
    reviewedBy: string | null;
    note: string | null;
  };
}

export interface LiveReasoningSnapshotMeta {
  id: string;
  version: number;
  generatedAt: string;
  /** True when source data (labs/notes/questions) changed after generation. */
  stale: boolean;
  staleReason: string | null;
}

export interface LiveReasoningWorkspace {
  patientId: string;
  /** null = no snapshot generated yet (AI generation may be not configured). */
  snapshot: LiveReasoningSnapshotMeta | null;
  hypotheses: LiveHypothesis[];
  /** Urgent safety questions — invariant across clinical lenses. */
  urgentQuestions: { id: string; text: string; status: string; createdAt: string }[];
  /** Honest capability flags for the workspace header. */
  aiGeneration: { configured: boolean; message: string };
  generatedAt: string;
}

export interface LiveHypothesisReviewResult {
  ok: true;
  hypothesisId: string;
  state: "accepted" | "rejected" | "needs_data";
  auditId: string;
  message: string;
}
