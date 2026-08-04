/**
 * Phase 10A — copilot run orchestrator.
 *
 * SERVER-ONLY. Composes: safety core (pre) → provider → citation validation
 * → safety core (post) → hash output.
 *
 * The caller is expected to have already built the RLS-scoped input snapshot
 * and fetched the governed retrieval envelope. That ordering exists because
 * the input hash + snapshot are written at CREATE time (Phase 10A end-state):
 * finalize touches ONLY output-side fields, never the input snapshot.
 *
 * Never contacts an external service in Phase 10A. Even the fixture provider
 * runs entirely in-process. The disabled provider (default) never runs at
 * all — it raises `CopilotUnavailable` which the workspace surfaces honestly.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/orchestrator is server-only.");
}

import { createHash } from "node:crypto";
import {
  CopilotUnavailable,
  resolveCopilotMode,
  selectProvider,
  type CopilotDraftOutput,
  type CopilotRunType,
} from "./provider";
import { runSafetyCore, type SafetyItem, type CopilotInputSnapshot } from "./safety";
import { assembleRetrieval, validateCitations, type GovernedRetrievalEnvelope } from "./retrieval";
import { buildEmptySnapshot, hashInputSnapshot, type CopilotInputRecord } from "./input-builder";

export type CopilotRunEnvelope = {
  status: "completed" | "unavailable" | "failed";
  runType: CopilotRunType;
  lens: string;
  providerName: string;
  providerModel: string | null;
  safetyItems: SafetyItem[];
  draft: CopilotDraftOutput | null;
  rejectedCitations: string[];
  inputSnapshotHash: string;
  outputHash: string | null;
  message: string;
};

export type OrchestrateInput = {
  runType: CopilotRunType;
  lens: string;
  snapshot?: CopilotInputSnapshot;
  records?: CopilotInputRecord[];
  retrieval?: GovernedRetrievalEnvelope;
  // Backwards-compatible: explicit governed-source id lists when the caller
  // has not yet fetched a full retrieval envelope.
  approvedKnowledgeReferenceIds?: string[];
  verifiedLabelIds?: string[];
  approvedProtocolTemplateIds?: string[];
  approvedDietTemplateIds?: string[];
};

export async function orchestrateRun(input: OrchestrateInput): Promise<CopilotRunEnvelope> {
  const snapshot = input.snapshot ?? buildEmptySnapshot().snapshot;
  const records = input.records ?? [];
  const retrieval =
    input.retrieval ??
    assembleRetrieval({
      approvedKnowledgeReferenceIds: input.approvedKnowledgeReferenceIds ?? [],
      verifiedLabelIds: input.verifiedLabelIds ?? [],
      approvedProtocolTemplateIds: input.approvedProtocolTemplateIds ?? [],
      approvedDietTemplateIds: input.approvedDietTemplateIds ?? [],
    });

  const preSafety = runSafetyCore(snapshot);
  const inputSnapshotHash = hashInputSnapshot(snapshot, records);
  const mode = resolveCopilotMode();

  if (mode === "disabled") {
    return {
      status: "unavailable",
      runType: input.runType,
      lens: input.lens,
      providerName: "disabled",
      providerModel: null,
      safetyItems: preSafety,
      draft: null,
      rejectedCitations: [],
      inputSnapshotHash,
      outputHash: null,
      message: "Clinical copilot is disabled. The provider was NOT called.",
    };
  }

  try {
    const provider = await selectProvider();
    const draft = await provider.draft({
      runType: input.runType,
      lens: input.lens,
      inputSnapshot: snapshot,
      allowedCitationIds: retrieval.allowedCitationIds,
    });
    const postSafety = runSafetyCore(snapshot);
    if (safetyItemsSummary(preSafety) !== safetyItemsSummary(postSafety)) {
      return {
        status: "failed",
        runType: input.runType,
        lens: input.lens,
        providerName: provider.name,
        providerModel: provider.model,
        safetyItems: preSafety,
        draft: null,
        rejectedCitations: [],
        inputSnapshotHash,
        outputHash: null,
        message: "Safety-core drift detected between pre + post — refused.",
      };
    }
    const validated = validateCitations(draft.citations, retrieval.allowedCitationIds);
    const acceptedDraft: CopilotDraftOutput = {
      ...draft,
      citations: validated.accepted as CopilotDraftOutput["citations"],
    };
    return {
      status: "completed",
      runType: input.runType,
      lens: input.lens,
      providerName: provider.name,
      providerModel: provider.model,
      safetyItems: postSafety,
      draft: acceptedDraft,
      rejectedCitations: validated.rejected,
      inputSnapshotHash,
      outputHash: hashOutput(acceptedDraft),
      message: validated.rejected.length
        ? `Draft accepted; ${validated.rejected.length} hallucinated citation(s) rejected.`
        : "Draft accepted.",
    };
  } catch (e) {
    if (e instanceof CopilotUnavailable) {
      return {
        status: "unavailable",
        runType: input.runType,
        lens: input.lens,
        providerName: "disabled",
        providerModel: null,
        safetyItems: preSafety,
        draft: null,
        rejectedCitations: [],
        inputSnapshotHash,
        outputHash: null,
        message: e.message,
      };
    }
    return {
      status: "failed",
      runType: input.runType,
      lens: input.lens,
      providerName: "unknown",
      providerModel: null,
      safetyItems: preSafety,
      draft: null,
      rejectedCitations: [],
      inputSnapshotHash,
      outputHash: null,
      message: "Copilot run failed. Category: provider_error.",
    };
  }
}

function safetyItemsSummary(items: SafetyItem[]): string {
  return items.map((i) => `${i.category}:${i.severity}:${i.pinned}`).sort().join("|");
}

function hashOutput(draft: CopilotDraftOutput): string {
  return createHash("sha256")
    .update(JSON.stringify({ content: draft.content, citations: draft.citations }))
    .digest("hex");
}
