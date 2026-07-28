import { beforeEach, describe, expect, it } from "vitest";
import {
  approveKnowledgeVersion,
  duplicateKnowledgeVersion,
  getApprovedPathway,
  getKnowledgePathways,
  resetKnowledgeDemo,
  updateKnowledgeDraft,
} from "./clinical-knowledge.mock";
import { evaluateClinicalCopilot, type CopilotPatientSession } from "./clinical-copilot.mock";

beforeEach(() => resetKnowledgeDemo());

describe("clinical knowledge registry", () => {
  it("resolves exactly one approved version for every governed concern", () => {
    for (const pathway of getKnowledgePathways()) {
      const approved = pathway.versions.filter((version) => version.status === "approved");
      expect(approved).toHaveLength(1);
      expect(getApprovedPathway(pathway.code)?.version.id).toBe(approved[0]?.id);
    }
  });

  it("creates a new draft without changing the approved copilot version", () => {
    const pathway = getKnowledgePathways()[0]!;
    const approvedBefore = getApprovedPathway(pathway.code)!.version.id;
    duplicateKnowledgeVersion(pathway.id);
    const updated = getKnowledgePathways().find((item) => item.id === pathway.id)!;
    const draft = updated.versions.find((version) => version.status === "draft")!;

    updateKnowledgeDraft(pathway.id, draft.id, {
      changeSummary: "Add a distinguishing medication-timing question",
      content: {
        ...draft.content,
        differentiatingQuestions: [...draft.content.differentiatingQuestions, "When is thyroid medication taken?"],
      },
    });

    expect(getApprovedPathway(pathway.code)!.version.id).toBe(approvedBefore);
    expect(getKnowledgePathways().find((item) => item.id === pathway.id)!
      .versions.find((version) => version.id === draft.id)!
      .content.differentiatingQuestions).toContain("When is thyroid medication taken?");
  });

  it("approval supersedes the old version and moves copilot to the new immutable snapshot", () => {
    const pathway = getKnowledgePathways()[0]!;
    duplicateKnowledgeVersion(pathway.id);
    const draft = getKnowledgePathways().find((item) => item.id === pathway.id)!
      .versions.find((version) => version.status === "draft")!;
    approveKnowledgeVersion(pathway.id, draft.id);

    const current = getApprovedPathway(pathway.code)!;
    expect(current.version.id).toBe(draft.id);
    expect(current.pathway.versions.filter((version) => version.status === "approved")).toHaveLength(1);
    expect(current.pathway.versions.some((version) => version.status === "superseded")).toBe(true);

    const session: CopilotPatientSession = {
      concern: "thyroid",
      symptoms: ["Fatigue"],
      answers: {
        "urgent-red-flags": "no",
        "medications-confirmed": "yes",
        "allergies-confirmed": "yes",
        "pregnancy-status": "no",
        "thyroid-antibodies": "no",
        "thyroid-medication": "no",
      },
      reviewed: false,
      verifiedProductIds: [],
    };
    expect(evaluateClinicalCopilot("patient-1", "Test Patient", session).knowledgeVersion)
      .toContain(`/v${draft.version}`);
  });
});
