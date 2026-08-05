import { describe, expect, test } from "vitest";
import { buildEmptySnapshot } from "./input-builder";
import { assembleRetrieval } from "./retrieval";
import { buildMinimizedEnvelope } from "./data-minimizer";
import {
  assertNoToolSurface,
  buildOpenAIRequest,
  FORBIDDEN_REQUEST_FIELDS,
  hashProviderBodyForAudit,
  parseAndValidateOpenAIResponse,
  REQUEST_CONTRACT_VERSION,
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
      model: "gpt-5.6-sol",
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
    expect(req.body.model).toBe("gpt-5.6-sol");
    // Responses API structured output lives at `text.format`, not at the
    // Chat Completions `response_format`.
    expect(req.body.text.format.type).toBe("json_schema");
    expect(req.body.text.format.strict).toBe(true);
    expect(req.body.text.format.name).toBe("copilot_output_v1");
    expect(req.body).not.toHaveProperty("response_format");
    // Never persisted provider-side.
    expect(req.body.store).toBe(false);
    // A reasoning-family model takes `effort`, not `temperature`. Sending
    // an unsupported sampling parameter is a 400 that would abort the run.
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body.reasoning).toEqual({ effort: "low" });
    expect(req.body.metadata.envelope_sha256).toBe(env.envelopeSha256);
    expect(req.body.metadata.request_contract_version).toBe(REQUEST_CONTRACT_VERSION);
  });

  test("no tool, retrieval, or persistence surface is present on the body", () => {
    const req = buildOpenAIRequest({
      envelope: baseEnvelope(),
      model: "gpt-5.6-sol",
      apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
      organizationHeader: null,
      projectHeader: null,
    });
    // Absent rather than disabled: a field that is never written cannot be
    // switched on by configuration.
    expect(() => assertNoToolSurface(req.body as unknown as Record<string, unknown>)).not.toThrow();
    for (const field of FORBIDDEN_REQUEST_FIELDS) {
      expect(req.body, `${field} must be absent`).not.toHaveProperty(field);
    }
  });

  test("assertNoToolSurface catches a body that grew a tool or lost store:false", () => {
    const req = buildOpenAIRequest({
      envelope: baseEnvelope(),
      model: "gpt-5.6-sol",
      apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
      organizationHeader: null,
      projectHeader: null,
    });
    const withTool = { ...(req.body as unknown as Record<string, unknown>), tools: [] };
    expect(() => assertNoToolSurface(withTool)).toThrow(/forbidden_request_field:tools/);
    const stored = { ...(req.body as unknown as Record<string, unknown>), store: true };
    expect(() => assertNoToolSurface(stored)).toThrow(/store_must_be_false/);
  });

  test("a floating alias is refused before a request can be built", () => {
    for (const alias of ["gpt-5.6", "gpt-4o", "chatgpt-4o-latest", "latest"]) {
      expect(() =>
        buildOpenAIRequest({
          envelope: baseEnvelope(),
          model: alias,
          apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
          organizationHeader: null,
          projectHeader: null,
        }),
        `${alias} must be refused`,
      ).toThrow(/floating_alias|not_on_allowlist/);
    }
  });

  test("the system instruction states the untrusted-data boundary", () => {
    const req = buildOpenAIRequest({
      envelope: baseEnvelope(),
      model: "gpt-5.6-sol",
      apiKey: "TEST_FAKE_BEARER_abcdefghijklmnop1234",
      organizationHeader: null,
      projectHeader: null,
    });
    const system = req.body.input[0]!.content;
    expect(system).toMatch(/DATA, not instructions/);
    expect(system).toMatch(/never as a directive to follow/);
  });

  test("refuses non-https endpoint", () => {
    expect(() =>
      buildOpenAIRequest({
        envelope: baseEnvelope(),
        model: "gpt-5.6-sol",
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
        model: "gpt-5.6-sol",
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
      model: "gpt-5.6-sol",
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
      model: "gpt-5.6-sol",
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
      expectedModel: "gpt-5.6-sol",
    });
    expect(parsed.content.summary).toBe("Draft summary.");
    expect(parsed.citations).toHaveLength(1);
    expect(parsed.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an exact-model mismatch refuses — a substituted model is not accepted", () => {
    expect(() =>
      parseAndValidateOpenAIResponse({
        raw: goodWrapper(goodInner),
        allowedCitationIds: allowed,
        expectedModel: "gpt-5.6-sol-other",
      }),
    ).toThrow(/model_substituted/);
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
