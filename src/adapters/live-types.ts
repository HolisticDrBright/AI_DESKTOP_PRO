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
  /** Optimistic-concurrency token for status transitions (phase 2). */
  version?: number;
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

/* ────────────────────────────────────────────────────────────────────────────
 * Front-desk appointment transitions (Phase 2 slice 1).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The full appointment status vocabulary the state machine enforces. */
export type LiveAppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "arrived"
  | "in_encounter"
  | "completed"
  | "cancelled"
  | "no_show";

export interface LiveTransitionResult {
  ok: true;
  id: string;
  status: LiveAppointmentStatus;
  previous_status: LiveAppointmentStatus;
  /** New optimistic-concurrency version to render with. */
  version: number;
  /** True when an idempotency-key replay (or a no-op) returned the stored outcome. */
  already_applied: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Protocols + templates (Phase 2 slice 2).
 * ──────────────────────────────────────────────────────────────────────────── */

export type LiveProtocolVersionStatus =
  | "draft" | "approved" | "active" | "superseded" | "discontinued";
export type LiveProtocolStatus =
  | "draft" | "active" | "paused" | "completed" | "discontinued";
export type LiveProtocolItemKind =
  | "product" | "diet" | "lifestyle" | "monitoring" | "followup";

export interface LiveProtocolPhase {
  id: string;
  name: string;
  position: number;
  /** Absolute dates OR relative offsets — never both, never inferred. */
  startsOn: string | null;
  endsOn: string | null;
  relativeStartDay: number | null;
  relativeDurationDays: number | null;
  notes: string | null;
}

export interface LiveProtocolItem {
  id: string;
  phaseId: string | null;
  kind: LiveProtocolItemKind;
  position: number;
  label: string;
  instructions: string | null;
  /** Exact catalog identity for product entries. */
  catalogProductId: string | null;
  catalogProductVersionId: string | null;
  manufacturer: string | null;
  labelVersion: string | null;
  dosageText: string | null;
  timingText: string | null;
  route: string | null;
  verificationStatus: "unverified" | "label_verified" | "structured_verified";
  /** 'not_completed' MUST render as "Interaction review not completed". */
  interactionReviewState: "not_completed" | "reviewed_by_practitioner";
  /** Commercial metadata only — never clinical justification. */
  affiliateUrl: string | null;
}

export interface LiveProtocolVersion {
  id: string;
  version: number;
  status: LiveProtocolVersionStatus;
  title: string;
  summary: string | null;
  dietInstructions: string | null;
  lifestyleInstructions: string | null;
  monitoringPlan: string | null;
  followupPlan: string | null;
  sourceTemplateId: string | null;
  sourceTemplateVersion: number | null;
  supersedesVersionId: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  reviewNote: string | null;
  /** Autosave optimistic-concurrency token. */
  updatedAt: string;
  createdAt: string;
  phases: LiveProtocolPhase[];
  items: LiveProtocolItem[];
}

export interface LiveProtocolHistoryEntry {
  id: string;
  version: number;
  status: LiveProtocolVersionStatus;
  title: string;
  approvedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  supersedesVersionId: string | null;
}

export interface LivePatientProtocol {
  /** false = honest empty state; nothing is invented to fill the screen. */
  exists: boolean;
  canAuthor: boolean;
  protocol: {
    id: string;
    title: string;
    status: LiveProtocolStatus;
    createdAt: string;
    updatedAt: string;
  } | null;
  draft: LiveProtocolVersion | null;
  approved: LiveProtocolVersion | null;
  active: LiveProtocolVersion | null;
  history: LiveProtocolHistoryEntry[];
  generatedAt: string;
}

export interface LiveProtocolTemplate {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "approved" | "archived";
  archivedAt: string | null;
  approvedVersionId: string | null;
  currentVersionId: string | null;
  approvedVersion: number | null;
  updatedAt: string;
}

/** Bounded autosave payload. `phaseIndex` refers to the phases array order. */
export interface LiveProtocolDraftPayload {
  title?: string;
  summary?: string | null;
  dietInstructions?: string | null;
  lifestyleInstructions?: string | null;
  monitoringPlan?: string | null;
  followupPlan?: string | null;
  phases?: {
    name: string;
    startsOn?: string | null;
    endsOn?: string | null;
    relativeStartDay?: number | null;
    relativeDurationDays?: number | null;
    notes?: string | null;
  }[];
  items?: {
    kind: LiveProtocolItemKind;
    label: string;
    phaseIndex?: number | null;
    instructions?: string | null;
    catalogProductId?: string | null;
    catalogProductVersionId?: string | null;
    manufacturer?: string | null;
    labelVersion?: string | null;
    dosageText?: string | null;
    timingText?: string | null;
    route?: string | null;
    verificationStatus?: string | null;
    affiliateUrl?: string | null;
  }[];
}

export interface LiveProtocolMutationResult {
  ok: true;
  message: string;
  protocolId?: string;
  versionId?: string;
  version?: number;
  status?: string;
  templateId?: string;
  supersedesVersionId?: string;
  archived?: boolean;
  alreadySet?: boolean;
  /** Fresh autosave token after a successful save. */
  updatedAt?: string;
}

/** One real catalog product with its exact identity, as the picker returns it. */
export interface LiveCatalogProduct {
  productId: string;
  name: string;
  form: string | null;
  /** The catalog brand of record. Null stays null — never filled in. */
  manufacturer: string | null;
  productVersionId: string | null;
  labelVersion: string | null;
  servingSize: string | null;
  effectiveFrom: string | null;
  /** DERIVED from the catalog. Never asserted by the client. */
  verificationStatus: "unverified" | "label_verified" | "structured_verified";
  structuredIngredientCount: number;
}

export interface LiveCatalogSearch {
  products: LiveCatalogProduct[];
  query: string | null;
  generatedAt: string;
}

/** One deterministic finding, always traceable to the source that stated it. */
export interface LiveInteractionFinding {
  ingredient: string | null;
  medication: string | null;
  severity: "minor" | "moderate" | "major" | null;
  mechanism: string | null;
  notes: string | null;
  source: string | null;
  version: string | null;
}

export interface LiveInteractionItem {
  itemId: string;
  label: string;
  verificationStatus: "unverified" | "label_verified" | "structured_verified";
  interactionReviewState: "not_completed" | "reviewed_by_practitioner";
  /**
   * 'not_completed' MUST render as "Interaction review not completed" with the
   * reason. 'checked' means the deterministic comparison ran — an empty
   * findings list means the checked sources contained nothing, NOT that the
   * product is interaction-free.
   */
  state: "not_completed" | "checked";
  reason: string | null;
  findings: LiveInteractionFinding[];
}

export interface LiveInteractionCheck {
  versionId: string;
  items: LiveInteractionItem[];
  medicationsRecorded: number;
  medicationsCoded: number;
  /** Verbatim server text. Must be displayed, never paraphrased away. */
  disclaimer: string;
  generatedAt: string;
}

export interface LiveInteractionReviewResult {
  ok: true;
  itemId: string;
  alreadyReviewed: boolean;
  message: string;
}
