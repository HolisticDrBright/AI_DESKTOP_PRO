/**
 * Phase 10A — governed retrieval.
 *
 * Reads ONLY from approved governed sources:
 *   - governed_knowledge_references where reviewer_state='approved'
 *   - product_label_versions where status='verified'
 *   - protocol_templates where status in ('approved','published')
 *   - nutrition_templates where status in ('approved','published')
 *
 * Commercial data (affiliate URLs, discount codes, supplier names, prices)
 * is NEVER read here and cannot enter retrieval, ranking, eligibility, or
 * prompt assembly. Enforced structurally: this module imports nothing from
 * the commercial namespace. The SQL adversarial suite greps this file for
 * commercial-import strings and fails the build if any appear.
 *
 * A citation returned by a model IS refused unless its id is present in the
 * `allowedCitationIds` set assembled by this module — that set is stored on
 * the run as `clinical_copilot_run_citations`.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/retrieval is server-only.");
}

import { clinicalRpc } from "@/adapters/supabase-rest.server";

export type GovernedSourceRef = {
  type: "knowledge_reference" | "product_label" | "protocol_template" | "diet_template";
  id: string;
  version: string | null;
};

export type GovernedRetrievalEnvelope = {
  allowedCitationIds: Set<string>;
  sources: GovernedSourceRef[];
};

/**
 * Assemble the retrieval envelope from explicit governed-source id lists.
 * The caller either fetched them via `fetchGovernedRetrieval` or supplied
 * them (tests, imports isolation).
 */
export function assembleRetrieval(input: {
  approvedKnowledgeReferenceIds: string[];
  verifiedLabelIds: string[];
  approvedProtocolTemplateIds: string[];
  approvedDietTemplateIds: string[];
}): GovernedRetrievalEnvelope {
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

type RpcCaller = <T>(fn: string, args: Record<string, unknown>, token?: string | null) => Promise<T>;

/**
 * Real governed retrieval — invokes the RLS-scoped SECURITY DEFINER RPC
 * `fetch_copilot_governed_retrieval`. On current staging every approved-source
 * table returns 0 rows for this org, so the envelope comes back empty
 * honestly — the copilot workspace displays that as "no approved sources
 * available" rather than fabricating citations. Never falls back to empty
 * arrays on error — a failed fetch is a failed run.
 */
export async function fetchGovernedRetrieval(
  input: { organizationId: string; accessToken: string | null },
  _call: RpcCaller = clinicalRpc,
): Promise<GovernedRetrievalEnvelope> {
  if (!input.organizationId) throw new Error("organizationId is required.");
  const raw = await _call<{
    approvedKnowledgeReferenceIds: string[];
    verifiedLabelIds: string[];
    approvedProtocolTemplateIds: string[];
    approvedDietTemplateIds: string[];
  }>(
    "fetch_copilot_governed_retrieval",
    { _organization_id: input.organizationId },
    input.accessToken,
  );
  if (!raw || typeof raw !== "object") {
    throw new Error("fetch_copilot_governed_retrieval returned an unexpected shape.");
  }
  return assembleRetrieval({
    approvedKnowledgeReferenceIds: raw.approvedKnowledgeReferenceIds ?? [],
    verifiedLabelIds: raw.verifiedLabelIds ?? [],
    approvedProtocolTemplateIds: raw.approvedProtocolTemplateIds ?? [],
    approvedDietTemplateIds: raw.approvedDietTemplateIds ?? [],
  });
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
