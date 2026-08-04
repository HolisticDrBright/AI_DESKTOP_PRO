import { describe, expect, test } from "vitest";
import { CopilotUnavailable } from "./provider";
import { buildEmptySnapshot } from "./input-builder";
import { assembleRetrieval } from "./retrieval";
import { buildMinimizedEnvelope } from "./data-minimizer";
import { SecretResolver, type SecretsManagerClient } from "./secrets";
import type { Transport, TransportRequest, TransportResponse } from "./http-transport";
import { createOpenAIAdapter, type OpenAIProviderApproval } from "./provider.openai";

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-hipaa-live";

function approval(over: Partial<OpenAIProviderApproval> = {}): OpenAIProviderApproval {
  return {
    providerName: "openai",
    providerKind: "openai_hipaa",
    approvedModelAllowlist: ["gpt-4o-2024-08-06"],
    approvalReference: "REF-1",
    baaStatusReference: "BAA-1",
    retentionMode: "modified",
    processingRegion: "us-east-1",
    keyOwnership: "platform_governed",
    activationDate: null,
    expirationDate: null,
    revocationState: "not_revoked",
    orgActivationState: "approved_for_synthetic",
    containsPHI: false,
    organizationId: "org-1",
    providerRegistryId: "prov-1",
    providerSecretRef: ARN,
    organizationHeader: null,
    projectHeader: null,
    ...over,
  };
}

function fakeSecrets(): SecretsManagerClient {
  return {
    async getSecret() {
      return { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" };
    },
  };
}

function fakeTransport(response: TransportResponse): Transport {
  return {
    kind: "fake",
    async send(_req: TransportRequest): Promise<TransportResponse> {
      return response;
    },
  };
}

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

const validResponseBody = JSON.stringify({
  id: "resp_abc123",
  model: "gpt-4o-2024-08-06",
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            run_type: "practitioner_brief",
            content: { summary: "Draft output." },
            citations: [{ citationType: "knowledge_reference", refId: "kr-a", version: null }],
          }),
        },
      ],
    },
  ],
});

describe("OpenAI adapter — integration path via injected transport", () => {
  test("valid approval + envelope + secret + transport succeeds", async () => {
    const env = baseEnvelope();
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      envelope: env,
      secretResolver: new SecretResolver({ client: fakeSecrets() }),
      transport: fakeTransport({ status: 200, statusText: "OK", headers: {}, bodyText: validResponseBody }),
    });
    const out = await adapter.draft({
      runType: "practitioner_brief",
      lens: "western",
      inputSnapshot: {},
      allowedCitationIds: new Set(["kr-a"]),
    });
    expect(out.content.summary).toBe("Draft output.");
    expect(out.citations.map((c) => c.refId)).toEqual(["kr-a"]);
    expect(out.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("envelope missing → refuses without secret resolution", async () => {
    let secretCalls = 0;
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      secretResolver: new SecretResolver({
        client: {
          async getSecret() {
            secretCalls += 1;
            return { secretString: "TEST_FAKE_BEARER_abcdefghijklmnop1234", versionId: "v1" };
          },
        },
      }),
      transport: fakeTransport({ status: 200, statusText: "OK", headers: {}, bodyText: validResponseBody }),
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set(["kr-a"]),
      }),
    ).rejects.toBeInstanceOf(CopilotUnavailable);
    expect(secretCalls, "no secret resolution when envelope missing").toBe(0);
  });

  test("hallucinated citation → refuses", async () => {
    const body = JSON.stringify({
      id: "resp_h",
      model: "gpt-4o-2024-08-06",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                run_type: "practitioner_brief",
                content: { summary: "x" },
                citations: [{ citationType: "knowledge_reference", refId: "kr-hallucinated" }],
              }),
            },
          ],
        },
      ],
    });
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      envelope: baseEnvelope(),
      secretResolver: new SecretResolver({ client: fakeSecrets() }),
      transport: fakeTransport({ status: 200, statusText: "OK", headers: {}, bodyText: body }),
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set(["kr-a"]),
      }),
    ).rejects.toThrow(/hallucinated/);
  });

  test("HTTP 429 exhausts retries → throws (no synthetic completed)", async () => {
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      envelope: baseEnvelope(),
      secretResolver: new SecretResolver({ client: fakeSecrets() }),
      transport: fakeTransport({ status: 429, statusText: "Too Many", headers: {}, bodyText: "{}" }),
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, timeoutMs: 100 },
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set(["kr-a"]),
      }),
    ).rejects.toThrow();
  });

  test("HTTP 401 → throws immediately, does not retry", async () => {
    let calls = 0;
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      envelope: baseEnvelope(),
      secretResolver: new SecretResolver({ client: fakeSecrets() }),
      transport: {
        kind: "fake",
        async send() {
          calls += 1;
          return { status: 401, statusText: "unauth", headers: {}, bodyText: "{}" };
        },
      },
      retryPolicy: { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 1, timeoutMs: 100 },
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set(["kr-a"]),
      }),
    ).rejects.toThrow();
    expect(calls, "401 must not be retried").toBe(1);
  });

  test("content_policy 400 → throws immediately (safety_refusal)", async () => {
    let calls = 0;
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      envelope: baseEnvelope(),
      secretResolver: new SecretResolver({ client: fakeSecrets() }),
      transport: {
        kind: "fake",
        async send() {
          calls += 1;
          return {
            status: 400,
            statusText: "Bad",
            headers: {},
            bodyText: JSON.stringify({ error: { code: "content_policy", message: "policy" } }),
          };
        },
      },
      retryPolicy: { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 1, timeoutMs: 100 },
    });
    await expect(
      adapter.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {},
        allowedCitationIds: new Set(["kr-a"]),
      }),
    ).rejects.toThrow();
    expect(calls, "safety_refusal must not be retried").toBe(1);
  });

  test("adapter never returns bearer or full response body in its outputs", async () => {
    const env = baseEnvelope();
    const adapter = createOpenAIAdapter({
      approval: approval(),
      model: "gpt-4o-2024-08-06",
      containsPHI: false,
      envelope: env,
      secretResolver: new SecretResolver({ client: fakeSecrets() }),
      transport: fakeTransport({ status: 200, statusText: "OK", headers: {}, bodyText: validResponseBody }),
    });
    const out = await adapter.draft({
      runType: "practitioner_brief",
      lens: "western",
      inputSnapshot: {},
      allowedCitationIds: new Set(["kr-a"]),
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("TEST_FAKE_BEARER");
    expect(json).not.toContain("Bearer");
  });
});
