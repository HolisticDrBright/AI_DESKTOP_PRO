import { describe, expect, it } from "vitest";
import { createAwsAskAlpApiHandler, parseAskAlpRuntimeMode } from "./aws-ask-alp-api";
import { ASK_ALP_CONTEXT_VERSION, ASK_ALP_CONTRACT_VERSION, AskAlpError, promptSha256, validateAskAlpRequest, validateAskAlpResult, type AskAlpGenerationRequest } from "./aws-ask-alp";
import { buildAskAlpOpenAIRequest, parseAskAlpOpenAIResponse } from "./aws-ask-alp-openai";
import { OwnedStorageError } from "./owned-consumer-records";
import { CoreSubscriptionError } from "./core-subscription-guard";
import { ASK_ALP_PRIVATE_ROUTE, PrivateAskAlpCallerError, verifyPrivateAskAlpCaller } from "./aws-ask-alp-private-caller";
import type { ApiGatewayV2Event } from "./aws-identity-api";

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

function productionEvent(body: unknown = request()) {
  const now = Math.floor(Date.now() / 1000);
  return {
    routeKey: ASK_ALP_PRIVATE_ROUTE, headers: { "content-type": "application/json", authorization: "AWS4-HMAC-SHA256 test" }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: {
      iss: ISSUER, aud: AUDIENCE, token_use: "id", sub: "production-user-123", email_verified: "true",
      exp: String(now + 3600), iat: String(now - 60),
      "custom:person_id": "22222222-2222-4222-8222-222222222222", "custom:organization_id": "33333333-3333-4333-8333-333333333333",
      "custom:production_bound": "true",
    } } } },
  };
}

async function mockTrustedCaller(event: ApiGatewayV2Event) {
  return { claims: event.requestContext?.authorizer?.jwt?.claims ?? {}, consumerAuthorization: `Bearer ${"x".repeat(64)}` };
}

