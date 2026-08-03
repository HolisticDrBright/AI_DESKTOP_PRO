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

  /* ------------------------------------------------------- conflict resolution */

  /**
   * Ordinary conflict resolution. Distinct from ambiguity: an ambiguity is
   * "this row might be an existing product"; a conflict is "two rows in the
   * same file claim the same identity, pick one." Three governed answers,
   * each demands a reason.
   */
  async resolveConflict(
    input: {
      itemId: string;
      resolution: "keep_existing" | "take_incoming" | "skip";
      note: string;
    },
    sessionToken?: string | null,
  ): Promise<{ ok: true; itemId: string; resolution: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; itemId: string; resolution: string }>(
      "resolve_knowledge_import_conflict",
      {
        _item_id: input.itemId,
        _resolution: input.resolution,
        _note: input.note,
      },
      token,
    );
  },

  /* ---------------------------------------------- 5-outcome restricted review */

  /**
   * Phase 9E-A: five discrete outcomes with a required reason. The
   * clinician-for-jurisdiction outcome additionally requires a jurisdiction.
   * NONE of these outcomes clears the restriction — clearance stays a
   * separate action (`clearRestriction`).
   */
  async recordRestrictedReviewOutcome(
    input: {
      /**
       * Phase 9E-A.1: the subject can now be a preview import item or a
       * governed knowledge reference in addition to a supplement product.
       * The client passes `subjectType` + `subjectId`; when omitted, the
       * legacy `productId` path routes to `subjectType = "product"` for
       * backwards compatibility.
       */
      subjectType?: "product" | "preview_item" | "knowledge_reference";
      subjectId?: string;
      productId?: string;
      outcome:
        | "retain_restricted"
        | "request_evidence"
        | "defer"
        | "reject"
        | "clinician_reviewed_for_jurisdiction";
      reason: string;
      jurisdiction?: string | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<{
    ok: true;
    decisionId: string;
    subjectType: "product" | "preview_item" | "knowledge_reference";
    subjectId: string;
    outcome: string;
    restrictionsPreserved: true;
  }> {
    const token = await getClinicalAccessToken(sessionToken);
    const subjectType = input.subjectType ?? "product";
    const subjectId = input.subjectId ?? input.productId ?? "";
    return clinicalRpc<{
      ok: true;
      decisionId: string;
      subjectType: "product" | "preview_item" | "knowledge_reference";
      subjectId: string;
      outcome: string;
      restrictionsPreserved: true;
    }>(
      "record_restricted_review_outcome_v2",
      {
        _organization_id: resolveOrgId(organizationId),
        _subject_type: subjectType,
        _subject_id: subjectId,
        _outcome: input.outcome,
        _reason: input.reason,
        _jurisdiction: input.jurisdiction ?? null,
      },
      token,
    );
  },

  async restrictedReviewHistory(
    input:
      | string
      | { subjectType: "product" | "preview_item" | "knowledge_reference"; subjectId: string },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<{
    subjectType: "product" | "preview_item" | "knowledge_reference";
    subjectId: string;
    organizationId: string;
    currentOutcome: string | null;
    history: Array<{
      id: string;
      outcome: string;
      reason: string;
      jurisdiction: string | null;
      decidedBy: string;
      decidedAt: string;
    }>;
  }> {
    const token = await getClinicalAccessToken(sessionToken);
    const subjectType: "product" | "preview_item" | "knowledge_reference" =
      typeof input === "string" ? "product" : input.subjectType;
    const subjectId = typeof input === "string" ? input : input.subjectId;
    return clinicalRpc<{
      subjectType: "product" | "preview_item" | "knowledge_reference";
      subjectId: string;
      organizationId: string;
      currentOutcome: string | null;
      history: Array<{
        id: string;
        outcome: string;
        reason: string;
        jurisdiction: string | null;
        decidedBy: string;
        decidedAt: string;
      }>;
    }>(
      "get_restricted_review_history_v2",
      {
        _organization_id: resolveOrgId(organizationId),
        _subject_type: subjectType,
        _subject_id: subjectId,
      },
      token,
    );
  },

  /**
   * Phase 9E-A.1: unified restricted-review queue across preview items,
   * committed catalog products, and governed knowledge references. Returned
   * rows carry a `subjectType` discriminator so the UI can label them.
   */
  async restrictedReviewQueue(
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<{
    items: Array<{
      subjectType: "preview_item" | "product" | "knowledge_reference";
      subjectId: string;
      displayName: string;
      entityType: string;
      restrictedFlags: string[];
      missingFacts: string[];
      changeKind: string | null;
      status: string;
      sourceName: string | null;
      sourceSheet: string | null;
      sourceRowNumber: number | null;
      currentOutcome: string | null;
    }>;
    counts: {
      total: number;
      previewItems: number;
      products: number;
      knowledgeReferences: number;
    };
  }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc(
      "get_restricted_review_queue",
      { _organization_id: resolveOrgId(organizationId) },
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
