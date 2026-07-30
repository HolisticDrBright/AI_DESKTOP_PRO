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
  /**
   * Ids of the item rows the save just wrote, in payload order. An autosave
   * replaces items wholesale, so these are how the client addresses the row it
   * just persisted (an interaction review targets a persisted item, never a
   * form row).
   */
  itemIds?: string[];
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

/* ------------------------------------------------------------------ */
/* Programs & Education (phase 3)                                      */
/* ------------------------------------------------------------------ */

export type LiveProgramStatus = "draft" | "published" | "archived";
export type LiveProgramVersionStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "published"
  | "superseded";
export type LiveProgramBlockKind =
  | "text"
  | "image"
  | "video_url"
  | "document_link"
  | "quiz"
  | "check_in"
  | "resource";
export type LiveProgramEnrollmentStatus =
  | "invited"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired";
export type LiveProgramOfferPaymentMode = "free" | "manual_comp" | "stripe";

export interface LiveProgramListItem {
  id: string;
  name: string;
  description: string | null;
  status: LiveProgramStatus;
  archivedAt: string | null;
  updatedAt: string;
  publishedVersion: number | null;
  /** Status of the version currently being edited, if one exists. */
  draftStatus: LiveProgramVersionStatus | null;
  /** Counts of PERSISTED enrollment rows only; nothing is projected. */
  enrollment: {
    invited: number;
    active: number;
    paused: number;
    completed: number;
  };
}

export interface LiveProgramLibrary {
  programs: LiveProgramListItem[];
  generatedAt: string;
}

export interface LiveProgramBlock {
  id: string;
  kind: LiveProgramBlockKind;
  title: string | null;
  /** Kind-specific body validated by the database on save. */
  content: Record<string, unknown>;
  /** Commercial resources are labeled; they never serve as clinical evidence. */
  isCommercial: boolean;
  position: number;
}

export interface LiveProgramLesson {
  id: string;
  title: string;
  summary: string | null;
  position: number;
  blocks: LiveProgramBlock[];
}

export interface LiveProgramModule {
  id: string;
  name: string;
  summary: string | null;
  position: number;
  lessons: LiveProgramLesson[];
}

/** Full nested projection of one version (modules -> lessons -> blocks). */
export interface LiveProgramVersionDetail {
  id: string;
  version: number;
  status: LiveProgramVersionStatus;
  title: string | null;
  summary: string | null;
  audience: string | null;
  disclaimer: string | null;
  sourceTemplateId: string | null;
  sourceTemplateVersion: number | null;
  supersedesVersionId: string | null;
  reviewNote: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  createdAt: string;
  modules: LiveProgramModule[];
}

export interface LiveProgramHistoryEntry {
  id: string;
  version: number;
  status: LiveProgramVersionStatus;
  title: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  supersedesVersionId: string | null;
}

export interface LiveProgramVersionEvent {
  versionId: string;
  fromStatus: LiveProgramVersionStatus | null;
  toStatus: LiveProgramVersionStatus;
  note: string | null;
  createdAt: string;
}

export interface LiveProgramOffer {
  id: string;
  name: string;
  /** Stored commercial terms ONLY — this application never processes payment. */
  priceCents: number;
  currency: string;
  accessDurationDays: number | null;
  paymentMode: LiveProgramOfferPaymentMode;
  enrollmentOpen: boolean;
  status: "active" | "retired";
}

export interface LiveProgramRosterEntry {
  enrollmentId: string;
  patientId: string;
  patientName: string;
  status: LiveProgramEnrollmentStatus;
  /** The exact published version number this enrollment is pinned to. */
  pinnedVersion: number | null;
  enrolledAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  compReason: string | null;
  lastActivityAt: string | null;
  progressCount: number;
  needsReviewCount: number;
}

export interface LiveProgramStudio {
  program: {
    id: string;
    name: string;
    description: string | null;
    status: LiveProgramStatus;
    archivedAt: string | null;
    updatedAt: string;
    publishedVersionId: string | null;
  };
  canAuthor: boolean;
  /** The draft or in-review version being edited, if one exists. */
  editable: LiveProgramVersionDetail | null;
  /** The immutable published version, if one exists. */
  published: LiveProgramVersionDetail | null;
  history: LiveProgramHistoryEntry[];
  events: LiveProgramVersionEvent[];
  offers: LiveProgramOffer[];
  roster: LiveProgramRosterEntry[];
  generatedAt: string;
}

export interface LiveProgramTemplate {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "approved" | "archived";
  archivedAt: string | null;
  approvedVersionId: string | null;
  approvedVersion: number | null;
  currentVersionId: string | null;
  updatedAt: string;
}

