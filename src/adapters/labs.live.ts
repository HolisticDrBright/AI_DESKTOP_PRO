if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { AdapterError } from "./errors";
import {
  buildLabWorkspace,
  type LabDocumentRow,
  type LabObservationRow,
} from "./labs.map";
import type { LabWorkspace } from "./labs.types";
import type { LiveReviewResult, LiveUploadResult, ReviewDecision } from "./live-types";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc, clinicalSelect } from "./aws-clinical-data.server";
import { backendUpload } from "./trpc.server";

/**
 * Live `labs` namespace (server-only).
 *
 * Workspace reads now use Desktop-owned Supabase contracts directly. The
 * SECURITY INVOKER read RPC plus patient/document selects all run as the
 * signed-in practitioner, so table grants and RLS are authoritative. Marker
 * reviews call `review_biomarker`, which updates review columns and appends the
 * audit event atomically without touching the measured value, lab reference
 * interval, provenance, or extraction confidence.
 *
 * PDF upload remains on the transitional worker-backed endpoint because it
 * coordinates Storage and extraction jobs rather than a simple data read.
 */
export const labsLive = {
  async getWorkspace(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LabWorkspace> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);

    const patientParams = new URLSearchParams({
      select: "first_name,last_name",
      id: `eq.${patientId}`,
      organization_id: `eq.${orgId}`,
      deleted_at: "is.null",
      limit: "1",
    });
    const documentParams = new URLSearchParams({
      select: "id,file_name,lab_company,panel_name,lab_date,created_at",
      patient_id: `eq.${patientId}`,
      organization_id: `eq.${orgId}`,
      deleted_at: "is.null",
      order: "created_at.desc",
      limit: "20",
    });

    const [observations, documents, patients] = await Promise.all([
      clinicalRpc<LabObservationRow[]>(
        "list_patient_lab_observations",
        { _organization_id: orgId, _patient_id: patientId },
        token,
      ),
      clinicalSelect<LabDocumentRow[]>("lab_documents", documentParams, token),
      clinicalSelect<Array<{ first_name: string | null; last_name: string | null }>>(
        "patient_profiles",
        patientParams,
        token,
      ),
    ]);

    const patient = patients[0];
    if (!patient) throw new AdapterError("not_found", "Patient not found or not accessible.");
    const patientName =
      `${patient.first_name ?? ""} ${patient.last_name ?? ""}`.trim() || "this patient";

    return buildLabWorkspace({
      patientId,
      patientName,
      observations,
      documents,
    });
  },

  async reviewMarker(
    observationId: string,
    decision: ReviewDecision,
    note?: string,
    sessionToken?: string | null,
  ): Promise<LiveReviewResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const result = await clinicalRpc<{
      review_status: ReviewDecision;
      reviewed_at: string | null;
      previous_status: string | null;
    }>(
      "review_biomarker",
      {
        _observation_id: observationId,
        _decision: decision,
        _note: note ?? null,
      },
      token,
    );
    return {
      ok: true,
      reviewStatus: result.review_status,
      reviewedAt: result.reviewed_at ?? null,
      previousStatus: result.previous_status ?? null,
      message: `Review saved (${result.review_status}).`,
    };
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
