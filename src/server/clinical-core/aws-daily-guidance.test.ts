import { describe, expect, it } from "vitest";
import { createAwsDailyGuidanceApiHandler } from "./aws-daily-guidance-api";
import {
  DailyGuidanceError,
  deriveCycleContext,
  safetyEscalation,
  validateDailyGuidanceInput,
  validateDailyGuidanceResult,
  type DailyGuidanceInput,
} from "./aws-daily-guidance";
import { buildDailyGuidanceOpenAIRequest, parseDailyGuidanceOpenAIResponse } from "./aws-daily-guidance-openai";

const ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example";
const AUDIENCE = "72aksm2dm4nf03l8d9nrp2dbh0";
const MODEL = "gpt-5-mini-2026-08-07";

function request(overrides: Partial<DailyGuidanceInput> = {}): DailyGuidanceInput {
  return {
    contractVersion: "daily-guidance/1",
    requestId: "11111111-1111-4111-8111-111111111111",
    date: "2026-08-28",
    measurements: [
      { metric: "hrv_ms", value: 52, unit: "ms", observedAt: "2026-08-28T12:00:00.000Z", source: "apple_health", quality: "measured" },
      { metric: "resting_heart_rate_bpm", value: 61, unit: "bpm", observedAt: "2026-08-28T12:00:00.000Z", source: "apple_health", quality: "measured" },
      { metric: "sleep_duration_minutes", value: 438, unit: "min", observedAt: "2026-08-28T12:00:00.000Z", source: "apple_health", quality: "measured" },
    ],
    baselines: [{ metric: "hrv_ms", value: 55, unit: "ms", windowDays: 14, sampleCount: 8 }],
    symptoms: [],
    reproductiveContext: null,
    ...overrides,
  };
}

function modelValue() {
  return {
    summary: "Your measured recovery signals are close to their recent pattern, so choose an ordinary, symptom-led day.",
    actions: [{
      category: "movement", title: "Let measured recovery guide intensity",
      rationale: "HRV, resting heart rate, and sleep are available; cycle phase alone should not determine training intensity.",
      inputMetrics: ["hrv_ms", "resting_heart_rate_bpm", "sleep_duration_minutes"],
      evidenceIds: ["mc-nulty-2020"],
    }],
    confidence: "moderate",
  };
}

describe("governed daily guidance", () => {
  it("accepts measured-only inputs and returns provenance", () => {
    const parsed = validateDailyGuidanceInput(request());
    const result = validateDailyGuidanceResult({ value: modelValue(), request: parsed, model: MODEL, generatedAt: "2026-08-28T12:30:00.000Z" });
    expect(result.provenance.provider).toBe("openai");
    expect(result.provenance.evidence[0]?.id).toBe("mc-nulty-2020");
    expect(result.missingCoreMetrics).toEqual([]);
  });

  it("refuses hidden defaults, duplicate metrics, implausible values, and fewer than two measured core signals", () => {
    expect(() => validateDailyGuidanceInput({ ...request(), measurements: request().measurements.map((row) => ({ ...row, fallback: 70 })) })).toThrow("request_invalid");
    expect(() => validateDailyGuidanceInput({ ...request(), measurements: [request().measurements[0], request().measurements[0]] })).toThrow("request_invalid");
    expect(() => validateDailyGuidanceInput({ ...request(), measurements: request().measurements.map((row, index) => index ? row : { ...row, value: 9999 }) })).toThrow("request_invalid");
    expect(() => validateDailyGuidanceInput({ ...request(), measurements: [request().measurements[0], { metric: "energy_score", value: 5, unit: "score_0_10", observedAt: "2026-08-28T12:00:00.000Z", source: "manual_checkin", quality: "user_reported" }] })).toThrow("insufficient_measured_data");
  });

  it("requires explicit reproductive consent and suppresses phase inference outside a regular cycle", () => {
    const noConsent = { consent: { status: "revoked", artifactVersion: "reproductive-health-consent/1", acceptedAt: "2026-08-28T12:00:00.000Z" }, stage: "regular_cycle", cycleDay: 8 };
    expect(() => validateDailyGuidanceInput({ ...request(), reproductiveContext: noConsent })).toThrow("reproductive_consent_required");
    const contraception = validateDailyGuidanceInput({ ...request(), reproductiveContext: { consent: { status: "granted", artifactVersion: "reproductive-health-consent/1", acceptedAt: "2026-08-28T12:00:00.000Z" }, stage: "hormonal_contraception" } });
    expect(deriveCycleContext(contraception.reproductiveContext)).toEqual({ stage: "hormonal_contraception", phase: "unknown", phaseConfidence: "none" });
    expect(() => validateDailyGuidanceInput({ ...request(), reproductiveContext: { ...contraception.reproductiveContext, cycleDay: 10 } })).toThrow("request_invalid");
  });

  it("escalates pregnancy and bleeding warning signs without asking the model to decide", () => {
    expect(safetyEscalation(request({ symptoms: ["chest_pain"] })).level).toBe("urgent");
    expect(safetyEscalation(request({ symptoms: ["heavy_bleeding", "dizziness"] })).level).toBe("urgent");
    expect(safetyEscalation(request({ reproductiveContext: { consent: { status: "granted", artifactVersion: "reproductive-health-consent/1", acceptedAt: "2026-08-28T12:00:00.000Z" }, stage: "perimenopause" } })).level).toBe("routine");
  });

  it("refuses uncited metrics, invented evidence, dose language, and treatment changes", () => {
    expect(() => validateDailyGuidanceResult({ value: { ...modelValue(), actions: [{ ...modelValue().actions[0], inputMetrics: ["steps"] }] }, request: request(), model: MODEL })).toThrow("unsafe_output_refused");
    expect(() => validateDailyGuidanceResult({ value: { ...modelValue(), actions: [{ ...modelValue().actions[0], evidenceIds: ["made-up"] }] }, request: request(), model: MODEL })).toThrow("unsafe_output_refused");
    expect(() => validateDailyGuidanceResult({ value: { ...modelValue(), summary: "Increase hormone dose to 20 mg." }, request: request(), model: MODEL })).toThrow("unsafe_output_refused");
  });

  it("builds a non-retained strict-schema OpenAI request and validates the exact model", () => {
    const body = buildDailyGuidanceOpenAIRequest(request(), MODEL);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(() => parseDailyGuidanceOpenAIResponse({ response: { model: "substituted", status: "completed", output: [] }, request: request(), model: MODEL })).toThrow(DailyGuidanceError);
  });

  it("authenticates a synthetic consumer and returns direct-to-consumer guidance", async () => {
    const result = validateDailyGuidanceResult({ value: modelValue(), request: request(), model: MODEL, generatedAt: "2026-08-28T12:30:00.000Z" });
    const handler = createAwsDailyGuidanceApiHandler({
      configuration: { consumerIssuer: ISSUER, consumerAudience: AUDIENCE, runtimeMode: "synthetic", phiAllowed: false, model: MODEL, openAiSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:test-guidance" },
      provider: async () => result,
    });
    const response = await handler({
      routeKey: "POST /clinical-core/consumer/daily-guidance", headers: { "content-type": "application/json" }, body: JSON.stringify(request()),
      requestContext: { authorizer: { jwt: { claims: { iss: ISSUER, aud: AUDIENCE, token_use: "id", sub: "synthetic-user-123", "custom:person_id": "22222222-2222-4222-8222-222222222222", "custom:organization_id": "33333333-3333-4333-8333-333333333333", "custom:synthetic_attested": "true" } } } },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.summary).toContain("measured recovery");
  });
});
