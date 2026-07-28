import { describe, expect, it } from "vitest";
import {
  buildInboxAiAssist,
  buildPatientChangeBrief,
} from "./ai-assistance.mock";
import { listThreads } from "./inbox.mock";

describe("AI-aware workflow fixtures", () => {
  it("labels inbox triage as workflow urgency and keeps the response as a draft", () => {
    const thread = listThreads().find((row) => row.id === "th-priya-labs");
    expect(thread).toBeDefined();

    const assist = buildInboxAiAssist(thread!);
    expect(assist.status).toBe("fixture");
    expect(assist.items[0]?.priority).toBe("now");
    expect(assist.items[0]?.why).toContain("not a diagnosis or medical probability");
    expect(assist.safetyNotice).toContain("editable draft");
    expect(assist.safetyNotice).toContain("cannot send");
    expect(assist.suggestedReply).toContain("seek urgent care");
    expect(assist.missingInformation.length).toBeGreaterThan(0);
  });

  it("builds the longitudinal patient brief from named source records", () => {
    const brief = buildPatientChangeBrief("p-78435", "Alexandra Morgan");

    expect(brief.status).toBe("fixture");
    expect(brief.items.length).toBeGreaterThanOrEqual(3);
    expect(brief.sources.some((source) => source.label === "Labs and biomarkers")).toBe(true);
    expect(brief.sources.some((source) => source.label === "Wearable trend")).toBe(true);
    expect(brief.sources.some((source) => source.label === "Active protocol")).toBe(true);
    expect(brief.missingInformation).toContain(
      "Medication, allergy, pregnancy, and outside-care changes still require direct confirmation.",
    );
    expect(brief.safetyNotice).toContain("verify every source");
  });
});