/**
 * Wholesale autosave payload: the database replaces the whole curriculum with
 * exactly this content, validating every block by kind. Ids come back in
 * payload order via `moduleIds` / `lessonIds` / `blockIds`.
 */
export interface LiveProgramDraftPayload {
  title?: string;
  summary?: string | null;
  audience?: string | null;
  disclaimer?: string | null;
  modules?: {
    name: string;
    summary?: string | null;
    lessons?: {
      title: string;
      summary?: string | null;
      blocks?: {
        kind: LiveProgramBlockKind;
        title?: string | null;
        content: Record<string, unknown>;
        isCommercial?: boolean;
      }[];
    }[];
  }[];
}

export interface LiveProgramMutationResult {
  ok: true;
  message: string;
  programId?: string;
  versionId?: string;
  version?: number;
  status?: string;
  templateId?: string;
  offerId?: string;
  enrollmentId?: string;
  progressId?: string;
  supersedesVersionId?: string;
  pinnedVersionId?: string;
  archived?: boolean;
  alreadyReviewed?: boolean;
  /** Fresh autosave token after a successful save. */
  updatedAt?: string;
  /** Persisted row ids in payload order after a wholesale save. */
  moduleIds?: string[];
  lessonIds?: string[];
  blockIds?: string[];
}

export interface LivePatientProgramEnrollment {
  enrollmentId: string;
  programId: string;
  programName: string;
  status: LiveProgramEnrollmentStatus;
  pinnedVersion: number | null;
  pinnedVersionTitle: string | null;
  enrolledAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  lastActivityAt: string | null;
  progressCount: number;
  lessonsCompleted: number;
  lessonTotal: number;
  needsReviewCount: number;
}

export interface LivePatientPrograms {
  enrollments: LivePatientProgramEnrollment[];
  generatedAt: string;
}

/**
 * Versioned delivery DTO for the FUTURE AI Longevity Pro handoff.
 *
 * This is a contract definition only. Nothing in this repository calls AI
 * Longevity Pro, transmits this DTO anywhere, or claims content reached the
 * patient app. When a verified delivery integration exists it will consume
 * exactly this shape, versioned so the mobile side can reject unknown
 * revisions instead of guessing.
 */
