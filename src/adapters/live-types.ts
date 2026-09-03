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

export const PATIENT_RELATIONSHIP_SCOPES = [
  "protocols_supplements",
  "laboratory_results",
  "medical_records",
] as const;
export type LivePatientRelationshipScope = (typeof PATIENT_RELATIONSHIP_SCOPES)[number];

export const PATIENT_RELATIONSHIP_TYPES = [
  "parent",
  "adult_child",
  "spouse_partner",
  "sibling",
  "family_caregiver",
  "other",
] as const;
export type LivePatientRelationshipType = (typeof PATIENT_RELATIONSHIP_TYPES)[number];

export interface LivePatientRelationship {
  id: string;
  displayName: string;
  maskedEmail: string;
  relationshipType: LivePatientRelationshipType;
  authorityBasis: "patient_authorized";
  status: "pending_patient_approval" | "pending_recipient_claim" | "active" | "revoked" | "expired";
  requestedScopes: LivePatientRelationshipScope[];
  grantedScopes: LivePatientRelationshipScope[];
  patientApprovedAt: string | null;
  recipientClaimedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  version: number;
}

export interface LivePatientRelationships {
  patientId: string;
  relationships: LivePatientRelationship[];
  generatedAt: string;
  /** Added by the Desktop route so the dialog can refuse real identity data in staging. */
  syntheticOnly?: boolean;
}

export interface LivePatientRelationshipInvitationResult {
  relationship: LivePatientRelationship;
  /** Returned once. The database stores only its hash. */
  invitationCode: string;
  deliveryState: "manual_secure_delivery_required";
}

export interface LivePatientRelationshipMutationResult {
  relationshipId: string;
  status: "revoked";
  version: number;
}

export interface LivePatientAppIntakeRecord<T> {
  payload: T;
  receivedAt: string;
  resourceVersion: string;
  recordId: string;
}