function productionConfiguration() {
  return {
    consumerIssuer: ISSUER, consumerAudience: AUDIENCE, runtimeMode: "production" as const, phiAllowed: true,
    productionActivation: { status: "approved" as const, evidenceSha256: "a".repeat(64) },
    model: MODEL, openAiSecretArn: "arn:aws:secretsmanager:us-east-2:173535830222:secret:test-openai",
    approvedPromptSha256: promptSha256(PROMPT),
  };
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
    expect(JSON.stringify(body)).toContain("personalPlan is consumer-saved, unverified history");
    expect(JSON.stringify(body)).toContain("Payment or practitioner access is never evidence of clinical approval");
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

  it("refuses production generation until context comes from a trusted server snapshot", async () => {
    let providerCalls = 0;
    const handler = createAwsAskAlpApiHandler({
      configuration: productionConfiguration(),
      provider: async () => { providerCalls += 1; return { ...result(), provider: "openai", model: MODEL }; },
    });
    const response = await handler(productionEvent());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "trusted_context_not_configured" });
    expect(providerCalls).toBe(0);
  });

  it("replaces forged caller context with the owner-scoped server snapshot", async () => {
    const seen: AskAlpGenerationRequest[] = [];
    let rechecks = 0;
    const handler = createAwsAskAlpApiHandler({
      configuration: productionConfiguration(),
      coreGuard: async () => undefined,
      trustedCallerVerifier: mockTrustedCaller,
      trustedContextLoader: async (identity) => {
        expect(identity.actorPersonId).toBe("22222222-2222-4222-8222-222222222222");
        expect(identity.organizationId).toBe("33333333-3333-4333-8333-333333333333");
        return { context: { labs: [{ name: "Owned ferritin", value: 112, unit: "ng/mL", drawnAt: "2026-10-01T00:00:00.000Z", conventionalRange: null, functionalRange: null, sourceStatus: "consumer_import_unverified" }] }, assertCurrent: async () => { rechecks += 1; } };
      },
      provider: async (value) => { seen.push(value); return { ...result(), provider: "openai", model: MODEL }; },
    });
    const forged = { ...request(), context: { labs: [{ name: "Forged ferritin", value: 1 }] } };
    const response = await handler(productionEvent(forged));
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0]!.context)).toContain("Owned ferritin");
    expect(JSON.stringify(seen[0]!.context)).not.toContain("Forged ferritin");
    expect(rechecks).toBe(1);
  });

  it("withholds a generated answer when consent changes before delivery", async () => {
    let providerCalls = 0;
    const handler = createAwsAskAlpApiHandler({
      configuration: productionConfiguration(), coreGuard: async () => undefined,
      trustedCallerVerifier: mockTrustedCaller,
      trustedContextLoader: async () => ({ context: { labs: [] }, assertCurrent: async () => { throw new OwnedStorageError("consent_required"); } }),
      provider: async () => { providerCalls += 1; return { ...result(), provider: "openai", model: MODEL }; },
    });
    const response = await handler(productionEvent());
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "consent_required" });
    expect(providerCalls).toBe(1);
  });

  it("refuses a token without current owner claims before loading any context", async () => {
    let loads = 0;
    const handler = createAwsAskAlpApiHandler({
      configuration: productionConfiguration(), coreGuard: async () => undefined,
      trustedCallerVerifier: mockTrustedCaller,
      trustedContextLoader: async () => { loads += 1; throw new Error("must not load"); },
      provider: async () => { throw new Error("must not call provider"); },
    });
    const event = productionEvent();
    event.requestContext.authorizer.jwt.claims.exp = "1";
    const response = await handler(event);
    expect(response.statusCode).toBe(403);
    expect(loads).toBe(0);
  });

  it("does not load context or invoke the provider when Core access fails", async () => {
    let loads = 0;
    const handler = createAwsAskAlpApiHandler({
      configuration: productionConfiguration(), coreGuard: async () => { throw new CoreSubscriptionError(); },
      trustedCallerVerifier: mockTrustedCaller,
      trustedContextLoader: async () => { loads += 1; throw new Error("must not load"); },
      provider: async () => { throw new Error("must not call provider"); },
    });
    expect((await handler(productionEvent())).statusCode).toBe(402);
    expect(loads).toBe(0);
  });

  it("rejects production configuration without an activation digest field", () => {
    expect(() => createAwsAskAlpApiHandler({ configuration: { ...productionConfiguration(), productionActivation: undefined } })).toThrow("ask_alp_configuration_invalid");
  });

  it("does not expose production generation without a trusted backend-caller verifier", async () => {
    let providerCalls = 0;
    const handler = createAwsAskAlpApiHandler({
      configuration: productionConfiguration(), coreGuard: async () => undefined,
      trustedContextLoader: async () => ({ context: { labs: [] }, assertCurrent: async () => undefined }),
      provider: async () => { providerCalls += 1; return { ...result(), provider: "openai", model: MODEL }; },
    });
    const response = await handler(productionEvent());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "trusted_caller_not_configured" });
    expect(providerCalls).toBe(0);
  });

  it("never exposes production generation on the public JWT route", async () => {
    const handler = createAwsAskAlpApiHandler({ configuration: productionConfiguration(), trustedCallerVerifier: mockTrustedCaller,
      trustedContextLoader: async () => { throw new Error("must not load"); }, coreGuard: async () => { throw new Error("must not check"); },
      provider: async () => { throw new Error("must not generate"); } });
    const response = await handler({ ...productionEvent(), routeKey: "POST /clinical-core/consumer/ask-alp/generate" });
    expect(response.statusCode).toBe(404);
  });

  it("does not load clinical context or call OpenAI when private caller verification fails", async () => {
    let contextLoads = 0, providerCalls = 0;
    const handler = createAwsAskAlpApiHandler({ configuration: productionConfiguration(),
      trustedCallerVerifier: async () => { throw new PrivateAskAlpCallerError(); },
      trustedContextLoader: async () => { contextLoads += 1; throw new Error("must not load"); },
      coreGuard: async () => { throw new Error("must not check entitlement"); },
      provider: async () => { providerCalls += 1; throw new Error("must not generate"); } });
    const response = await handler(productionEvent());
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "trusted_caller_refused" });
    expect(contextLoads).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("uses verified IAM and Cognito claims, never forged gateway JWT claims, in the production handler", async () => {
    const token = `${"a".repeat(12)}.${"b".repeat(48)}.${"c".repeat(16)}`;
    const event = productionEvent() as ApiGatewayV2Event;
    event.headers!["x-alp-consumer-id-token"] = token;
    event.requestContext!.apiId = "abcdefghij";
    event.requestContext!.accountId = "173535830222";
    event.requestContext!.authorizer!.iam = { accountId: "173535830222",
      userArn: "arn:aws:sts::173535830222:assumed-role/alp-v2-production-api/fictional-ecs-task" };
    event.requestContext!.authorizer!.jwt!.claims!["custom:person_id"] = "44444444-4444-4444-8444-444444444444";
    const verifiedClaims = { ...productionEvent().requestContext.authorizer.jwt.claims };
    let seenPerson = "";
    const handler = createAwsAskAlpApiHandler({ configuration: productionConfiguration(),
      trustedCallerVerifier: candidate => verifyPrivateAskAlpCaller(candidate, {
        apiId: "abcdefghij", accountId: "173535830222",
        backendRoleArn: "arn:aws:iam::173535830222:role/alp-v2-production-api",
        consumerIssuer: ISSUER, consumerAudience: AUDIENCE,
      }, async () => verifiedClaims),
      coreGuard: async input => { expect(input.authorization).toBe(`Bearer ${token}`); },
      trustedContextLoader: async identity => { seenPerson = identity.actorPersonId;
        return { context: { labs: [] }, assertCurrent: async () => undefined }; },
      provider: async () => ({ ...result(), provider: "openai", model: MODEL }),
    });
    expect((await handler(event)).statusCode).toBe(200);
    expect(seenPerson).toBe("22222222-2222-4222-8222-222222222222");
    event.requestContext!.authorizer!.iam!.userArn = "arn:aws:sts::173535830222:assumed-role/other/task";
    expect((await handler(event)).statusCode).toBe(403);
  });

  it("refuses misspelled runtime modes instead of treating them as synthetic", () => {
    expect(parseAskAlpRuntimeMode("synthetic")).toBe("synthetic");
    expect(parseAskAlpRuntimeMode("production")).toBe("production");
    expect(() => parseAskAlpRuntimeMode("prodution")).toThrow("ask_alp_configuration_invalid");
  });
});
