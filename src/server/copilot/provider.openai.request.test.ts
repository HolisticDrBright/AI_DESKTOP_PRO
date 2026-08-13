import { describe, expect, test } from "vitest";
import { buildEmptySnapshot } from "./input-builder";
import { assembleRetrieval } from "./retrieval";
import { buildMinimizedEnvelope } from "./data-minimizer";
import {
  buildOpenAIRequest,
  hashProviderBodyForAudit,
  parseAndValidateOpenAIResponse,
} from "./provider.openai.request";

function baseEnvelope() {
  return buildMinimizedEnvelope({
    runType: "practitioner_brief",
    lens: "western",
    ruleSetVersion: "v1",
    promptVersion: "v1",
    outputSchemaVersion: "v1",
    snapshot: buildEmptySnapshot().snapshot,
    retrieval: assembleRetrieval({
      approvedKnowledgeReferenceIds: ["kr-a"],
      verifiedLabelIds: [],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    }),
  });
}

describe("OpenAI request builder", () => {
  test("emits deterministic body with model + envelope_sha256", () => {
    const env = baseEnvelope();
    const req = buildOpenAIRequest({
      envelope: env,
      model: "gpt-4o-2024-08-06",
      apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
      organizationHeader: "org-1",
      projectHeader: "proj-1",
    });
    expect(req.method).toBe("POST");
    expect(req.endpoint.protocol).toBe("https:");
    expect(req.endpoint.host).toBe("api.openai.com");
    expect(req.headers["Authorization"]).toBe("Bearer TEST_FAKE_BEARER_abcdefghijklmnop1234");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers["OpenAI-Organization"]).toBe("org-1");
    expect(req.headers["OpenAI-Project"]).toBe("proj-1");
    expect(req.body.model).toBe("gpt-4o-2024-08-06");
    expect(req.body.response_format.json_schema.strict).toBe(true);
    expect(req.body.temperature).toBe(0);
    expect(req.body.metadata.envelope_sha256).toBe(env.envelopeSha256);
  });

  test("refuses non-https endpoint", () => {
    expect(() =>
      buildOpenAIRequest({
        envelope: baseEnvelope(),
        model: "gpt-4o-2024-08-06",
        apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
        organizationHeader: null,
        projectHeader: null,
        endpoint: new URL("http://insecure.example.com/v1/responses"),
      }),
    ).toThrow(/https/i);
  });

  test("refuses too-short key shape", () => {
    expect(() =>
      buildOpenAIRequest({
        envelope: baseEnvelope(),
        model: "gpt-4o-2024-08-06",
        apiKey: "short",
        organizationHeader: null,
        projectHeader: null,
      }),
    ).toThrow(/key_shape/);
  });

  test("body never carries commercial fields even if snapshot had them", () => {
    const s = buildEmptySnapshot().snapshot;
    (s as Record<string, unknown>).affiliateUrl = "https://aff/x";
    (s as Record<string, unknown>).discountCode = "PROMO";
    (s as Record<string, unknown>).price = 99;
    const env = buildMinimizedEnvelope({
      runType: "practitioner_brief",
      lens: "western",
      ruleSetVersion: "v1",
      promptVersion: "v1",
      outputSchemaVersion: "v1",
      snapshot: s,
      retrieval: assembleRetrieval({
        approvedKnowledgeReferenceIds: [],
        verifiedLabelIds: [],
        approvedProtocolTemplateIds: [],
        approvedDietTemplateIds: [],
      }),
    });
    const req = buildOpenAIRequest({
      envelope: env,
      model: "gpt-4o-2024-08-06",
      apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
      organizationHeader: null,
      projectHeader: null,
    });
    // Assert that the LITERAL smuggled test values do not appear in the
    // request body. (The system instruction legitimately says the word
    // "prices" and "affiliate" to instruct the model NOT to include them.)
    const json = JSON.stringify(req.body);
    for (const smuggled of ["https://aff/x", "PROMO", "99", "affiliateUrl", "discountCode"]) {
      expect(json, `body must not carry ${smuggled}`).not.toContain(smuggled);
    }
  });
});

describe("OpenAI response validator", () => {
  const allowed = new Set(["kr-a", "kr-b"]);
  function goodWrapper(text: string) {
    return {
      id: "resp_abc123",
      model: "gpt-4o-2024-08-06",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    };
  }
  const goodInner = JSON.stringify({
    run_type: "practitioner_brief",
    content: { summary: "Draft summary." },
    citations: [{ citationType: "knowledge_reference", refId: "kr-a", version: null }],
  });

  test("valid response parses", () => {
    const parsed = parseAndValidateOpenAIResponse({
      raw: goodWrapper(goodInner),
      allowedCitationIds: allowed,
      expectedModelPrefix: "gpt",
    });
    expect(parsed.content.summary).toBe("Draft summary.");
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("model prefix mismatch refuses", () => {
    expect(() =>
      parseAndValidateOpenAIResponse({
        raw: goodWrapper(goodInner),
        allowedCitationIds: allowed,
        expectedModelPrefix: "claude",
      }),
    ).toThrow(/malformed/);
  });

  test("unknown top-level field refuses", () => {
    const inner = JSON.stringify({
      run_type: "practitioner_brief",
      content: { summary: "x" },
      citations: [],
      injected_field: "attack",
    });
    expect(() =>
      parseAndValidateOpenAIResponse({
        raw: goodWrapper(inner),
        allowedCitationIds: allowed,
      }),
    ).toThrow(/malformed/);
  });

  test("citation not in allowed set → hallucinated_citation", () => {
    const inner = JSON.stringify({
      run_type: "practitioner_brief",
      content: { summary: "x" },
      citations: [{ citationType: "knowledge_reference", refId: "kr-hallucinated" }],
    });
    expect(() =>
      parseAndValidateOpenAIResponse({
        raw: goodWrapper(inner),
        allowedCitationIds: allowed,
      }),
    ).toThrow(/hallucinated/);
  });

  test("summary >4000 chars refuses", () => {
    const inner = JSON.stringify({
      run_type: "practitioner_brief",
      content: { summary: "x".repeat(4001) },
      citations: [],
    });
    expect(() =>
      parseAndValidateOpenAIResponse({
        raw: goodWrapper(inner),
        allowedCitationIds: allowed,
      }),
    ).toThrow(/malformed/);
  });

  test("bad citationType refuses", () => {
    const inner = JSON.stringify({
      run_type: "practitioner_brief",
      content: { summary: "x" },
      citations: [{ citationType: "advertisement", refId: "kr-a" }],
    });
    expect(() =>
      parseAndValidateOpenAIResponse({
        raw: goodWrapper(inner),
        allowedCitationIds: allowed,
      }),
    ).toThrow(/malformed/);
  });

  test("hashProviderBodyForAudit returns sha256 hex", () => {
    expect(hashProviderBodyForAudit("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});
