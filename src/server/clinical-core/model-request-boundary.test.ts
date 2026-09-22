import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildLabSynthesisRequest } from "./aws-lab-openai";
import { buildDraftingRequest, DRAFTING_PROMPT_SHA256 } from "./aws-recording-drafting-openai";

/**
 * Nothing sent to the model vendor may be kept by it for us. Storage is opt-out per request, so `store: false` is not a
 * default to rely on: it is a property every request must carry, and a new call site that forgets it would be silently
 * building a record set on someone else's infrastructure — the one thing the vendor's own terms bar us from doing.
 */
const MODEL_MODULES = () => readdirSync("src/server/clinical-core")
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .filter((entry) => readFileSync(join("src/server/clinical-core", entry), "utf8").includes("api.openai.com"));

describe("every model request refuses vendor-side storage", () => {
  it("is set by the request builders that can be built here", () => {
    const lab = buildLabSynthesisRequest({
      model: "fictional-model-1",
      jobId: "33333333-3333-4333-8333-333333333333",
      biomarkers: [{
        biomarkerId: "11111111-1111-4111-8111-111111111111", canonicalName: "Synthetic Marker", value: 42,
        unit: "mg/dl", labMin: 10, labMax: 50, functionalMin: null, functionalMax: null, status: "normal",
      }],
    });
    expect(lab).toMatchObject({ store: false });

    const drafting = buildDraftingRequest({
      model: "fictional-model-1", promptSha256: DRAFTING_PROMPT_SHA256, noteType: "soap",
      jobId: "22222222-2222-4222-8222-222222222222",
      sections: [{ key: "S", label: "Subjective" }, { key: "O", label: "Objective" }, { key: "A", label: "Assessment" }, { key: "P", label: "Plan" }],
      transcript: "Fictional transcript.",
    });
    expect(drafting).toMatchObject({ store: false });
  });

  it("is set by every module that posts to the vendor, and none asks for the opposite", () => {
    const modules = MODEL_MODULES();
    // The ask-alp and daily-guidance builders need a whole generation request to call; the property is read from source
    // for those, which is also what catches a call site added later.
    expect(modules.length).toBeGreaterThanOrEqual(4);
    for (const entry of modules) {
      const source = readFileSync(join("src/server/clinical-core", entry), "utf8");
      expect(source, `${entry} must set store: false on its request`).toMatch(/store:\s*false/);
      expect(source, `${entry} must not ask the vendor to store anything`).not.toMatch(/store:\s*true/);
    }
  });
});