export interface LivePatientAppIntake {
  patientId: string;
  connectionState: 'verified' | 'paused' | 'revoked' | 'not_connected';
  sharingStatus: 'granted' | 'revoked' | 'not_granted';
  wellnessProfile: LivePatientAppIntakeRecord<{
    height?: number; weight?: number; goals?: string[]; onboardingCompleted?: boolean;
  }> | null;
  lifestyleProfile: LivePatientAppIntakeRecord<{
    sleepHours?: number; sleepQuality?: number; stressLevel?: number; dietType?: string;
    exerciseFrequency?: number; exerciseTypes?: string[];
  }> | null;
  contraindications: LivePatientAppIntakeRecord<{
    pregnancyStatus?: string; nursing?: boolean; medications?: string[];
    allergies?: string[]; conditions?: string[];
  }> | null;
  clinicalIntake: LivePatientAppIntakeRecord<{
    chiefComplaint?: { description?: string; duration?: string; severity?: number };
    associatedSymptoms?: { name?: string; severity?: number }[];
    energyLevel?: number; sleepQuality?: number; digestiveFunction?: number;
    stressPerception?: number; temperatureSensitivity?: string; painQuality?: string;
  }> | null;
  questionnaireResponses: LivePatientAppIntakeRecord<{
    questionId?: string; categoryId?: string; severity?: number; timestamp?: string;
  }>[];
  wearablesSharingStatus: 'granted' | 'revoked' | 'not_granted';
  wearableDailyRecords: LivePatientAppIntakeRecord<{
    id?: string; source?: string; date?: string; sleepDurationMinutes?: number;
    hrv?: number; restingHr?: number; respiratoryRate?: number; steps?: number;
    activeMinutes?: number; vo2Max?: number; weight?: number; bodyFatPercent?: number;
    spo2?: number; dataQualityScore?: number;
  }>[];
  labImports?: {
    eventId: string; panelName: string; markerName: string; value: number;
    unit: string | null; sourceStatus: string | null; collectedAt: string;
    referenceMin?: number | null; referenceMax?: number | null;
    functionalMin?: number | null; functionalMax?: number | null;
    functionalSourceVersion?: string | null; functionalPopulation?: string | null;
    state: 'review_pending' | 'conflict' | 'accepted' | 'rejected'; receivedAt: string;
  }[];
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
  consumerGenerated: {
    id: string;
    name: string;
    summary: string;
    version: number;
    status: "active";
    generatedAt: string;
    receivedAt: string;
    sourceAnalysisId: string;
    sourcePanelId: string;
    confidence: "low" | "medium" | "high";
    productSelectionState: "awaiting_governed_catalog_approval";
    tasks: Array<{ id: string; name: string; frequency: string; timing: string | null; notes: string | null }>;
  } | null;
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
  | "lab_results_import"
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
    | "lab_result"
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

/* Billing, checkout, catalog & inventory (phase 8A) ---------------------- */

export type LiveInvoiceStatus =
  | "draft"
  | "open"
  | "partially_paid"
  | "paid"
  | "void"
  | "refunded"
  | "partially_refunded"
  | "uncollectible";

export type LiveInvoiceLineKind =
  | "service"
  | "product"
  | "supplement"
  | "lab"
  | "program"
  | "package"
  | "adjustment";

export type LiveBillingProductKind =
  | "service"
  | "visit"
  | "program"
  | "package"
  | "lab"
  | "product"
  | "supplement"
  | "adjustment"
  | "other";

/** Manual methods a practitioner may record. `card_test` is never manual. */
export type LiveManualPaymentMethod = "cash" | "check" | "bank_transfer" | "external";

export type LivePaymentMethod = LiveManualPaymentMethod | "card_test" | "credit";

export type LivePaymentStatus = "pending" | "succeeded" | "failed" | "canceled" | "disputed";

export type LiveInventoryMovementKind =
  | "receipt"
  | "adjustment"
  | "reservation"
  | "release"
  | "sale"
  | "return"
  | "damaged"
  | "expired";

/** Adjustments a practitioner may make by hand; every one needs a reason. */
export type LiveInventoryAdjustmentKind = "adjustment" | "damaged" | "expired";

/** A return must declare its condition; only `resalable` restocks. */
export type LiveInventoryReturnCondition = "resalable" | "damaged";

export interface LiveInvoiceRefund {
  id: string;
  amountMinor: number;
  reason: string | null;
  status: string;
  method: string;
  createdAt: string;
}

export interface LiveInvoicePayment {
  id: string;
  amountMinor: number;
  currency: string;
  status: LivePaymentStatus;
  method: LivePaymentMethod;
  reference: string | null;
  /** Only ever `"test"`: production card processing is not configured. */
  environment: string | null;
  processor: string | null;
  failureCode: string | null;
  paidAt: string | null;
  createdAt: string;
  refunds: LiveInvoiceRefund[];
}

export interface LiveInvoiceLine {
  id: string;
  kind: LiveInvoiceLineKind;
  productId: string | null;
  /** Snapshotted at save time — later catalog edits never rewrite history. */
  name: string | null;
  sku: string | null;
  description: string | null;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
  discountMinor: number;
  discountReason: string | null;
  /** Server-computed from the configured tax rate; never client-supplied. */
  taxRateBps: number;
  taxMinor: number;
  verification: string | null;
}

export interface LiveInvoiceEvent {
  kind: string;
  from: string | null;
  to: string | null;
  detail: string | null;
  at: string;
}

export interface LiveInvoice {
  id: string;
  /** Assigned at finalize (`INV-00001`); null while the invoice is a draft. */
  number: string | null;
  status: LiveInvoiceStatus;
  version: number;
  currency: string;
  patientId: string;
  patientName: string | null;
  appointmentId: string | null;
  practitionerUserId: string | null;
  locationId: string | null;
  locationName: string | null;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  creditAppliedMinor: number;
  balanceMinor: number;
  finalizedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  lines: LiveInvoiceLine[];
  payments: LiveInvoicePayment[];
  history: LiveInvoiceEvent[];
}

/** One line as the client proposes it. Tax is deliberately absent. */
export interface LiveInvoiceLineInput {
  productId: string;
  quantity?: number;
  unitAmountMinor?: number;
  discountMinor?: number;
  discountReason?: string | null;
}

export interface LiveBillingStockLevel {
  locationId: string;
  locationName: string | null;
  onHand: number;
  reserved: number;
  available: number;
  reorderThreshold: number;
}

export interface LiveBillingCommercialLink {
  kind: "affiliate" | "wholesale" | "info";
  label: string;
  url: string | null;
  disclosure: string | null;
}

export interface LiveBillingProduct {
  id: string;
  name: string;
  kind: LiveBillingProductKind;
  amountMinor: number;
  currency: string;
  sku: string | null;
  barcode: string | null;
  supplierId: string | null;
  supplierName: string | null;
  costMinor: number;
  taxRateId: string | null;
  taxRateBps: number | null;
  taxRateName: string | null;
  description: string | null;
  trackInventory: boolean;
  reorderThreshold: number;
  catalogProductId: string | null;
  /** Clinical verification of the linked catalog product, never a sales claim. */
  verificationStatus: string | null;
  commercialLinks: LiveBillingCommercialLink[];
  archivedAt: string | null;
  version: number;
  stock: LiveBillingStockLevel[];
}

export interface LiveBillingSupplier {
  id: string;
  name: string;
  contactEmail: string | null;
  phone: string | null;
  notes: string | null;
  archivedAt: string | null;
}

export interface LiveBillingLocation {
  id: string;
  name: string;
  archivedAt: string | null;
}

export interface LiveBillingTaxRate {
  id: string;
  name: string;
  rateBps: number;
  active: boolean;
}

export interface LiveBillingCatalog {
  products: LiveBillingProduct[];
  suppliers: LiveBillingSupplier[];
  locations: LiveBillingLocation[];
  taxRates: LiveBillingTaxRate[];
}

export interface LiveBillingCatalogFilters {
  query?: string | null;
  kind?: string | null;
  supplierId?: string | null;
  locationId?: string | null;
  /** `"low"` at or below threshold, `"out"` nothing available. */
  stockFilter?: "low" | "out" | null;
  includeArchived?: boolean;
  limit?: number;
}

export interface LiveInventoryMovement {
  id: string;
  kind: LiveInventoryMovementKind;
  onHandDelta: number;
  reservedDelta: number;
  reason: string | null;
  condition: string | null;
  unitCostMinor: number | null;
  locationId: string;
  locationName: string | null;
  refType: string | null;
  refId: string | null;
  at: string;
}

export interface LiveBillingSummary {
  invoicedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  refundedMinor: number;
  discountMinor: number;
  taxMinor: number;
}

export interface LiveBillingInvoiceRow {
  id: string;
  number: string | null;
  status: LiveInvoiceStatus;
  patientId: string;
  patientName: string | null;
  totalMinor: number;
  balanceMinor: number;
  currency: string;
  locationId: string | null;
  practitionerUserId: string | null;
  finalizedAt: string | null;
  createdAt: string;
  version: number;
}

export interface LiveBillingPaymentRow {
  id: string;
  invoiceId: string | null;
  amountMinor: number;
  currency: string;
  status: LivePaymentStatus;
  method: LivePaymentMethod;
  environment: string | null;
  reference: string | null;
  createdAt: string;
}

export interface LiveBillingAging {
  current: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface LiveBillingProductSale {
  productId: string | null;
  name: string | null;
  kind: string | null;
  quantity: number;
  amountMinor: number;
}

export interface LiveBillingLowStock {
  productId: string;
  name: string;
  locationId: string;
  locationName: string | null;
  onHand: number;
  reserved: number;
  available: number;
  reorderThreshold: number;
}

export interface LiveBillingInventoryPanel {
  valuationMinor: number;
  lowStock: LiveBillingLowStock[];
}

export interface LiveBillingWebhookEvent {
  eventId: string;
  type: string;
  /** A refusal is a RECORDED row, never a silent drop. */
  outcome: "processed" | "duplicate" | "ignored" | "refused" | "out_of_order";
  detail: string | null;
  receivedAt: string;
  /**
   * Whether this event's signature was actually verified (phase 8B). An
   * unverified event is never treated as proof of anything.
   */
  signatureVerified?: boolean;
  /** Stripe's own livemode flag. A live event is refused by the boundary. */
  livemode?: boolean | null;
}

export interface LiveBillingReconciliation {
  pendingCardPayments: number;
  webhookEvents: LiveBillingWebhookEvent[];
}

export interface LiveBillingWorkspace {
  summary: LiveBillingSummary;
  invoices: LiveBillingInvoiceRow[];
  payments: LiveBillingPaymentRow[];
  aging: LiveBillingAging;
  productSales: LiveBillingProductSale[];
  inventory: LiveBillingInventoryPanel;
  reconciliation: LiveBillingReconciliation;
}

export interface LiveBillingWorkspaceFilters {
  from?: string | null;
  to?: string | null;
  status?: string | null;
  practitionerUserId?: string | null;
  locationId?: string | null;
  method?: string | null;
}

export interface LivePatientBillingInvoice {
  id: string;
  number: string | null;
  status: LiveInvoiceStatus;
  totalMinor: number;
  paidMinor: number;
  creditAppliedMinor: number;
  refundedMinor: number;
  balanceMinor: number;
  currency: string;
  appointmentId: string | null;
  createdAt: string;
  finalizedAt: string | null;
  version: number;
}

export interface LivePatientBilling {
  creditBalanceMinor: number;
  invoices: LivePatientBillingInvoice[];
}

/** Simple acknowledgement shape for catalog/inventory writes. */
export interface LiveBillingMutationResult {
  id?: string;
  version?: number;
  ok?: boolean;
  balanceMinor?: number;
}

/**
 * A started card payment. There is deliberately no success field: the browser
 * never asserts a charge — the server-only processor boundary attaches the
 * intent and the webhook settles it.
 */
export interface LiveCardPaymentIntent {
  paymentId: string;
  amountMinor: number;
  currency: string;
}

/* Plans, memberships, entitlements & reconciliation (phase 8B) ----------- */

export type LivePlanType = "package" | "membership";

export type LivePackageKind =
  | "visit_credits"
  | "product_bundle"
  | "lab_bundle"
  | "program_bundle"
  | "mixed";

export type LivePlanStatus = "draft" | "active" | "archived";
export type LivePlanVersionStatus = "draft" | "published" | "retired";

export type LiveTransferPolicy = "non_transferable" | "household" | "org_discretion";
export type LiveCreditMode = "single_use" | "multi_use";

/** The subscription status machine. Mirrors the database check constraint. */
export type LiveMembershipStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "canceled"
  | "expired";

export type LiveMembershipAction =
  | "pause"
  | "resume"
  | "cancel_at_period_end"
  | "cancel_now"
  | "reactivate";

/** Every movement the entitlement ledger can record. */
export type LiveEntitlementLedgerKind =
  | "grant"
  | "reserve"
  | "release"
  | "consume"
  | "expire"
  | "refund_revoke"
  | "manual_restore";

export type LiveEntitlementStatus = "active" | "exhausted" | "expired" | "revoked";

/** The granular financial permissions. Taking cash ≠ issuing a refund. */
export type LiveFinancialPermission =
  | "billing.view_summary"
  | "billing.create_invoice"
  | "billing.take_payment"
  | "billing.issue_refund"
  | "billing.adjust_price"
  | "catalog.manage_products"
  | "inventory.adjust"
  | "plans.manage"
  | "comp.assign"
  | "reconciliation.resolve"
  | "reports.view_org";

export interface LivePackageVersion {
  id: string;
  versionNumber: number;
  priceMinor: number;
  currency: string;
  creditQuantity: number;
  creditMode: LiveCreditMode;
  expiresAfterDays: number | null;
  transferPolicy: LiveTransferPolicy;
  status: LivePlanVersionStatus;
  publishedAt: string | null;
  termsSummary: string | null;
}

export interface LiveMembershipVersion {
  id: string;
  versionNumber: number;
  priceMinor: number;
  currency: string;
  intervalUnit: "day" | "week" | "month" | "year";
  intervalCount: number;
  trialDays: number;
  includedCredits: number;
  minimumCommitmentPeriods: number;
  gracePeriodDays: number;
  status: LivePlanVersionStatus;
  publishedAt: string | null;
  termsSummary: string | null;
}

export interface LivePackagePlan {
  id: string;
  name: string;
  description: string | null;
  kind: LivePackageKind;
  status: LivePlanStatus;
  version: number;
  archivedAt: string | null;
  currentVersionId: string | null;
  versions: LivePackageVersion[];
}

export interface LiveMembershipPlan {
  id: string;
  name: string;
  description: string | null;
  status: LivePlanStatus;
  version: number;
  archivedAt: string | null;
  currentVersionId: string | null;
  versions: LiveMembershipVersion[];
}

/** How an organization treats a reserved credit when a visit does not happen. */
export interface LiveOrgBillingPolicy {
  organization_id: string;
  no_show_policy: "consume" | "release" | "review";
  late_cancel_policy: "consume" | "release" | "review";
  late_cancel_window_hours: number;
  consume_on: "arrived" | "completed";
}

export interface LivePlanLibrary {
  packages: LivePackagePlan[];
  memberships: LiveMembershipPlan[];
  /** null when the org has never set one — the documented defaults apply. */
  policy: LiveOrgBillingPolicy | null;
}

export interface LiveEntitlementLedgerEntry {
  kind: LiveEntitlementLedgerKind;
  quantity: number;
  refType: string | null;
  refId: string | null;
  reason: string | null;
  at: string;
}

export interface LiveEntitlement {
  id: string;
  source: "package_purchase" | "membership_period" | "complimentary";
  status: LiveEntitlementStatus;
  /** granted = remaining + reserved + consumed + expired + refunded. */
  grantedQuantity: number;
  remainingQuantity: number;
  reservedQuantity: number;
  consumedQuantity: number;
  expiredQuantity: number;
  refundedQuantity: number;
  creditMode: LiveCreditMode;
  expiresAt: string | null;
  transferPolicy: LiveTransferPolicy;
  planName: string | null;
  ledger: LiveEntitlementLedgerEntry[];
}

export interface LivePatientMembership {
  id: string;
  status: LiveMembershipStatus;
  origin: "purchase" | "complimentary";
  version: number;
  membershipName: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  graceUntil: string | null;
  complimentaryReason: string | null;
  processorSubscriptionRef: string | null;
}

export interface LivePatientEntitlements {
  entitlements: LiveEntitlement[];
  memberships: LivePatientMembership[];
}

export type LiveReconciliationExceptionKind =
  | "unmatched_internal_payment"
  | "unmatched_provider_event"
  | "amount_mismatch"
  | "currency_mismatch"
  | "duplicate_event"
  | "delayed_webhook"
  | "failed_webhook"
  | "dispute"
  | "refund_action_required";

export interface LiveReconciliationException {
  id: string;
  kind: LiveReconciliationExceptionKind;
  status: "open" | "resolved" | "dismissed";
  version: number;
  internalAmountMinor: number | null;
  providerAmountMinor: number | null;
  currency: string | null;
  detail: string | null;
  /**
   * NULL means UNAVAILABLE — balance transactions and payouts are not fetched
   * in this phase. A UI must not render absence as zero.
   */
  providerFeeMinor: number | null;
  providerNetMinor: number | null;
  providerSettlementStatus: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
}

export interface LiveReconciliationWorkspace {
  exceptions: LiveReconciliationException[];
  /** false in this phase: fee/net/settlement columns are not populated. */
  settlementFieldsAvailable: boolean;
  webhookEvents: LiveBillingWebhookEvent[];
}

/** Acknowledgement shape for plan/entitlement writes. */
export interface LivePlanMutationResult {
  id?: string;
  planId?: string;
  version?: number;
  versionNumber?: number;
  status?: string;
  ok?: boolean;
  invoiceId?: string;
  entitlementId?: string | null;
  patientMembershipId?: string | null;
  packageVersionId?: string;
  complimentary?: boolean;
  entitlementsCreated?: number;
  revoked?: number;
  expired?: number;
  state?: string;
  reviewRequired?: boolean;
  policy?: string;
}

/**
 * The Stripe boundary as the browser is allowed to see it: whether it is
 * configured at all, and why not. Never a key, never a secret.
 */
export interface LiveStripeStatus {
  mode: "disabled" | "test";
  configured: boolean;
  problems: string[];
  /**
   * Whether a real Stripe API transaction has EVER been executed by this
   * deployment. False until one actually runs — never inferred from config.
   */
  liveTransactionExecuted: boolean;
}

/* ------------------------------------------------- nutrition (phase 9A) */

export interface LiveNutritionTemplateVersion {
  id: string;
  versionNumber: number;
  status: string;
  purpose: string | null;
  intendedUse: string | null;
  requiresPractitionerReview: boolean;
  cautionPopulations: string[];
  prerequisites: string[];
  missingInformationRequired: string[];
  evidenceGrade: string | null;
  evidenceSummary: string | null;
  educationVsAdviceNote: string | null;
  publishedAt: string | null;
}

export interface LiveNutritionTemplate {
  id: string;
  name: string;
  pattern: string;
  summary: string | null;
  status: string;
  isStarter: boolean;
  version: number;
  currentVersionId: string | null;
  versions: LiveNutritionTemplateVersion[];
}

export interface LiveNutritionTemplateLibrary {
  templates: LiveNutritionTemplate[];
}

export interface LiveNutritionFoodRule {
  id: string;
  phaseId: string | null;
  disposition: string;
  scope: string;
  label: string;
  canonicalSource: string | null;
  canonicalId: string | null;
  portionGuidance: string | null;
  frequencyGuidance: string | null;
  preparationGuidance: string | null;
  substitutions: string[];
  conditionNote: string | null;
  rationale: string | null;
  sortOrder: number;
}

export interface LiveNutritionMealItem {
  id: string;
  label: string;
  quantity: number | null;
  unit: string | null;
  canonicalSource: string | null;
  canonicalId: string | null;
  /** Where a nutrient number came from. Never presented as our measurement. */
  nutrientSource: string | null;
  energyValue: number | null;
  energyUnit: string | null;
  proteinG: number | null;
  carbohydrateG: number | null;
  fatG: number | null;
  fiberG: number | null;
  preparationNote: string | null;
  substitutions: string[];
  sortOrder: number;
}

export interface LiveNutritionMeal {
  id: string;
  mealType: string;
  name: string | null;
  timeOfDay: string | null;
  notes: string | null;
  sortOrder: number;
  items: LiveNutritionMealItem[];
}

export interface LiveNutritionMealDay {
  id: string;
  phaseId: string | null;
  dayNumber: number;
  label: string | null;
  notes: string | null;
  meals: LiveNutritionMeal[];
}

export interface LiveNutritionPhase {
  id: string;
  phaseNumber: number;
  name: string;
  description: string | null;
  timingMode: string;
  relativeStartDay: number | null;
  relativeDurationDays: number | null;
  absoluteStartDate: string | null;
  absoluteEndDate: string | null;
  reintroductionGuidance: string | null;
}

export interface LiveNutritionTarget {
  id: string;
  nutrient: string | null;
  label: string | null;
  targetValue: number | null;
  minimumValue: number | null;
  maximumValue: number | null;
  /** Always present — an unlabelled nutrition number is a safety problem. */
  unit: string;
  period: string | null;
  rationale: string | null;
}

export interface LiveNutritionVersionContent {
  phases: LiveNutritionPhase[];
  foodRules: LiveNutritionFoodRule[];
  mealDays: LiveNutritionMealDay[];
  recipes: Array<{
    id: string;
    name: string;
    servings: number | null;
    ingredients: string[];
    method: string | null;
    notes: string | null;
  }>;
  groceryItems: Array<{
    id: string;
    category: string;
    label: string;
    quantityNote: string | null;
  }>;
  targets: LiveNutritionTarget[];
  provenance: Array<{
    kind: string;
    label: string;
    referenceId: string | null;
    detail: string | null;
    recordedAt: string;
  }>;
}

export interface LiveNutritionSafetyFlag {
  id: string;
  kind: string;
  severity: "review" | "blocking";
  detail: string;
  status: "open" | "acknowledged" | "overridden" | "resolved";
  evidenceRef: string | null;
  overrideReason: string | null;
  overriddenAt: string | null;
}

export interface LiveNutritionConstraint {
  id: string;
  kind: string;
  label: string;
  detail: string | null;
  severity: string | null;
  source: string;
}

export interface LiveNutritionPlanVersion {
  id: string;
  versionNumber: number;
  status: string;
  version: number;
  goals: string[];
  practitionerRationale: string | null;
  patientInstructions: string | null;
  mealTimingGuidance: string | null;
  fastingInstructions: string | null;
  energyTargetValue: number | null;
  energyTargetUnit: string | null;
  proteinG: number | null;
  carbohydrateG: number | null;
  fatG: number | null;
  fiberG: number | null;
  proteinPct: number | null;
  carbohydratePct: number | null;
  fatPct: number | null;
  /** Snapshot, not a pointer: template edits never change a delivered plan. */
  sourceTemplateName: string | null;
  sourceTemplateVersion: number | null;
  sourceTemplateVersionId: string | null;
  detachedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  activatedAt: string | null;
  discontinuedReason: string | null;
  autosavedAt: string | null;
  constraints: LiveNutritionConstraint[];
  safetyFlags: LiveNutritionSafetyFlag[];
  amendments: Array<{ number: number; body: string; reason: string; createdAt: string }>;
  /** Whether safety review has actually been run for THIS version. */
  safetyEvaluated: boolean;
}

export interface LiveNutritionPlan {
  id: string;
  title: string;
  status: string;
  version: number;
  currentVersionId: string | null;
  createdAt: string;
  versions: LiveNutritionPlanVersion[];
  events: Array<{
    kind: string;
    fromStatus: string | null;
    toStatus: string | null;
    detail: string | null;
    createdAt: string;
  }>;
}

export interface LiveNutritionCheckin {
  id: string;
  observedOn: string;
  /** Required — adherence is reported, never inferred. */
  source: string;
  mealPlanAdherencePct: number | null;
  dietAdherencePct: number | null;
  hungerRating: number | null;
  satietyRating: number | null;
  energyRating: number | null;
  digestiveTolerance: number | null;
  symptoms: string[];
  patientNote: string | null;
  weightValue: number | null;
  weightUnit: string | null;
  reviewState: string;
  planVersionId: string | null;
}

export interface LivePatientNutrition {
  plans: LiveNutritionPlan[];
  checkins: LiveNutritionCheckin[];
}

export interface LiveNutritionAdherenceSummary {
  windowDays: number;
  from: string;
  to: string;
  daysReported: number;
  /** A day with no check-in is MISSING, never zero adherence. */
  daysMissing: number;
  meanMealPlanAdherencePct: number | null;
  meanDietAdherencePct: number | null;
  meanDigestiveTolerance: number | null;
  needsFollowup: number;
  unreviewed: number;
}

export interface LiveNutritionMutationResult {
  id?: string;
  planId?: string;
  planVersionId?: string;
  versionId?: string;
  templateId?: string;
  version?: number;
  outcome?: string;
  blocking?: number;
  review?: number;
  count?: number;
  ok?: boolean;
}

/**
 * The Passio boundary as the browser is allowed to see it: whether it is
 * configured at all, and why not. Never a licence key.
 */
export interface LiveNutritionProviderStatus {
  mode: "disabled" | "live";
  configured: boolean;
  problems: string[];
  /**
   * Whether a real Passio request has EVER been executed by this deployment.
   * False until one actually runs — never inferred from configuration.
   */
  liveRequestExecuted: boolean;
  copilotEnabled: boolean;
  copilotProblems: string[];
}

/** A copilot draft as the browser sees it — labelled, unsaved, and unapplied. */
export interface LiveNutritionCopilotDraft {
  suggestions: Array<{
    kind: string;
    isDraft: true;
    title: string;
    rationale: string;
    derivedFrom: string;
    severity: "info" | "attention";
    ruleLabel?: string;
  }>;
  provenanceKind: "copilot_draft";
  disclaimer: string;
}

/* ===================================================================== */
/* PHASE 9B — governed knowledge, the import pipeline, and commercial     */
/* disclosure. Commercial types are deliberately SEPARATE from every      */
/* clinical type below: nothing clinical embeds a commercial field, so a  */
/* renderer cannot accidentally place a price beside a dose.              */
/* ===================================================================== */

export type KnowledgeChangeKind =
  | "add"
  | "change"
  | "unchanged"
  | "conflict"
  | "removal"
  /**
   * Phase 9C. A row that matches no governed identity but resembles one
   * closely enough that applying it blind would either duplicate a product or
   * overwrite the wrong one. Neither an add nor a change.
   */
  | "ambiguous";

export type KnowledgeImportItemStatus =
  | "needs_review"
  | "applied"
  | "rejected"
  | "skipped";

export interface LiveKnowledgeImportItem {
  id: string;
  entityType: string;
  displayName: string;
  sourceSheet: string | null;
  sourceRowNumber: number | null;
  dedupeKey: string | null;
  changeKind: KnowledgeChangeKind | null;
  status: KnowledgeImportItemStatus;
  payloadSha256: string;
  existingRefType: string | null;
  existingRefId: string | null;
  conflictWithItemId: string | null;
  conflictReason: string | null;
  conflictResolution: "keep_existing" | "take_incoming" | "skip" | null;
  validationErrors: string[];
  warnings: string[];
  reviewNote: string | null;
  appliedRefType: string | null;
  appliedRefId: string | null;

