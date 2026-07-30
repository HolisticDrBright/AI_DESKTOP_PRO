import { describe, expect, it } from "vitest";
import {
  buildInboxAiAssist,
  buildPatientChangeBrief,
} from "./ai-assistance.mock";
import { listThreads } from "./inbox.mock";

/**
 * In the clinical-only repository, the mode-aware gate inside the fixture
 * module is the invariant worth pinning: with no approved production provider
 * configured, every AI-assist brief must come back `not-configured`, with NO
 * fabricated items or sources — never the demo fixture content. (The fixture
 * behavior itself now lives, and is tested, in AI-DESKTOP-PRO-DEMO.)
 */
describe("AI assistance in the clinical runtime", () => {
  it("inbox triage reports not-configured with no fabricated content", () => {
    const thread = listThreads().find((row) => row.id === "th-priya-labs");
    expect(thread).toBeDefined();

    const assist = buildInboxAiAssist(thread!);
    expect(assist.status).toBe("not-configured");
    expect(assist.providerLabel).toBe("Not configured");
    expect(assist.items).toHaveLength(0);
    expect(assist.sources).toHaveLength(0);
    expect(assist.summary).toContain("disabled in live mode");
    // The reply is a safe generic acknowledgement, not a clinical draft.
    expect(assist.suggestedReply).not.toContain("seek urgent care");
  });

  it("the patient change brief reports not-configured and invents nothing", () => {
    const brief = buildPatientChangeBrief("p-78435", "Alexandra Morgan");

    expect(brief.status).toBe("not-configured");
    expect(brief.items).toHaveLength(0);
    expect(brief.sources).toHaveLength(0);
    expect(brief.missingInformation).toHaveLength(0);
  });
});
