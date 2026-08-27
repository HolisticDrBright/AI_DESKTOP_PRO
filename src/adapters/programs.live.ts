if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveProgramDraftPayload,
  LiveProgramEnrollmentStatus,
  LiveProgramLibrary,
  LiveProgramMutationResult,
  LiveProgramOfferPaymentMode,
  LiveProgramStudio,
  LiveProgramTemplate,
  LivePatientPrograms,
} from "./live-types";

/**
 * Live Programs & Education namespace (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in practitioner, so
 * the database enforces membership, clinical role, patient access, tenant
 * agreement, the version lifecycle, and the immutability of frozen versions.
 *
 * Boundaries this namespace can NEVER cross, because the RPCs have no such
 * code path: publishing creates no enrollment, invoice, charge, message,
 * protocol, order, task, or note; offers store commercial terms only and a
 * Stripe-mode offer refuses enrollment as honestly not configured; enrollment
 * pins the exact published version and later publishes never move it.
 */
export const programsLive = {
  async listPrograms(
    query: string | null,
    status: string | null,
    limit: number,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramLibrary> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProgramLibrary>(
      "list_programs",
      { _organization_id: orgId, _query: query, _status: status, _limit: limit },
      token,
    );
  },

  async getStudio(
    programId: string,
    sessionToken?: string | null,
  ): Promise<LiveProgramStudio> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramStudio>(
      "get_program_studio",
      { _program_id: programId },
      token,
    );
  },

  async listTemplates(
    includeArchived: boolean,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramTemplate[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProgramTemplate[]>(
      "list_program_templates",
      { _organization_id: orgId, _include_archived: includeArchived },
      token,
    );
  },

  /** Blank program, or a DETACHED copy of an approved template version. */
  async createProgram(
    input: { name: string; fromTemplateId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProgramMutationResult>(
      "create_program",
      {
        _organization_id: orgId,
        _name: input.name,
        _from_template_id: input.fromTemplateId ?? null,
      },
      token,
    );
  },

  /**
   * Wholesale autosave. `expectedUpdatedAt` is the concurrency token — a stale
   * token returns a conflict rather than overwriting another editor.
   */
  async saveDraft(
    versionId: string,
    payload: LiveProgramDraftPayload,
    expectedUpdatedAt: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "save_program_draft",
      {
        _version_id: versionId,
        _payload: payload,
        _expected_updated_at: expectedUpdatedAt,
      },
      token,
    );
  },

  async submitVersion(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "submit_program_version",
      { _version_id: versionId },
      token,
    );
  },

  async returnVersion(
    versionId: string,
    note: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "return_program_version",
      { _version_id: versionId, _note: note },
      token,
    );
  },

  /** Freezes the version. Does NOT publish it — that is a separate action. */
  async approveVersion(
    versionId: string,
    note: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "approve_program_version",
      { _version_id: versionId, _note: note },
      token,
    );
  },

  /**
   * SEPARATE from approval, only ever called behind a UI confirmation.
   * Supersedes the previously published version WITHOUT touching enrollments
   * pinned to it, and has zero commercial or clinical side effects.
   */
  async publishVersion(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "publish_program_version",
      { _version_id: versionId },
      token,
    );
  },

  /** Frozen versions are immutable; this is the sanctioned edit path. */
  async reviseVersion(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "revise_program_version",
      { _version_id: versionId },
      token,
    );
  },

  /** Archive/restore. Published history and enrollments are preserved. */
  async archiveProgram(
    programId: string,
    archived: boolean,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "archive_program",
      { _program_id: programId, _archived: archived },
      token,
    );
  },

  async createTemplate(
    input: { name: string; description?: string | null; fromVersionId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProgramMutationResult>(
      "create_program_template",
      {
        _organization_id: orgId,
        _name: input.name,
        _description: input.description ?? null,
        _from_version_id: input.fromVersionId ?? null,
      },
      token,
    );
  },

  async approveTemplateVersion(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "approve_program_template_version",
      { _version_id: versionId },
      token,
    );
  },

  /** Archiving never cascades into programs created from the template. */
  async archiveTemplate(
    templateId: string,
    archived: boolean,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "archive_program_template",
      { _template_id: templateId, _archived: archived },
      token,
    );
  },

  /** Stores commercial terms ONLY. This application never processes payment. */
  async upsertOffer(
    input: {
      programId: string;
      offerId?: string | null;
      name?: string | null;
      priceCents?: number;
      currency?: string;
      accessDurationDays?: number | null;
      paymentMode?: LiveProgramOfferPaymentMode;
      enrollmentOpen?: boolean;
      status?: "active" | "retired";
    },
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "upsert_program_offer",
      {
        _program_id: input.programId,
        _offer_id: input.offerId ?? null,
        _name: input.name ?? null,
        _price_cents: input.priceCents ?? 0,
        _currency: input.currency ?? "usd",
        _access_duration_days: input.accessDurationDays ?? null,
        _payment_mode: input.paymentMode ?? "free",
        _enrollment_open: input.enrollmentOpen ?? true,
        _status: input.status ?? "active",
      },
      token,
    );
  },

  /**
   * Pins the enrollment to the exact currently-published version. The server
   * decides eligibility: archived programs and unpublished programs refuse, a
   * Stripe offer refuses as not configured, and a complimentary enrollment
   * requires a reason (the authorizer is the authenticated caller, recorded
   * server-side with an audit event).
   */
  async enrollPatient(
    input: {
      programId: string;
      patientId: string;
      offerId?: string | null;
      activate?: boolean;
      compReason?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "enroll_patient_in_program",
      {
        _program_id: input.programId,
        _patient_id: input.patientId,
        _offer_id: input.offerId ?? null,
        _activate: input.activate ?? true,
        _comp_reason: input.compReason ?? null,
      },
      token,
    );
  },

  /** Pause / resume / complete / cancel / expire, machine-enforced. */
  async setEnrollmentStatus(
    enrollmentId: string,
    status: LiveProgramEnrollmentStatus,
    reason: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "set_program_enrollment_status",
      { _enrollment_id: enrollmentId, _status: status, _reason: reason },
      token,
    );
  },

  /**
   * Append-only progress. The lesson/block must belong to the enrollment's
   * PINNED version; the audit event carries identifiers, never the payload.
   */
  async recordProgress(
    input: {
      enrollmentId: string;
      kind: "lesson_completed" | "check_in" | "quiz_response" | "adherence";
      lessonId?: string | null;
      blockId?: string | null;
      payload?: Record<string, unknown>;
      needsReview?: boolean;
    },
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "record_program_progress",
      {
        _enrollment_id: input.enrollmentId,
        _kind: input.kind,
        _lesson_id: input.lessonId ?? null,
        _block_id: input.blockId ?? null,
        _payload: input.payload ?? {},
        _needs_review: input.needsReview ?? false,
      },
      token,
    );
  },

  /** The practitioner's explicit, audited progress review (idempotent). */
  async reviewProgress(
    progressId: string,
    sessionToken?: string | null,
  ): Promise<LiveProgramMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProgramMutationResult>(
      "review_program_progress",
      { _progress_id: progressId },
      token,
    );
  },

  /** Patient-chart view: enrollments, pinned versions, persisted progress. */
  async getPatientPrograms(
    patientId: string,
    sessionToken?: string | null,
  ): Promise<LivePatientPrograms> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientPrograms>(
      "get_patient_programs",
      { _patient_id: patientId },
      token,
    );
  },
};
