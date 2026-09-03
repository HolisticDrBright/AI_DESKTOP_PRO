/**
 * Deterministic fixture provider — TESTS + LOCAL ONLY.
 *
 * The `provider.ts` entrypoint refuses to load this module in a deployed
 * environment. This module is imported dynamically so its bytes never
 * reach a production bundle.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider.fixture is server-only.");
}

import { createHash } from "node:crypto";
import type { CopilotProvider, CopilotDraftOutput, CopilotRunType } from "./provider";

function sha256(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

/**
 * Fixture produces the same output for the same input, and it NEVER
 * invents citations. Every citation it emits must already be in the
 * `allowedCitationIds` set — the caller assembled that set from the
 * governed retrieval layer.
 */
export const fixtureProvider: CopilotProvider = {
  name: "fixture",
  model: "fixture-copilot-v1",
  async draft({ runType, lens, inputSnapshot, allowedCitationIds }) {
    void inputSnapshot;
    const allowedList = Array.from(allowedCitationIds);
    // Fixture content by run type — deliberately structural, no medical
    // claims. Real draft bodies land in Phase 10B behind a real provider.
    const content: Record<string, unknown> = {
      lens,
      producedBy: "fixture-copilot-v1",
      deterministic: true,
      allowedCitations: allowedList,
      runType,
      shape: fixtureShape(runType),
    };
    const citations = allowedList.slice(0, 3).map((refId) => ({
      citationType: "knowledge_reference" as const,
      refId,
      version: null,
    }));
    const output: CopilotDraftOutput = {
      runType,
      content,
      citations,
      contentSha256: sha256(content),
      providerName: "fixture",
      providerModel: "fixture-copilot-v1",
    };
    return output;
  },
};

function fixtureShape(runType: CopilotRunType) {
  switch (runType) {
    case "longitudinal_brief":
      return {
        changed: ["labs", "symptoms", "wearables", "adherence", "protocols", "nutrition", "messages", "encounters"],
        openQuestions: 0,
        safetyItems: 0,
      };
    case "differential_questions":
      return { questions: [] };
    case "lab_suggestions":
      return { labs: [] };
    case "protocol_draft":
      return {
        goals: [],
        phases: [],
        stopConditions: [],
        missingInformation: [],
        interactionReviewStatus: "not_completed",
      };
    case "practitioner_brief":
      return {
        safetyItems: [],
        leadingHypotheses: [],
        supportingEvidence: [],
        conflictingEvidence: [],
        missingInformation: [],
        limitations: [],
      };
  }
}
