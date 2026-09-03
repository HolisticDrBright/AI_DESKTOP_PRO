import { describe, expect, test } from "vitest";
import { buildLabSynthesisRequest, parseLabSynthesisResponse, parseOpenAISecret } from "./aws-lab-openai";

const marker = {
  biomarkerId: "11111111-1111-4111-8111-111111111111",
  canonicalName: "Synthetic Marker",
  value: 42,
  unit: "mg/dl",
  labMin: 10,
  labMax: 50,
  functionalMin: null,
  functionalMax: null,
  status: "normal",
};

function response(content: Record<string, unknown>, model = "gpt-5.1-2025-11-13") {
  return { model, status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(content) }] }] };
}

const planImpact = {
  headline: "Review the current plan against the new trend.",
  changes: [{
    kind: "reassess", label: "Synthetic support item", rationale: "The repeated marker changed and warrants review.",
    biomarkerIds: [marker.biomarkerId], protocolItemIds: [],
  }],
};

const generatedPlan = {
  title: "Synthetic lab and symptom plan",
  summary: "A measured-data plan for the current synthetic result.",
  confidence: "medium",
  tasks: [{
    kind: "nutrition", name: "Build a balanced breakfast", frequency: "Daily", timing: "Morning",
    rationale: "Supports the pattern represented by the supplied marker.",
    biomarkerIds: [marker.biomarkerId], symptomCategoryIds: [],
  }],
};

describe("AWS lab OpenAI boundary", () => {
  test("accepts the configured JSON secret shapes without exposing the bearer", () => {
    const key = `sk-${"x".repeat(40)}`;
    expect(parseOpenAISecret(JSON.stringify({ OPENAI_API_KEY: key }))).toBe(key);
    expect(parseOpenAISecret(JSON.stringify({ "ai-longevity-pro/synthetic-staging/openai": key }))).toBe(key);
    expect(() => parseOpenAISecret(JSON.stringify({ OPENAI_API_KEY: key, unexpected: true }))).toThrow("openai_secret_malformed");
  });

  test("builds a stored-false, tool-free structured Responses request", () => {
    const body = buildLabSynthesisRequest({
      model: "gpt-5.1-2025-11-13", biomarkers: [marker], jobId: "job",
      patientContext: {
        ageYears: 41, sex: "female", pregnancyStatus: "unsure", nursing: false,
        mainComplaint: "Synthetic fatigue", complaintDuration: "6 months", complaintSeverity: 7,
        conditions: [], medications: ["Synthetic medication"], allergies: [], topSymptomSignals: [],
        lifestyle: { sleepHours: 6.5, sleepQuality: 5, stressLevel: 7, dietType: "omnivore", exerciseFrequency: 2 },
      },
      activeProtocol: { protocolId: "protocol-1", protocolName: "Synthetic plan", version: 1, items: [{ itemId: "item-1", kind: "supplement", name: "Synthetic support item" }] },
    });
    expect(body).toMatchObject({ model: "gpt-5.1-2025-11-13", store: false, reasoning: { effort: "none" }, max_output_tokens: 6000 });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("background");
    expect(JSON.stringify(body)).not.toMatch(/affiliate_url|commercial_link|patient_name/i);
    expect(JSON.stringify(body)).toContain("Synthetic fatigue");
    expect(JSON.stringify(body)).not.toMatch(/firstName|lastName|email|dateOfBirth/);
    expect(body.text.format.schema.properties.summary.maxLength).toBe(4000);
    expect(body.text.format.schema.properties.priorityActions.maxItems).toBe(8);
    expect(body.text.format.schema.properties.referencedBiomarkerIds.maxItems).toBe(40);
    expect(body.text.format.schema.properties.planImpact.properties.changes.maxItems).toBe(20);
    expect(body.text.format.schema.properties.generatedPlan.properties.tasks.maxItems).toBe(8);
  });

  test("accepts a bounded synthesis that references only supplied markers", () => {
    const parsed = parseLabSynthesisResponse({
      response: response({
        summary: "The supplied marker is within its reporting laboratory range.",
        uncertainty: "A single marker cannot establish a diagnosis or whole-system pattern.",
        priorityActions: ["Discuss the result in the context of symptoms and prior trends."],
        referencedBiomarkerIds: [marker.biomarkerId],
        longitudinalSummary: "Only one comparable observation is available.",
        planImpact,
        generatedPlan,
      }),
      expectedModel: "gpt-5.1-2025-11-13",
      allowedBiomarkerIds: new Set([marker.biomarkerId]),
      allowedProtocolItemIds: new Set(["item-1"]),
    });
    expect(parsed.providerModel).toBe("gpt-5.1-2025-11-13");
  });

  test("refuses substituted models, hallucinated ids, and treatment directives", () => {
    const valid = {
      summary: "Review the supplied result.", uncertainty: "Context is limited.",
      priorityActions: ["Discuss this marker with a practitioner."], referencedBiomarkerIds: [marker.biomarkerId],
      longitudinalSummary: "Only one comparable observation is available.", planImpact,
      generatedPlan,
    };
    expect(() => parseLabSynthesisResponse({ response: response(valid, "another-model"), expectedModel: "gpt-5.1-2025-11-13", allowedBiomarkerIds: new Set([marker.biomarkerId]) })).toThrow("openai_model_substitution_refused");
    expect(() => parseLabSynthesisResponse({ response: { ...response(valid), status: "incomplete" }, expectedModel: "gpt-5.1-2025-11-13", allowedBiomarkerIds: new Set([marker.biomarkerId]) })).toThrow("openai_response_incomplete");
    expect(() => parseLabSynthesisResponse({ response: response({ ...valid, referencedBiomarkerIds: ["unknown"] }), expectedModel: "gpt-5.1-2025-11-13", allowedBiomarkerIds: new Set([marker.biomarkerId]) })).toThrow("openai_unknown_biomarker_reference_refused");
    expect(() => parseLabSynthesisResponse({ response: response({ ...valid, priorityActions: ["Take 500 mg daily."] }), expectedModel: "gpt-5.1-2025-11-13", allowedBiomarkerIds: new Set([marker.biomarkerId]) })).toThrow("openai_dose_directive_refused");
    expect(() => parseLabSynthesisResponse({ response: response({ ...valid, summary: "Glucose is 104 mg/dL." }), expectedModel: "gpt-5.1-2025-11-13", allowedBiomarkerIds: new Set([marker.biomarkerId]) })).not.toThrow();
    const unknownPlanItem = { ...valid, planImpact: { ...planImpact, changes: [{ ...planImpact.changes[0], protocolItemIds: ["unknown-item"] }] } };
    expect(() => parseLabSynthesisResponse({ response: response(unknownPlanItem), expectedModel: "gpt-5.1-2025-11-13", allowedBiomarkerIds: new Set([marker.biomarkerId]), allowedProtocolItemIds: new Set() })).toThrow("openai_unknown_biomarker_reference_refused");
  });
});