export interface ProgramDeliveryV1 {
  contract: "program-delivery";
  contractVersion: 1;
  organizationId: string;
  programId: string;
  /** The immutable published version the enrollment is pinned to. */
  programVersionId: string;
  programVersion: number;
  enrollmentId: string;
  patientId: string;
  title: string | null;
  summary: string | null;
  disclaimer: string | null;
  modules: LiveProgramModule[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Inbox, messaging, and AI triage (phase 4)                           */
/* ------------------------------------------------------------------ */

export type LiveThreadCategory =
  | "general"
  | "clinical_question"
  | "refill"
  | "lab"
  | "wearable_alert"
  | "scheduling"
  | "billing"
  | "program_check_in"
  | "protocol_adherence"
  | "administrative";
export type LiveThreadPriority = "low" | "normal" | "high" | "urgent";
export type LiveThreadStatus = "open" | "snoozed" | "resolved";
export type LiveThreadQueue = "practitioner" | "staff";
export type LiveMessageStatus =
  | "draft"
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "inbound"
  | "cancelled"
  | "superseded";
export type LiveMessageChannel = "in_app" | "alp_in_app" | "email" | "sms" | "push";

export interface LiveInboxThread {
  id: string;
  subject: string | null;
  category: LiveThreadCategory;
  priority: LiveThreadPriority;
  status: LiveThreadStatus;
  assignedTo: string | null;
  assignedQueue: LiveThreadQueue;
  followUpAt: string | null;
  snoozedUntil: string | null;
  urgent: boolean;
  /** Matched entries from the FIXED urgent-language dictionary — never message excerpts. */
  urgentTerms: string[];
  version: number;
  lastMessageAt: string | null;
  patientId: string;
  patientName: string;
  unreadCount: number;
  messageCount: number;
}

export interface LiveInboxCounts {
  open: number;
  snoozed: number;
  resolved: number;
  urgent: number;
  unread: number;
  dueSoon: number;
  mine: number;
}

export interface LiveInbox {
  threads: LiveInboxThread[];
  /** Counts of PERSISTED rows the caller can see; nothing projected. */
  counts: LiveInboxCounts;
  generatedAt: string;
}

export interface LiveInboxFilters {
  query?: string | null;
  category?: LiveThreadCategory | null;
  priority?: LiveThreadPriority | null;
  status?: LiveThreadStatus | null;
  queue?: LiveThreadQueue | null;
  assignedToMe?: boolean;
  unreadOnly?: boolean;
  dueOnly?: boolean;
  limit?: number;
}

export interface LiveThreadMessage {
  id: string;
  body: string;
  status: LiveMessageStatus;
  channel: LiveMessageChannel;
  isFromPatient: boolean;
  senderUserId: string | null;
  isMine: boolean;
  version: number;
  readAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedReason: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface LiveThreadAttachment {
  id: string;
  messageId: string | null;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  storageProvider: "none" | "supabase_storage";
  /** false = metadata only; no bytes exist and no URL is ever exposed. */
  accessible: boolean;
  createdAt: string;
}

export interface LiveCommunicationPreferences {
  preferredChannel: "in_app" | "email" | "sms" | "none";
  emailOk: boolean;
  smsOk: boolean;
  pushOk: boolean;
  doNotContact: boolean;
  consentId: string | null;
  note: string | null;
  updatedAt: string;
}

export interface LivePatientConsentSummary {
  id: string;
  type: string;
  status: string;
  grantedAt: string | null;
  revokedAt: string | null;
}

export type LiveAiSuggestionKind =
  | "category"
  | "priority"
  | "summary"
  | "unanswered_questions"
  | "routing"
  | "draft_response"
  | "task_suggestion"
  | "note_suggestion";

export interface LiveAiSuggestion {
  id: string;
  kind: LiveAiSuggestionKind;
  content: Record<string, unknown>;
  status: "suggested" | "accepted" | "dismissed";
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface LiveThreadEvent {
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  createdAt: string;
}

export interface LiveThreadOutboxEntry {
  messageId: string;
  channel: LiveMessageChannel;
  status: "queued" | "sending" | "sent" | "delivered" | "failed" | "cancelled";
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
}

export interface LiveConversation {
  conversation: {
    id: string;
    subject: string | null;
    category: LiveThreadCategory;
    priority: LiveThreadPriority;
    status: LiveThreadStatus;
    assignedTo: string | null;
    assignedQueue: LiveThreadQueue;
    followUpAt: string | null;
    snoozedUntil: string | null;
    urgent: boolean;
    urgentTerms: string[];
    version: number;
    lastMessageAt: string | null;
    createdAt: string;
  };
  patient: { id: string; name: string };
  messages: LiveThreadMessage[];
  attachments: LiveThreadAttachment[];
  preferences: LiveCommunicationPreferences | null;
  consents: LivePatientConsentSummary[];
  aiReviews: LiveAiSuggestion[];
  events: LiveThreadEvent[];
  outbox: LiveThreadOutboxEntry[];
  generatedAt: string;
}

export interface LiveInboxMutationResult {
  ok: boolean;
  message: string;
  /** false with a refusal code when sending is lawfully refused (e.g. no provider). */
  sent?: boolean;
  refusal?: string;
  conversationId?: string;
  messageId?: string;
  version?: number;
  status?: string;
  taskId?: string;
  attachmentId?: string;
  reviewId?: string;
  markedRead?: number;
  alreadyApplied?: boolean;
  alreadyCreated?: boolean;
  alreadyAppended?: boolean;
  alreadyReviewed?: boolean;
  decision?: string;
}

export interface LivePatientThreadSummary {
  id: string;
  subject: string | null;
  category: LiveThreadCategory;
  priority: LiveThreadPriority;
  status: LiveThreadStatus;
  urgent: boolean;
  lastMessageAt: string | null;
  createdAt: string;
  unreadCount: number;
  messageCount: number;
}

export interface LivePatientMessages {
  threads: LivePatientThreadSummary[];
  generatedAt: string;
}

export interface LiveInboxTodaySummary {
  openThreads: number;
  urgentOpen: number;
  unreadInbound: number;
  dueFollowUps: number;
  myAssigned: number;
  generatedAt: string;
}

/**
 * Versioned delivery DTO for the FUTURE AI Longevity Pro messaging bridge.
 *
 * Contract definition ONLY. Nothing in this repository calls AI Longevity
 * Pro, transmits these shapes anywhere, or claims a message reached the
 * patient app. When a verified bridge exists it will exchange exactly these
 * shapes, versioned so the mobile side can reject unknown revisions.
 */
export interface AlpMessagingThreadV1 {
  contract: "alp-messaging-thread";
  contractVersion: 1;
  organizationId: string;
  conversationId: string;
  patientId: string;
  subject: string | null;
  category: LiveThreadCategory;
  createdAt: string;
}

export interface AlpMessagingMessageV1 {
  contract: "alp-messaging-message";
  contractVersion: 1;
  organizationId: string;
  conversationId: string;
  messageId: string;
  direction: "outbound" | "inbound";
  body: string;
  attachments: {
    attachmentId: string;
    fileName: string;
    contentType: string;
    byteSize: number | null;
    /** Opaque reference resolved through an authorized fetch — never a URL. */
    storageRef: string | null;
  }[];
  consent: {
    doNotContact: boolean;
    preferredChannel: "in_app" | "email" | "sms" | "none";
  };
  createdAt: string;
}

export interface AlpMessagingDeliveryReceiptV1 {
  contract: "alp-messaging-delivery-receipt";
  contractVersion: 1;
  messageId: string;
  providerEventId: string;
  kind: "provider_accepted" | "sent" | "delivered" | "failed" | "bounced";
  occurredAt: string;
  errorSafe: string | null;
}

export interface AlpMessagingReadReceiptV1 {
  contract: "alp-messaging-read-receipt";
  contractVersion: 1;
  messageId: string;
  providerEventId: string;
  readAt: string;
}

/* ------------------------------------------------------------------ */
/* Patient delivery & synchronization gateway (phase 5)                */
/* ------------------------------------------------------------------ */

export type LiveSyncScope =
  | "programs"
  | "protocols_supplements"
  | "nutrition"
  | "appointments"
  | "messaging"
  | "forms_checkins"
  | "symptoms_adherence"
  | "wearables"
  | "lab_summaries"
  | "billing_links"
  | "research_n_of_1";

export type LiveSyncConnectionState =
  | "invitation_pending"
  | "verified"
  | "paused"
  | "revoked"
  | "failed";

export type LiveSyncOutboundResourceType =
  | "program_enrollment"
  | "protocol_version"
  | "nutrition_plan"
  | "supplement_instructions"
  | "appointment_summary"
  | "message"
  | "checkin_assignment"
  | "lab_summary"
  | "resource_withdrawal";

export type LiveSyncOutboundState =
  | "queued"
  | "sending"
  | "delivered"
  | "acknowledged"
  | "failed"
  | "dead_letter"
  | "superseded"
  | "cancelled";

export type LiveSyncInboundState =
  | "received"
  | "processed"
  | "review_pending"
  | "conflict"
  | "rejected";

export interface LiveSyncConnection {
  id: string;
  externalSystem: string;
  state: LiveSyncConnectionState;
  contractVersion: string;
  verifiedAt: string | null;
  pausedAt: string | null;
  revokedAt: string | null;
  version: number;
  createdAt: string;
}

export interface LiveSyncConsentScope {
  id: string;
  scope: LiveSyncScope;
  status: "granted" | "revoked";
  artifactTitle: string;
  artifactVersion: string;
  jurisdiction: string | null;
  method: string;
  authority: string;
  grantedAt: string;
  revokedAt: string | null;
  revokeSource: "practitioner" | "patient_app" | null;
}

export interface LiveSyncOutboundEvent {
  id: string;
  eventUid: string;
  scope: LiveSyncScope;
  resourceType: LiveSyncOutboundResourceType;
  resourceId: string;
  resourceVersion: string;
  state: LiveSyncOutboundState;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  occurredAt: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
}

export interface LiveSyncInboundCorrection {
  version: number;
  overlay: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export interface LiveSyncInboundEvent {
  id: string;
  scope: LiveSyncScope;
  resourceType: string;
  externalResourceId: string | null;
  resourceVersion: string | null;
  state: LiveSyncInboundState;
  occurredAt: string;
  receivedAt: string;
  /** The ORIGINAL patient submission — immutable; corrections are overlays. */
  payload: Record<string, unknown>;
  corrections: LiveSyncInboundCorrection[];
  reviewedAt: string | null;
  reviewNote: string | null;
  rejectionReason: string | null;
  providerEventId: string;
}

export interface LiveSyncConflict {
  id: string;
  scope: LiveSyncScope;
  resourceType: string;
  resourceRef: string;
  reason: string;
  desktopVersion: string | null;
  externalVersion: string | null;
  state:
    | "open"
    | "resolved_keep_desktop"
    | "resolved_keep_external"
    | "resolved_manual"
    | "dismissed";
  resolutionNote: string | null;
  resolvedAt: string | null;
  version: number;
  createdAt: string;
}

export interface LiveSyncResourceStatus {
  resourceType: LiveSyncOutboundResourceType;
  resourceId: string;
  resourceVersion: string;
  state: "pending" | "delivered" | "acknowledged" | "failed" | "withdrawn";
  acknowledgedAt: string | null;
  updatedAt: string;
}

export interface LiveSyncHistoryEntry {
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  createdAt: string;
}

export interface LivePatientSync {
  providerConfigured: boolean;
  connection: LiveSyncConnection | null;
  invitation: {
    id: string;
    expiresAt: string;
    createdAt: string;
    usedAt: string | null;
    expired: boolean;
  } | null;
  scopes: LiveSyncConsentScope[];
  counts: {
    pendingOutbound: number;
    failedOutbound: number;
    deadLetter: number;
    inboundPendingReview: number;
    openConflicts: number;
  };
  lastSuccessfulSyncAt: string | null;
  resources: LiveSyncResourceStatus[];
  outbound: LiveSyncOutboundEvent[];
  inbound: LiveSyncInboundEvent[];
  conflicts: LiveSyncConflict[];
  history: LiveSyncHistoryEntry[];
  generatedAt: string;
}

export interface LiveSyncMutationResult {
  ok: boolean;
  message: string;
  refusal?: string;
  connectionId?: string;
  invitationId?: string;
  /** Returned ONCE at creation; only its hash exists server-side. */
  token?: string;
  expiresAt?: string;
  deliveryConfigured?: boolean;
  eventId?: string;
  eventUid?: string;
  state?: string;
  version?: number;
  scope?: string;
  status?: string;
  alreadyApplied?: boolean;
  alreadyQueued?: boolean;
  cancelledOutbound?: number;
}

export interface LiveSyncWorkerCycle {
  provider: string;
  contractVersion: string;
  startedAt: string;
  completedAt: string;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  cancelled: number;
  leaseReclaims: number;
  circuitState: "closed" | "open" | "half_open";
  errorClass: string | null;
  maxQueueAgeSeconds: number | null;
}

export interface LiveOrgSyncOperations {
  providerConfigured: boolean;
  provider: string | null;
  /** disabled | fixture (deterministic TEST provider) | approved */
  posture: "disabled" | "fixture" | "approved";
  contractVersions: string[];
  connections: {
    verified: number;
    invitationPending: number;
    paused: number;
    revoked: number;
  };
  outbound: {
    queued: number;
    sending: number;
    failed: number;
    deadLetter: number;
    delivered: number;
  };
  inbound: { pendingReview: number; processed: number; conflicts: number };
  maxQueueAgeSeconds: number;
  lastWorkerCycle: LiveSyncWorkerCycle | null;
  circuit: {
    provider: string;
    state: "closed" | "open" | "half_open";
    failureCount: number;
    openedAt: string | null;
    updatedAt: string;
  } | null;
  deadLetters: {
    eventId: string;
    reason: string;
    enteredAt: string;
    retriedAt: string | null;
  }[];
  generatedAt: string;
}

/**
 * Versioned SYNC ENVELOPE contract for the FUTURE AI Longevity Pro bridge
 * (contract "patient-sync", version 1).
 *
 * Contract definition ONLY. Nothing in this repository calls AI Longevity
 * Pro, transmits these shapes anywhere, or claims content reached the
 * patient app. The mobile side must reject unknown contract versions.
 */
export interface PatientSyncOutboundEnvelopeV1 {
  contract: "patient-sync";
  contractVersion: 1;
  eventUid: string;
  idempotencyKey: string;
  organizationId: string;
  connectionId: string;
  scope: LiveSyncScope;
  resourceType: LiveSyncOutboundResourceType;
  resourceId: string;
  resourceVersion: string;
  occurredAt: string;
  producer: "desktop";
  provenance: Record<string, unknown>;
  /** Minimum-necessary payload; sha256 hex of its canonical JSON text. */
  payload: Record<string, unknown>;
  payloadHash: string;
  correlationId: string | null;
  causationId: string | null;
}

export interface PatientSyncInboundEnvelopeV1 {
  contract: "patient-sync";
  contractVersion: 1;
  /** Provider-unique event id — replays are refused per connection. */
  providerEventId: string;
  connectionId: string;
  scope: LiveSyncScope;
  resourceType:
    | "program_progress"
    | "quiz_response"
    | "checkin_response"
    | "protocol_adherence"
    | "supplement_adherence"
    | "symptom_report"
    | "outcome_report"
    | "wearable_summary"
    | "patient_message"
    | "appointment_request"
    | "consent_change"
    | "delivery_receipt"
    | "read_receipt";
  externalResourceId: string | null;
  resourceVersion: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  /** Key id of the signature the worker verified before recording. */
  signatureKeyId: string | null;
  correlationId: string | null;
}
