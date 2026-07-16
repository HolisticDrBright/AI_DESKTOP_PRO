if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { backendUpload, trpcMutation, trpcQuery } from "./trpc.server";
import type { LabWorkspace } from "./labs.mock";
import type { LiveReviewResult, LiveUploadResult, ReviewDecision } from "./live-types";

/**
 * Live `labs` namespace (server-only).
 *
 * Reads the labs workspace and writes marker reviews through the authenticated
 * tRPC backend's `clinical.labs.*` procedures (RLS enforced). The backend
 * procedure shapes real biomarker_observations (+ definitions / panels /
 * documents) into the LabWorkspace DTO and — on review — calls the
 * `review_biomarker` SECURITY DEFINER RPC (migration 0013), which updates the
 * review columns and appends the audit_events row atomically. The reference
 * interval, lab value, provenance and confidence are never overwritten.
 *
 * These procedures are the backend contract this desktop consumes; wiring them
 * in `rork-ai-longevity-coach` is tracked in docs/live-api.md. Until they are
 * reachable, calls surface as a clean `unavailable` AdapterError and the UI
 * renders its error state — never a fake success.
 */
export const labsLive = {
  getWorkspace(patientId: string, sessionToken?: string | null): Promise<LabWorkspace> {
    return trpcQuery<LabWorkspace>("clinical.labs.getWorkspace", { patientId }, sessionToken);
  },

  reviewMarker(
    observationId: string,
    decision: ReviewDecision,
    note?: string,
    sessionToken?: string | null,
  ): Promise<LiveReviewResult> {
    return trpcMutation<LiveReviewResult>(
      "clinical.labs.reviewMarker",
      { observationId, decision, note },
      sessionToken,
    );
  },

  /**
   * Upload a lab PDF for ingestion. The backend runs the whole pipeline as
   * the signed-in practitioner: lab_documents insert under RLS → storage
   * upload (path-scoped storage RLS) → deterministic extraction →
   * ingest_lab_extraction RPC (observations + review-queue item + audit,
   * atomic — migration 0016). A 'failed' status is an honest outcome: the
   * PDF is stored for manual review and the failure is audited.
   */
  uploadDocument(
    patientId: string,
    file: File,
    sessionToken?: string | null,
  ): Promise<LiveUploadResult> {
    const form = new FormData();
    form.set("patientId", patientId);
    form.set("file", file);
    return backendUpload<LiveUploadResult>("/api/clinical/labs/upload", form, sessionToken);
  },
};