  /* --------------------------------------------- Phase 9C review fields */

  /** The verbatim source row. Absent normalisation is `{}`, never the payload. */
  sourceRaw?: Record<string, unknown>;
  restrictedFlags?: string[];
  restrictedReason?: string | null;
  /** Facts the source did not supply. Absence recorded as absence. */
  missingFacts?: string[];
  /** Governed products this row resembles without sharing an identity. */
  candidateMatches?: LiveImportCandidateMatch[];
  /** Field-level differences against the governed row, for a `change`. */
  fieldDiffs?: LiveImportFieldDiff[];
}

export interface LiveImportCandidateMatch {
  productId: string;
  name: string;
  brand: string | null;
  sku: string | null;
  upc: string | null;
  status: string;
  why: string;
}

export interface LiveImportFieldDiff {
  field: string;
  current: string | null;
  incoming: string | null;
}

export interface LiveKnowledgeImportBatch {
  id: string;
  status: "preview" | "staged" | "in_review" | "committed" | "completed" | "cancelled";
  sourceName: string;
  sourceKind: string | null;
  sourceFilename: string | null;
  sourceByteSize: number | null;
  sourceSha256: string;
  schemaVersion: string;
  itemCount: number;
  added: number;
  changed: number;
  unchanged: number;
  conflicts: number;
  removals: number;
  /** Phase 9C. Rows resembling a governed product without sharing its identity. */
  ambiguous?: number;
  /** Phase 9C. Rows carrying a restricted flag. */
  restricted?: number;
  previewGeneratedAt: string | null;
  committedAt: string | null;
  createdAt: string;
}

export interface LiveKnowledgeImportPreview {
  batch: LiveKnowledgeImportBatch;
  items: LiveKnowledgeImportItem[];
  /** Reported for review. This pipeline never deletes governed content. */
  reportedRemovals: Array<{
    entityType: string;
    dedupeKey: string;
    refType: string | null;
    refId: string | null;
  }>;
  removalPolicy: string;
}

export interface LiveKnowledgeImportPreviewResult {
  batchId: string;
  /** True when the same bytes were already imported; nothing was staged again. */
  idempotent: boolean;
  status: string;
  itemCount: number;
  added: number;
  changed: number;
  unchanged: number;
  conflicts: number;
  removals: number;
  ambiguous?: number;
  restricted?: number;
  sourceSha256?: string;
  message: string;
}

/* ------------------------------------------- Phase 9C: the review surface */

export interface LiveImportSourceFile {
  id: string;
  /** A file NAME. A path never reaches this field. */
  declaredName: string;
  sourceKind: string | null;
  availability: "available" | "unavailable";
  contentSha256: string | null;
  byteSize: number | null;
  /** Required when unavailable. "Not found" and "withheld" differ. */
  unavailableReason: string | null;
  declaredAt: string;
  lastCheckedAt: string;
  batchCount: number;
}

export interface LiveImportSourceInventory {
  files: LiveImportSourceFile[];
  counts: { declared: number; available: number; unavailable: number };
  emptyStateMessage: string;
}

export interface LiveCatalogReviewProduct {
  productId: string;
  name: string;
  brand: string | null;
  sku: string | null;
  upc: string | null;
  status: string;
  restrictedFlags: string[];
  restrictedClearedAt: string | null;
  restrictedClearanceNote: string | null;
  selectable: boolean;
  /** The same sentence the attach refusal raises. One answer, two surfaces. */
  blockReason: string | null;
  missingFacts: string[];
  sourceFileName: string | null;
}

export interface LiveCatalogReviewQueue {
  products: LiveCatalogReviewProduct[];
  counts: { total: number; restricted: number; notSelectable: number };
  emptyStateMessage: string;
}

export interface LiveImportProvenanceRecord {
  id: string;
  refType: string;
  refId: string;
  batchId: string;
  itemId: string;
  sourceFileName: string | null;
  sourceFileSha256: string | null;
  sourceSheet: string | null;
  sourceRowNumber: number | null;
  payloadSha256: string;
  rawValues: Record<string, unknown>;
  normalizedValues: Record<string, unknown>;
  missingFacts: string[];
  restrictedFlags: string[];
  importedAt: string;
  batchSourceName: string;
}

export interface LiveImportProvenanceHistory {
  records: LiveImportProvenanceRecord[];
  total: number;
  /** Always true. The table refuses update and delete at the trigger. */
  immutable: boolean;
  emptyStateMessage: string;
}

export interface LiveKnowledgeImportCommitResult {
  ok: true;
  batchId: string;
  applied: number;
  skipped: number;
  /** Always "draft". Import is not approval. */
  approvalState: "draft";
  message: string;
}

/**
 * Commercial disclosure for a label version or protocol version.
 *
 * A SEPARATE read, never folded into a clinical payload. The disclaimer is
 * carried from the database rather than written in the browser, so the UI
 * cannot soften it.
 */
export interface LiveCommercialLink {
  id: string;
  kind: "affiliate" | "supplier" | "retailer" | "other";
  url: string | null;
  itemLabel?: string | null;
  catalogProductVersionId?: string | null;
  supplierName: string | null;
  commissionDisclosure: string | null;
  availabilityStatus: string | null;
  lastVerifiedAt: string | null;
  revokedAt: string | null;
  recordedAt: string;
}

export interface LiveCommercialDisclosure {
  labelVersionId?: string;
  protocolVersionId?: string;
  links: LiveCommercialLink[];
  disclaimer: string;
}

/** A protocol copilot draft as the browser sees it — labelled and unsaved. */
export interface LiveProtocolCopilotDraft {
  suggestions: Array<{
    kind: string;
    isDraft: true;
    title: string;
    rationale: string;
    derivedFrom: string;
    severity: "info" | "attention";
    itemLabel?: string;
    proposedDose?: string | null;
    doseSource?: string | null;
  }>;
  provenanceKind: "copilot_draft";
  disclaimer: string;
  interactionReviewState: "not_completed";
  interactionReviewReason: string;
}

export interface LiveProtocolCopilotStatus {
  enabled: boolean;
  problems: string[];
}

/* ------------------------------------------------------------------------ *
 * Phase 9B: the Product Catalog registry.
 *
 * The `clinical` / `commercial` split is the database's shape, carried
 * through verbatim. It is not flattened here on purpose: a flat object is one
 * careless spread away from a commercial field reaching a clinical renderer,
 * and the whole point is that there is no such path.
 * ------------------------------------------------------------------------ */

/** Derived from whether a named person verified this exact label. */
export type LiveLabelVerificationState = "verified" | "unverified";

export interface LiveCatalogListEntry {
  labelVersionId: string;
  productCode: string;
  productName: string;
  brand: string | null;
  version: number;
  status: "draft" | "published" | "superseded" | "withdrawn";
  labelSha256: string | null;
  sourceUrl: string | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  verificationState: LiveLabelVerificationState;
  versionCount: number;
  ingredientCount: number;
  hasWarnings: boolean;
  /** A COUNT only. The list view never receives a commercial URL. */
  commercialLinkCount: number;
  commercialDisclosureComplete: boolean;
}

export interface LiveProductCatalog {
  clinical: {
    products: LiveCatalogListEntry[];
    counts: {
      total: number;
      verified: number;
      unverified: number;
      published: number;
      draft: number;
    };
  };
  reviewQueue: Array<{
    itemId: string;
    displayName: string;
    externalKey: string | null;
    changeKind: string | null;
    sourceName: string;
    validationErrors: string[];
    conflictReason: string | null;
    createdAt: string;
  }>;
  generatedAt: string;
  /** Rendered verbatim when the registry is empty. Never softened. */
  emptyStateMessage: string;
  commercialPolicy: string;
  unknownPolicy: string;
}

/**
 * One label in full.
 *
 * Every optional string is `string | null` rather than `string | undefined`:
 * NULL is a value here, meaning "not captured from the label", and it must
 * render as "Unknown" rather than disappearing.
 */
export interface LiveProductLabelDetail {
  clinical: {
    labelVersionId: string;
    productCode: string;
    productName: string;
    brand: string | null;
    version: number;
    status: string;
    labelSha256: string | null;
    sourceUrl: string | null;
    effectiveAt: string | null;
    expiresAt: string | null;
    verifiedAt: string | null;
    verificationNote: string | null;
    verificationState: LiveLabelVerificationState;
    servingSize: string | null;
    servingsPerContainer: string | null;
    ingredients: string | null;
    ingredientRows: Array<Record<string, unknown>>;
    otherIngredients: string | null;
    allergens: string | null;
    directions: string | null;
    warnings: string | null;
    storage: string | null;
    jurisdiction: string | null;
    sku: string | null;
    upc: string | null;
    versions: Array<{
      labelVersionId: string;
      version: number;
      status: string;
      labelSha256: string | null;
      effectiveAt: string | null;
      expiresAt: string | null;
      verifiedAt: string | null;
      verificationNote: string | null;
      createdAt: string;
    }>;
    catalogMappings: Array<{
      productId: string;
      name: string;
      form: string | null;
      sku: string | null;
      upc: string | null;
    }>;
    importHistory: Array<{
      itemId: string;
      sourceName: string;
      sourceFilename: string | null;
      sourceSha256: string | null;
      changeKind: string | null;
      status: string;
      reviewedAt: string | null;
      importedAt: string | null;
    }>;
  };
  commercial: {
    links: Array<{
      id: string;
      kind: string;
      url: string | null;
      supplierName: string | null;
      commissionDisclosure: string | null;
      availabilityStatus: string | null;
      lastVerifiedAt: string | null;
      revokedAt: string | null;
      revokedReason: string | null;
      recordedAt: string;
    }>;
    disclosureComplete: boolean;
    notice: string;
  };
  unknownPolicy: string;
}

/* ------------------------------------------------------------------------ *
 * Phase 9B: protocol template lifecycle.
 * ------------------------------------------------------------------------ */

export type LiveTemplateSafetyOutcome = "passed" | "concerns" | "blocked";

export interface LiveProtocolTemplateDetail {
  templateId: string;
  name: string;
  description: string | null;
  status: string;
  archivedAt: string | null;
  supersededById: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  versions: Array<{
    versionId: string;
    version: number;
    status: string;
    title: string;
    approvedAt: string | null;
    createdAt: string;
    itemCount: number;
  }>;
  items: Array<{
    itemId: string;
    label: string;
    kind: string;
    position: number;
    dosageText: string | null;
    timingText: string | null;
    route: string | null;
    doseSourceKind: string | null;
    doseSourceRef: string | null;
    manufacturer: string | null;
    labelVersion: string | null;
    productSku: string | null;
    productUpc: string | null;
    labelSha256: string | null;
    verificationStatus: string;
    interventionClassCode: string | null;
    monitoringRequirements: string[];
    stoppingRules: string[];
    contraindications: string[];
    followupIntervalDays: number | null;
    jurisdictionSensitive: boolean;
  }>;
  safetyReviews: Array<{
    reviewId: string;
    versionId: string;
    outcome: LiveTemplateSafetyOutcome;
    note: string;
    itemsReviewed: number;
    unsourcedDoseCount: number;
    reviewedAt: string;
  }>;
  unsourcedDoseCount: number;
  /** Derived on read, never stored. A stored copy drifts, invisibly. */
  patientInstructionPreview: Array<{
    label: string;
    kind: string;
    instruction: string | null;
    dose: string | null;
    timing: string | null;
    stopIf: string[];
    doseIsSourced: boolean;
  }>;
  previewNotice: string;
  safetyNotice: string;
}

export interface LiveTemplateComparison {
  sameTemplate: boolean;
  left: {
    versionId: string;
    templateId: string;
    version: number;
    status: string;
    title: string;
  };
  right: {
    versionId: string;
    templateId: string;
    version: number;
    status: string;
    title: string;
  };
  added: Array<{
    label: string;
    kind: string;
    dosageText: string | null;
    doseSourceKind: string | null;
  }>;
  removed: Array<{
    label: string;
    kind: string;
    dosageText: string | null;
    doseSourceKind: string | null;
  }>;
  changed: Array<{
    label: string;
    doseChanged: boolean;
    from: Record<string, unknown>;
    to: Record<string, unknown>;
  }>;
  doseChangeCount: number;
  matchNote: string;
}

/**
 * What the parser returns. NOTHING IS WRITTEN to produce this — it is the
 * operator's evidence for deciding whether to stage the file at all.
 */
export interface LiveParsedImportEnvelope {
  schemaVersion: string;
  sourceKind: "product_spreadsheet" | "protocol_document";
  /** A file NAME. The parser strips any path before this object exists. */
  sourceFilename: string;
  sourceName: string;
  sourceByteSize: number;
  sourceSha256: string;
  items: Array<{
    entityType: string;
    displayName: string;
    externalKey?: string;
    sourceSheet?: string;
    payload: Record<string, unknown>;
    sourceRaw: Record<string, unknown>;
    warnings?: string[];
  }>;
  report: {
    itemCount: number;
    sheetsRead: string[];
    unmappedColumns: string[];
    skippedRows: Array<{ sheet: string; rowNumber: number; why: string }>;
    ignoredParts: string[];
    uncachedFormulaCells: number;
    discardedFieldCodes: number;
    truncated: boolean;
    notices: string[];
  };
}
