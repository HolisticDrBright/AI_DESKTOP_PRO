if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveCatalogSearch,
  LiveInteractionCheck,
  LiveInteractionReviewResult,
  LivePatientProtocol,
  LiveProtocolDraftPayload,
  LiveProtocolMutationResult,
  LiveProtocolTemplate,
} from "./live-types";

/**
 * Live protocol + template namespace (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in practitioner, so
 * the database enforces membership, clinical role, patient access, tenant
 * agreement across referenced records, and the immutability of approved/active
 * versions. Nothing here can send a message, place an order, charge, modify a
 * medication, write into a note, or activate a protocol implicitly —
 * activation is its own RPC, invoked only from an explicit confirmed action.
 */
export const protocolsLive = {
  async getPatientProtocol(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LivePatientProtocol> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LivePatientProtocol>(
      "get_patient_protocol",
      { _organization_id: orgId, _patient_id: patientId },
      token,
    );
  },

  async listTemplates(
    includeArchived: boolean,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProtocolTemplate[]> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProtocolTemplate[]>(
      "list_protocol_templates",
      { _organization_id: orgId, _include_archived: includeArchived },
      token,
    );
  },

  async createDraft(
    input: { patientId: string; title: string; fromTemplateId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProtocolMutationResult>(
      "create_protocol_draft",
      {
        _organization_id: orgId,
        _patient_id: input.patientId,
        _title: input.title,
        _from_template_id: input.fromTemplateId ?? null,
      },
      token,
    );
  },

  async saveDraft(
    versionId: string,
    payload: LiveProtocolDraftPayload,
    expectedUpdatedAt: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "save_protocol_draft",
      {
        _version_id: versionId,
        _payload: payload,
        _expected_updated_at: expectedUpdatedAt,
      },
      token,
    );
  },

  async approveVersion(
    versionId: string,
    reviewNote: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "approve_protocol_version",
      { _version_id: versionId, _review_note: reviewNote },
      token,
    );
  },

  /** SEPARATE from approval, and only ever called behind a UI confirmation. */
  async activateVersion(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "activate_protocol_version",
      { _version_id: versionId },
      token,
    );
  },

  async setLifecycle(
    protocolId: string,
    status: "active" | "paused" | "completed" | "discontinued",
    reason: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "set_protocol_lifecycle",
      { _protocol_id: protocolId, _status: status, _reason: reason },
      token,
    );
  },

  /** Approved/active versions are immutable; this is the sanctioned edit path. */
  async reviseVersion(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "revise_protocol_version",
      { _version_id: versionId },
      token,
    );
  },

  async createTemplate(
    input: { name: string; description?: string | null; fromVersionId?: string | null },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveProtocolMutationResult>(
      "create_protocol_template",
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
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "approve_protocol_template_version",
      { _version_id: versionId },
      token,
    );
  },

  /** Archiving never cascades to protocols already created from the template. */
  async archiveTemplate(
    templateId: string,
    archived: boolean,
    sessionToken?: string | null,
  ): Promise<LiveProtocolMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolMutationResult>(
      "archive_protocol_template",
      { _template_id: templateId, _archived: archived },
      token,
    );
  },

  /**
   * The REAL product catalog picker. Returns exact catalog identity
   * (product id, label version id, manufacturer, label version) plus a
   * verification status DERIVED from what the catalog actually holds — a
   * caller can never assert that a product is structured-verified.
   */
  async searchCatalog(
    query: string | null,
    limit: number,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveCatalogSearch> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveCatalogSearch>(
      "search_protocol_catalog",
      { _organization_id: orgId, _query: query, _limit: limit },
      token,
    );
  },

  /**
   * The deterministic interaction check. It runs ONLY where structured data
   * exists on both sides (catalog ingredients and coded medications); every
   * other case comes back `not_completed` with the reason. A completed check
   * reports what the checked sources contain and never asserts that a product
   * is interaction-free.
   */
  async checkInteractions(
    versionId: string,
    sessionToken?: string | null,
  ): Promise<LiveInteractionCheck> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInteractionCheck>(
      "check_protocol_interactions",
      { _version_id: versionId },
      token,
    );
  },

  /** The practitioner's explicit, audited interaction sign-off (drafts only). */
  async reviewItemInteractions(
    itemId: string,
    note: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInteractionReviewResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInteractionReviewResult>(
      "review_protocol_item_interactions",
      { _item_id: itemId, _note: note },
      token,
    );
  },
};
