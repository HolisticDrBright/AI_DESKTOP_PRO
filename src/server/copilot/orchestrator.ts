/**
 * Phase 10A — copilot run orchestrator.
 *
 * SERVER-ONLY. Composes: input builder → safety core (pre) → retrieval
 * → provider → citation validation → safety core (post) → finalize.
 *
 * Never contacts an external service in Phase 10A. Even the fixture
 * provider runs entirely in-process. The disabled provider (default) never
 * runs at all — it raises `CopilotUnavailable` which the workspace surfaces
 * honestly.
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
import { runSafetyCore, type SafetyItem } from "./safety";
import { assembleRetrieval, validateCitations } from "./retrieval";
import { buildEmptySnapshot, hashInputSnapshot } from "./input-builder";

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

export async function orchestrateRun(input: {
  runType: CopilotRunType;
  lens: string;
  // For Phase 10A we accept explicit lists of governed source ids — Phase 10B
  // wires the real retrieval fetchers.
  approvedKnowledgeReferenceIds?: string[];
  verifiedLabelIds?: string[];
  approvedProtocolTemplateIds?: string[];
  approvedDietTemplateIds?: string[];
}): Promise<CopilotRunEnvelope> {
  const { snapshot } = buildEmptySnapshot();
  const preSafety = runSafetyCore(snapshot);
  const retrieval = assembleRetrieval({
    approvedKnowledgeReferenceIds: input.approvedKnowledgeReferenceIds ?? [],
    verifiedLabelIds: input.verifiedLabelIds ?? [],
    approvedProtocolTemplateIds: input.approvedProtocolTemplateIds ?? [],
    approvedDietTemplateIds: input.approvedDietTemplateIds ?? [],
  });

  const inputSnapshotHash = hashInputSnapshot(snapshot, []);
  const mode = resolveCopilotMode();

  // Disabled mode: never contact any provider. Return the pre-run safety
  // items (which include "missing_*" items produced by an empty snapshot)
  // plus an unavailable envelope. The workspace displays this honestly.
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
    // Post-run: re-run safety on the same snapshot; the model may not weaken
    // safety, and the returned items must remain identical.
    const postSafety = runSafetyCore(snapshot);
    if (safetyItemsSummary(preSafety) !== safetyItemsSummary(postSafety)) {
      // A model-assisted step somehow changed safety. Refuse.
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
    // Validate every emitted citation.
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
    // Never surface the raw error to the client — audit metadata must stay
    // PHI-safe. Log a category, not the message.
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
