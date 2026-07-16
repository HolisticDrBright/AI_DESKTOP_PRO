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

/** One appointment row as clinical.schedule.getCalendar returns it. */
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

export interface LiveCalendar {
  appointments: LiveAppointment[];
  practitioners: LiveCalendarPractitioner[];
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

export interface LiveBookInput {
  practitionerUserId: string;
  appointmentType: string;
  startsAtIso: string;
  endsAtIso: string;
  patientId?: string;
  location?: string;
}
