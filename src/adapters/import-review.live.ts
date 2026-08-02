if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./supabase-rest.server";
import type {
  LiveCatalogReviewQueue,
  LiveImportProvenanceHistory,
  LiveImportSourceInventory,
} from "./live-types";

/**
 * The Phase 9C review surface, server-side (server-only).
 *
 * Every guarantee below lives in the database, not here. This file is a
 * transport, deliberately: a rule enforced in an adapter stops applying the
 * moment somebody calls the RPC from anywhere else, and these RPCs are the
 * ones standing between a spreadsheet row and a patient.
 *
 * What the database enforces, and what this namespace therefore cannot cross:
 *
 *   - a source file recorded as `available` must carry a real digest, and one
 *     recorded as `unavailable` must say why;
 *   - an ambiguity may only be resolved onto a product the row itself raised
 *     as a candidate;
 *   - a restriction is cleared by an owner or admin with a stated reason, and
 *     clearance is not approval;
 *   - a review cannot be completed on an `incomplete` product, and the refusal
 *     names the facts the source did not supply;
 *   - provenance is append-only, so the history this reads cannot have been
 *     rewritten to agree with the record it describes.
 */
export const importReviewLive = {
  /* -------------------------------------------------- source inventory */

  async recordSourceFile(
    input: {
      declaredName: string;
      sourceKind?: string | null;
      availability: "available" | "unavailable";
      contentSha256?: string | null;
      byteSize?: number | null;
      unavailableReason?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<{ ok: true; sourceFileId: string; availability: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; sourceFileId: string; availability: string }>(
      "record_import_source_file",
      {
        _organization_id: resolveOrgId(organizationId),
        _declared_name: input.declaredName,
        _source_kind: input.sourceKind ?? null,
        _availability: input.availability,
        _content_sha256: input.contentSha256 ?? null,
        _byte_size: input.byteSize ?? null,
        _unavailable_reason: input.unavailableReason ?? null,
      },
      token,
    );
  },

  async sourceInventory(
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveImportSourceInventory> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveImportSourceInventory>(
      "get_import_source_inventory",
      { _organization_id: resolveOrgId(organizationId) },
      token,
    );
  },

  /* ------------------------------------------------------- ambiguity */

  /**
   * Three answers and no fourth.
   *
   * `existingProductId` is required for `same_as_existing` and is checked by
   * the RPC against the candidates the row actually raised — a reviewer cannot
   * point a row at a product nobody compared it against.
   */
  async resolveAmbiguity(
    input: {
      itemId: string;
      resolution: "new_product" | "same_as_existing" | "skip";
      note: string;
      existingProductId?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<{ ok: true; itemId: string; resolution: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; itemId: string; resolution: string }>(
      "resolve_knowledge_import_ambiguity",
      {
        _item_id: input.itemId,
        _resolution: input.resolution,
        _note: input.note,
        _existing_product_id: input.existingProductId ?? null,
      },
      token,
    );
  },

  /* -------------------------------------------------- catalog review */

  async reviewQueue(
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveCatalogReviewQueue> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveCatalogReviewQueue>(
      "get_catalog_review_queue",
      { _organization_id: resolveOrgId(organizationId) },
      token,
    );
  },

  async clearRestriction(
    productId: string,
    note: string,
    sessionToken?: string | null,
  ): Promise<{ ok: true; productId: string; message: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; productId: string; message: string }>(
      "clear_catalog_product_restriction",
      { _product_id: productId, _note: note },
      token,
    );
  },

  async completeReview(
    productId: string,
    note: string,
    sessionToken?: string | null,
  ): Promise<{ ok: true; productId: string; status: string; message: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; productId: string; status: string; message: string }>(
      "complete_catalog_product_review",
      { _product_id: productId, _note: note },
      token,
    );
  },

  /* --------------------------------------------------- provenance */

  async provenance(
    input: { refType?: string | null; refId?: string | null; limit?: number } = {},
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveImportProvenanceHistory> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveImportProvenanceHistory>(
      "get_import_provenance",
      {
        _organization_id: resolveOrgId(organizationId),
        _ref_type: input.refType ?? null,
        _ref_id: input.refId ?? null,
        _limit: input.limit ?? 50,
      },
      token,
    );
  },
};
