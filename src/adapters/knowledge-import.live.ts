if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./supabase-rest.server";
import type {
  LiveCommercialDisclosure,
  LiveKnowledgeImportCommitResult,
  LiveKnowledgeImportPreview,
  LiveKnowledgeImportPreviewResult,
} from "./live-types";

/**
 * The governed knowledge import pipeline and commercial disclosure reads
 * (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in practitioner, so
 * the database enforces membership, the knowledge-editor gate, and every
 * refusal below. None of these guarantees lives in this file — this is a
 * transport, and it is written that way on purpose. A guarantee enforced in an
 * adapter is a guarantee that disappears the moment someone calls the RPC from
 * anywhere else.
 *
 * Boundaries the RPCs enforce, which this namespace therefore cannot cross:
 *
 *   - `preview` writes nothing governed. It stages, hashes, dedupes and
 *     classifies, and the acceptance suite proves the governed row count is
 *     unchanged across the call;
 *   - `commit` refuses while any conflict is unresolved, while any applyable
 *     row carries a validation error, and when the counts the reviewer confirms
 *     do not match what is staged;
 *   - everything committed lands as a NON-APPROVED draft;
 *   - removals are reported, never performed. There is no delete path from
 *     this pipeline into governed clinical content;
 *   - COMMERCIAL READS ARE SEPARATE CALLS. Nothing in the clinical path invokes
 *     them, and the disclaimer they carry comes from the database rather than
 *     from this file, so a caller cannot soften it.
 */
export const knowledgeImportLive = {
  /**
   * Stage a preview. WRITES NOTHING GOVERNED.
   *
   * `attestsNoPhi` is required by the RPC and is not defaulted here — an
   * attestation supplied by the adapter rather than by a human is not an
   * attestation.
   */
  async preview(
    input: {
      sourceKind: string | null;
      sourceName: string;
      schemaVersion: string;
      items: unknown[];
      attestsNoPhi: boolean;
      sourceFilename?: string | null;
      sourceByteSize?: number | null;
      sourceRevision?: string | null;
      /**
       * Flags the operator declares on the whole source (e.g.
       * `["vaccine_related"]`, `["peptide"]`). The RPC OR-unions these
       * into every item's `restricted_flags`. Text-signal classification
       * may add `suspected_restricted`; it may never remove one of these.
       */
      sourceRestrictedFlags?: string[] | null;
      sourceRestrictedReason?: string | null;
      /**
       * True when the entire source is commercial metadata. The RPC still
       * previews the rows so the operator can inspect them, but
       * `commit_knowledge_import` refuses commercial-only batches at the
       * entry (SQLSTATE 55000) — commercial data must be attached to
       * existing clinical products via `save_product_label_version`.
       */
      commercialOnly?: boolean | null;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveKnowledgeImportPreviewResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveKnowledgeImportPreviewResult>(
      "preview_knowledge_import",
      {
        _organization_id: resolveOrgId(organizationId),
        _source_kind: input.sourceKind,
        _source_name: input.sourceName,
        _schema_version: input.schemaVersion,
        _items: input.items,
        _attests_no_phi: input.attestsNoPhi,
        _source_filename: input.sourceFilename ?? null,
        _source_byte_size: input.sourceByteSize ?? null,
        _source_revision: input.sourceRevision ?? null,
        _source_restricted_flags: input.sourceRestrictedFlags ?? [],
        _source_restricted_reason: input.sourceRestrictedReason ?? null,
        _commercial_only: input.commercialOnly ?? false,
      },
      token,
    );
  },

  async getPreview(
    batchId: string,
    sessionToken?: string | null,
  ): Promise<LiveKnowledgeImportPreview> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveKnowledgeImportPreview>(
      "get_knowledge_import_preview",
      { _batch_id: batchId },
      token,
    );
  },

  /** Resolve a conflict. The RPC requires a reason and refuses an empty one. */
  async resolveConflict(
    itemId: string,
    resolution: "keep_existing" | "take_incoming" | "skip",
    note: string,
    sessionToken?: string | null,
  ): Promise<{ ok: true; itemId: string; resolution: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; itemId: string; resolution: string }>(
      "resolve_knowledge_import_conflict",
      { _item_id: itemId, _resolution: resolution, _note: note },
      token,
    );
  },

  /**
   * Commit a reviewed batch.
   *
   * `expectedCounts` is what the reviewer actually saw. Passing it is what
   * makes a stale preview fail with a conflict instead of quietly applying a
   * different set of rows than the one that was read.
   */
  async commit(
    batchId: string,
    expectedCounts: { added: number; changed: number } | null,
    note: string | null,
    sessionToken?: string | null,
  ): Promise<LiveKnowledgeImportCommitResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveKnowledgeImportCommitResult>(
      "commit_knowledge_import",
      {
        _batch_id: batchId,
        _expected_counts: expectedCounts,
        _note: note,
      },
      token,
    );
  },

  async cancel(
    batchId: string,
    reason: string,
    sessionToken?: string | null,
  ): Promise<{ ok: true; batchId: string; status: string }> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<{ ok: true; batchId: string; status: string }>(
      "cancel_knowledge_import",
      { _batch_id: batchId, _reason: reason },
      token,
    );
  },

  /* --------------------------------------------- commercial disclosure */

  /**
   * Commercial links for a product label version.
   *
   * Deliberately its own call. Keeping it separate is what makes "commercial
   * data cannot affect clinical eligibility" checkable rather than asserted:
   * the clinical reads never join to it, and the acceptance suite proves no
   * clinical function body names the table.
   */
  async labelCommercialLinks(
    labelVersionId: string,
    sessionToken?: string | null,
  ): Promise<LiveCommercialDisclosure> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveCommercialDisclosure>(
      "list_label_commercial_links",
      { _label_version_id: labelVersionId },
      token,
    );
  },

  async protocolCommercialLinks(
    protocolVersionId: string,
    sessionToken?: string | null,
  ): Promise<LiveCommercialDisclosure> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveCommercialDisclosure>(
      "list_protocol_commercial_links",
      { _version_id: protocolVersionId },
      token,
    );
  },
};
