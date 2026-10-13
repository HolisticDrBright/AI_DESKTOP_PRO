import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAskAlpWithOpenAI } from "./aws-ask-alp-openai";
import type { AskAlpGenerationRequest } from "./aws-ask-alp";

const fixture = vi.hoisted(() => ({ secret: vi.fn(), knowledge: vi.fn() }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = fixture.secret; },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("./aws-reviewed-knowledge", () => ({ loadReviewedKnowledge: fixture.knowledge }));

const MODEL = "fictional-model";
const LIMIT = 512 * 1024;
const answer = { answer: "No measured labs are supplied in this fictional context.", confidence: "low", escalationRecommended: false, escalationReason: null };
const request: AskAlpGenerationRequest = {
  contractVersion: "patient-chat-generation/1", contextVersion: "patient-chat-context/1",
  requestId: "11111111-1111-4111-8111-111111111111", systemPromptVersion: "fictional/1",
  signedSystemPrompt: "Fictional transport test only. No real health information.",
  context: { labs: [] }, userMessage: "Explain the supplied fictional context.",
};
const encode = (value: string) => new TextEncoder().encode(value);
const payload = (changes: Record<string, unknown> = {}) => JSON.stringify({
  model: MODEL, status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(answer) }] }], ...changes,
});

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200, cancellation?: () => Promise<void>) {
  let reads = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { cancelled = true; return cancellation?.(); },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers: { "content-type": "application/json", ...headers }, status }), observations: () => ({ reads, cancelled }) };
}

function generate(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response));
  return generateAskAlpWithOpenAI({ request, model: MODEL, secretArn: "fictional-secret" });
}

beforeEach(() => {
  fixture.secret.mockReset().mockResolvedValue({ SecretString: JSON.stringify({ OPENAI_API_KEY: `sk-${"x".repeat(40)}` }) });
  fixture.knowledge.mockReset().mockResolvedValue(null);
  vi.stubEnv("PHI_ALLOWED", "false");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Ask ALP provider response bounds through the actual generation path", () => {
  it("accepts a bounded split UTF-8 response without calling unbounded text()", async () => {
    const bytes = encode(payload({ extraMetadata: "é" }));
    const split = bytes.indexOf(0xc3) + 1;
    const transport = streamed([bytes.slice(0, split), bytes.slice(split)], { "content-length": String(bytes.length) });
    transport.response.text = vi.fn(async () => { throw Error("unbounded materialization is forbidden"); });
    await expect(generate(transport.response)).resolves.toEqual({ ...answer, provider: "openai", model: MODEL });
    expect(transport.response.text).not.toHaveBeenCalled();
  });

  it("refuses at the first decoded byte overrun and never drains later chunks", async () => {
    const transport = streamed([new Uint8Array(LIMIT).fill(32), encode("x"), encode("must not be read")]);
    await expect(generate(transport.response)).rejects.toThrow(/^provider_unavailable$/);
    expect(transport.observations()).toEqual({ reads: 2, cancelled: true });
  });

  it.each(["524289", "-1", "NaN", "1.5", "01", "9007199254740992"])("refuses declaration %s before consuming the body", async length => {
    const transport = streamed([encode(payload())], { "content-length": length });
    await expect(generate(transport.response)).rejects.toThrow(/^provider_unavailable$/);
    expect(transport.observations()).toEqual({ reads: 0, cancelled: true });
  });

  it.each(["1", "900"])("refuses disagreeing identity body length %s", async length => {
    await expect(generate(streamed([encode(payload())], { "content-length": length }).response)).rejects.toThrow(/^provider_unavailable$/);
  });

  it("bounds decoded compressed data without comparing decoded bytes with wire length", async () => {
    await expect(generate(streamed([encode(payload())], { "content-encoding": "gzip", "content-length": "20" }).response))
      .resolves.toEqual({ ...answer, provider: "openai", model: MODEL });
  });

  it.each(["text/plain", "application/json-evil", "text/application/json", ""])("refuses media type %s before reading", async type => {
    const transport = streamed([encode(payload())], { "content-type": type });
    await expect(generate(transport.response)).rejects.toThrow(/^provider_unavailable$/);
    expect(transport.observations()).toEqual({ reads: 0, cancelled: true });
  });

  it.each([302, 401, 429, 500])("refuses and cancels HTTP %s without reading provider error content", async status => {
    const transport = streamed([encode("private fictional provider error")], {}, status);
    await expect(generate(transport.response)).rejects.toThrow(/^provider_unavailable$/);
    expect(transport.observations()).toEqual({ reads: 0, cancelled: true });
  });

  it("rejects malformed UTF-8 even if replacement decoding would create valid JSON", async () => {
    const bytes = Buffer.concat([Buffer.from('{"model":"fictional-model","status":"completed","output":[{"content":[{"type":"output_text","text":'),
      Buffer.from(JSON.stringify(JSON.stringify({ ...answer, answer: "Fictional REPLACED result" })).replace("REPLACED", "")), Buffer.from('}]}],"extra":"'),
      Buffer.from([0xff]), Buffer.from('"}')]);
    await expect(generate(streamed([bytes]).response)).rejects.toThrow(/^provider_unavailable$/);
  });

  it.each(["incomplete", "failed", "cancelled"])("preserves refusal for structured response status %s", async status => {
    await expect(generate(streamed([encode(payload({ status }))]).response)).rejects.toThrow(/^provider_unavailable$/);
  });

  it("preserves tool-free, store-false, pinned-model request settings", async () => {
    await generate(streamed([encode(payload())]).response);
    const fetchMock = vi.mocked(fetch);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options?.redirect).toBe("manual");
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: MODEL, store: false, text: { format: { strict: true } } });
    expect(body).not.toHaveProperty("tools");
  });

  it("settles a stalled provider body within the existing 30-second request deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let close: (() => void) | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encode("{")); close = () => controller.close(); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    const observed = generate(response).then(() => "accepted", error => error.message);
    const boundedObservation = Promise.race([observed, new Promise<string>(resolve => setTimeout(() => resolve("still_pending"), 30_001))]);
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await boundedObservation).toBe("provider_unavailable");
      expect(cancelled).toBe(true);
    } finally { if (!cancelled) close?.(); await observed; }
  });
});
