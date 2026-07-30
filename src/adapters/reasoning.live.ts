if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { AdapterError } from "./errors";
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./supabase-rest.server";
import type { LiveHypothesisReviewResult, LiveReasoningWorkspace } from "./live-types";

/**
 * Live clinical-reasoning namespace (server-only).
 *
 * Reads and review actions go through Desktop-owned database functions as the
 * signed-in practitioner:
 *
 *   get_reasoning_workspace  snapshot meta (version + staleness vs source
 *                            data), hypotheses as inferences with the internal
 *                            evidence-weighting wording preserved verbatim,
 *                            evidence split supporting/conflicting/missing
 *                            with per-item source links, and the
 *                            lens-invariant urgent safety questions.
 *   review_hypothesis        accepted / rejected / needs_data. The review row,
 *                            hypothesis state, and audit event persist in ONE
 *                            transaction. Accepting never writes into a note
 *                            or care plan.
 *
 * AI generation is not configured; the workspace says so honestly and this
 * module never substitutes fixture output.
 */
export const reasoningLive = {
  async getWorkspace(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveReasoningWorkspace> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveReasoningWorkspace>(
      "get_reasoning_workspace",
      { _organization_id: orgId, _patient_id: patientId },
      token,
    );
  },

  async reviewHypothesis(
    hypothesisId: string,
    action: "accepted" | "rejected" | "needs_data",
    note?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveHypothesisReviewResult> {
    if (!["accepted", "rejected", "needs_data"].includes(action)) {
      throw new AdapterError("invalid", "Unknown review action.");
    }
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveHypothesisReviewResult>(
      "review_hypothesis",
      { _hypothesis_id: hypothesisId, _action: action, _note: note ?? null },
      token,
    );
  },
};
