/**
 * Phase 10A — governed retrieval.
 *
 * Reads ONLY from approved governed sources:
 *   - governed_knowledge_references where reviewer_state='approved'
 *   - product_label_versions where status='verified'
 *   - approved protocol templates (existing table)
 *   - approved diet templates (existing table)
 *
 * Commercial data (affiliate URLs, discount codes, supplier names, prices)
 * is NEVER read here and cannot enter retrieval, ranking, eligibility, or
 * prompt assembly. Enforced structurally: this module imports nothing from
 * the commercial namespace.
 *
 * A citation returned by a model IS refused unless its id is present in the
 * `allowedCitationIds` set assembled by this module — that set is stored on
 * the run as `clinical_copilot_run_citations`.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/retrieval is server-only.");
}

export type GovernedSourceRef = {
  type: "knowledge_reference" | "product_label" | "protocol_template" | "diet_template";
  id: string;
  version: string | null;
};

/**
 * Assemble the retrieval envelope. The caller (input builder) has already
 * confirmed org membership and patient ownership.
 *
 * For Phase 10A this is a deterministic stub that returns an empty envelope
 * unless the caller passes explicit governed source ids. Phase 10B replaces
 * the body with real similarity-based retrieval against embedded
 * governed sources — but the boundary (approved only, no commercial) stays.
 */
export function assembleRetrieval(input: {
  approvedKnowledgeReferenceIds: string[];
  verifiedLabelIds: string[];
  approvedProtocolTemplateIds: string[];
  approvedDietTemplateIds: string[];
}): {
  allowedCitationIds: Set<string>;
  sources: GovernedSourceRef[];
} {
  const sources: GovernedSourceRef[] = [
    ...input.approvedKnowledgeReferenceIds.map((id) => ({
      type: "knowledge_reference" as const,
      id,
      version: null,
    })),
    ...input.verifiedLabelIds.map((id) => ({
      type: "product_label" as const,
      id,
      version: null,
    })),
    ...input.approvedProtocolTemplateIds.map((id) => ({
      type: "protocol_template" as const,
      id,
      version: null,
    })),
    ...input.approvedDietTemplateIds.map((id) => ({
      type: "diet_template" as const,
      id,
      version: null,
    })),
  ];
  return {
    allowedCitationIds: new Set(sources.map((s) => s.id)),
    sources,
  };
}

/**
 * Rejects any citation not in the allowed set. Called AFTER the model
 * returns — this is the hallucinated-citation guard.
 */
export function validateCitations(
  emitted: Array<{ refId: string }>,
  allowed: ReadonlySet<string>,
): { accepted: Array<{ refId: string }>; rejected: string[] } {
  const rejected: string[] = [];
  const accepted: Array<{ refId: string }> = [];
  for (const c of emitted) {
    if (allowed.has(c.refId)) accepted.push(c);
    else rejected.push(c.refId);
  }
  return { accepted, rejected };
}
