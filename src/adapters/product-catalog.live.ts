if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./supabase-rest.server";
import type {
  LiveProductCatalog,
  LiveProductLabelDetail,
  LiveProtocolTemplateDetail,
  LiveTemplateComparison,
  LiveTemplateSafetyOutcome,
} from "./live-types";

/**
 * The Product Catalog registry and protocol template lifecycle (server-only).
 *
 * Transport, deliberately. Every guarantee below is enforced by the database,
 * because a guarantee enforced here evaporates the moment the RPC is called
 * from anywhere else — a worker, a migration, a future route.
 *
 * What the RPCs enforce, and this namespace therefore cannot loosen:
 *
 *   - the `clinical` / `commercial` split. This file passes the response
 *     through unchanged rather than flattening it: a flat object is one
 *     careless spread away from an affiliate URL reaching a clinical
 *     renderer;
 *   - unknown stays NULL. Nothing here substitutes a default, an empty
 *     string, or "None" for a field the label did not carry;
 *   - verification is asserted by a named owner/admin, never by a caller;
 *   - a template version with an unsourced dose cannot be published, and the
 *     refusal names the items;
 *   - superseding never deletes, and a safety review can never be edited.
 *
 * There is no write path from this namespace into label CONTENT. Labels are
 * written by the governed import pipeline and by `save_product_label_version`;
 * this namespace reads them and records verification.
 */
export const productCatalogLive = {
  /**
   * The catalog list plus its counts and the import review queue.
   *
   * Returns zero products for an empty registry, together with the database's
   * own explanation of why it is empty. The explanation is not written here so
   * that a caller cannot soften it.
   */
  async list(
    input: {
      query?: string | null;
      status?: string | null;
      limit?: number | null;
    } = {},
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveProductCatalog> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProductCatalog>(
      "get_product_catalog",
      {
        _organization_id: resolveOrgId(organizationId),
        _query: input.query ?? null,
        _status: input.status ?? null,
        _limit: input.limit ?? null,
      },
      token,
    );
  },

  /** One label in full, with commercial links in their own branch. */
  async labelDetail(
    labelVersionId: string,
    sessionToken?: string | null,
  ): Promise<LiveProductLabelDetail> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProductLabelDetail>(
      "get_product_label_detail",
      { _label_version_id: labelVersionId },
      token,
    );
  },

  /**
   * Record that a named person checked this exact label.
   *
   * The RPC requires owner/admin and refuses a practitioner, so "verified" is
   * always attributable. The note is required by the caller here because a
   * verification with no statement of what was checked is not evidence.
   */
  async verifyLabel(
    labelVersionId: string,
    verificationNote: string,
    sessionToken?: string | null,
  ): Promise<void> {
    const token = await getClinicalAccessToken(sessionToken);
    await clinicalRpc<null>(
      "verify_product_label_version",
      {
        _label_version_id: labelVersionId,
        _verification_note: verificationNote,
      },
      token,
    );
  },
};

/** Protocol template lifecycle: detail, compare, safety review, supersede. */
export const protocolTemplateLive = {
  async detail(
    templateId: string,
    sessionToken?: string | null,
  ): Promise<LiveProtocolTemplateDetail> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveProtocolTemplateDetail>(
      "get_protocol_template_detail",
      { _template_id: templateId },
      token,
    );
  },

  /**
   * Compare two TEMPLATE versions.
   *
   * They need not belong to the same template — comparing a duplicate against
   * the template it came from is the commonest review there is. The RPC
   * refuses a patient protocol version on either side, because those are
   * reachable only through the patient access check.
   */
  async compare(
    leftVersionId: string,
    rightVersionId: string,
    sessionToken?: string | null,
  ): Promise<LiveTemplateComparison> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveTemplateComparison>(
      "compare_protocol_template_versions",
      { _left_version_id: leftVersionId, _right_version_id: rightVersionId },
      token,
    );
  },

  /**
   * Append a safety review.
   *
   * Append, not set: the RPC writes to a log that refuses UPDATE and DELETE, so
   * a changed conclusion is a new review and the earlier one stays readable.
   */
  async recordSafetyReview(
    versionId: string,
    outcome: LiveTemplateSafetyOutcome,
    note: string,
    sessionToken?: string | null,
  ): Promise<{
    ok: true;
    reviewId: string;
    outcome: string;
    unsourcedDoseCount: number;
    message: string;
  }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc(
      "record_protocol_template_safety_review",
      { _version_id: versionId, _outcome: outcome, _note: note },
      token,
    );
  },

  /**
   * Point a template at its successor.
   *
   * Never a delete: protocols already started from this template have to keep
   * resolving. The RPC requires a reason and refuses cycles.
   */
  async supersede(
    templateId: string,
    successorTemplateId: string,
    reason: string,
    sessionToken?: string | null,
  ): Promise<{
    ok: true;
    templateId: string;
    supersededBy: string;
    message: string;
  }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc(
      "supersede_protocol_template",
      {
        _template_id: templateId,
        _successor_template_id: successorTemplateId,
        _reason: reason,
      },
      token,
    );
  },
};
