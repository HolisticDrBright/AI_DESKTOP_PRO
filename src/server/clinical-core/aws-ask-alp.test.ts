import { describe, expect, it } from "vitest";
import { createAwsAskAlpApiHandler } from "./aws-ask-alp-api";
import { ASK_ALP_CONTEXT_VERSION, ASK_ALP_CONTRACT_VERSION, AskAlpError, promptSha256, validateAskAlpRequest, validateAskAlpResult } from "./aws-ask-alp";
import { buildAskAlpOpenAIRequest, parseAskAlpOpenAIResponse } from "./aws-ask-alp-openai";

const ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example";
const AUDIENCE = "72aksm2dm4nf03l8d9nrp2dbh0";
const MODEL = "gpt-5-mini-2026-08-07";
const PROMPT = "You are Ask ALP. Explain only supplied consumer health data, preserve uncertainty, do not diagnose, and follow every compiled safety boundary. This exact prompt requires workforce approval before activation.";

function request() {
  return {
    contractVersion: ASK_ALP_CONTRACT_VERSION,
    requestId: "11111111-1111-4111-8111-111111111111",
    systemPromptVersion: "ask-alp/1",
    signedSystemPrompt: PROMPT,
    contextVersion: ASK_ALP_CONTEXT_VERSION,
    context: { profile: { goals: ["Synthetic energy"] }, labs: [], wearables: null },
    userMessage: "What does my current information mean?",
  };
}

function result() {
  return { answer: "Your supplied information includes a synthetic energy goal, but no measured labs or wearable records are present.", confidence: "low" as const, escalationRecommended: false, escalationReason: null };
}

describe("AWS Ask ALP OpenAI boundary", () => {
  it("accepts only the exact approved prompt hash", () => {
    expect(validateAskAlpRequest(request(), promptSha256(PROMPT)).systemPromptVersion).toBe("ask-alp/1");
    expect(() => validateAskAlpRequest({ ...request(), signedSystemPrompt: `${PROMPT} changed` }, promptSha256(PROMPT))).toThrow("prompt_not_approved");
    expect(() => validateAskAlpRequest({ ...request(), hiddenDefault: true }, promptSha256(PROMPT))).toThrow("request_invalid");
  });

  it("builds a stored-false, tool-free, strict-schema request", () => {
    const body = buildAskAlpOpenAIRequest(request(), MODEL);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.max_output_tokens).toBe(1200);
    expect(JSON.stringify(body)).toContain("no more than 800 words");
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(body)).toContain("NON-OVERRIDABLE APPLICATION POLICY");
    expect(JSON.stringify(body)).toContain("Answer the user's exact question first");
    expect(JSON.stringify(body)).toContain("find those markers case-insensitively");
    expect(JSON.stringify(body)).toContain("Do not substitute unrelated markers");
    expect(JSON.stringify(body)).toContain("does not require practitioner approval or escalation");
  });

  it("refuses model substitution and unsafe dose or peptide directives", () => {
    expect(() => validateAskAlpResult({ ...result(), answer: "Increase your hormone dose to 20 mg." }, MODEL)).toThrow("unsafe_output_refused");
    expect(() => validateAskAlpResult({ ...result(), answer: "Buy this peptide from a supplier." }, MODEL)).toThrow("unsafe_output_refused");
    const response = { model: "substituted", status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(result()) }] }] };
    expect(() => parseAskAlpOpenAIResponse(response, MODEL)).toThrow(AskAlpError);
  });

  it("authenticates an attested synthetic consumer", async () => {
    const handler = createAwsAskAlpApiHandler({
      configuration: {
        consumerIssuer: ISSUER, consumerAudience: AUDIENCE, runtimeMode: "synthetic", phiAllowed: false,
        model: MODEL, openAiSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:test-openai",
        approvedPromptSha256: promptSha256(PROMPT),
      },
      provider: async () => ({ ...result(), provider: "openai", model: MODEL }),
    });
    const response = await handler({
      routeKey: "POST /clinical-core/consumer/ask-alp/generate", headers: { "content-type": "application/json" }, body: JSON.stringify(request()),
      requestContext: { authorizer: { jwt: { claims: {
        iss: ISSUER, aud: AUDIENCE, token_use: "id", sub: "synthetic-user-123",
        "custom:person_id": "22222222-2222-4222-8222-222222222222", "custom:organization_id": "33333333-3333-4333-8333-333333333333",
        "custom:synthetic_attested": "true",
      } } } },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.provider).toBe("openai");
  });
});
