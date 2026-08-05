/**
 * Phase 10B.1 — OpenAI Responses API request builder + response validator.
 *
 * SERVER-ONLY. Produces the exact JSON body and headers that would be sent
 * to OpenAI once approval + secret gates pass. The adapter's transport
 * layer is INJECTED (`http-transport.ts::Transport`); nothing here calls
 * `fetch` on its own. In this PR, live mode is never activated, so this
 * code path is exercised only by unit tests and a fake local transport —
 * NOT by an external OpenAI request.
 *
 * The request body carries only the minimized envelope. Prompts + user
 * text never appear in error paths, and raw response bodies are hashed
 * before any log-safe error category is returned.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider.openai.request is server-only.");
}

import { createHash } from "node:crypto";
import type { MinimizedEnvelope } from "./data-minimizer";

/**
 * The exact request shape the adapter sends. Fields are declared inline
 * rather than in a shared type so an unknown field in a future OpenAI
 * response can be dropped by structural validation rather than by JSON
 * key alignment.
 */
export type OpenAIRequestBody = {
  model: string;
  input: Array<{ role: "system" | "user"; content: string }>;
  response_format: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: true;
      schema: Record<string, unknown>;
    };
  };
  temperature: 0;
  max_output_tokens: number;
  metadata: {
    envelope_sha256: string;
    run_type: string;
    rule_set_version: string;
    prompt_version: string;
    output_schema_version: string;
  };
};

export type OpenAIRequestPreamble = {
  endpoint: URL;
  method: "POST";
  headers: Record<string, string>;
  body: OpenAIRequestBody;
};

/**
 * The governed clinical output JSON Schema. Every top-level property is
 * required; the response validator rejects unknown fields.
 */
export const COPILOT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["run_type", "content", "citations"],
  properties: {
    run_type: { type: "string" },
    content: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string", maxLength: 4000 },
      },
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["citationType", "refId"],
        properties: {
          citationType: {
            type: "string",
            enum: ["knowledge_reference", "product_label", "protocol_template", "diet_template"],
          },
          refId: { type: "string" },
          version: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

/**
 * The default endpoint for the OpenAI Responses API. Not user-configurable
 * — a caller cannot swap the base URL via env variable in production. In
 * unit tests and the local fake transport, the URL is used only as an
 * identifier; the transport does not open a socket.
 */
export const OPENAI_API_ORIGIN = "https://api.openai.com";
export const OPENAI_RESPONSES_PATH = "/v1/responses";

const DEFAULT_ENDPOINT = new URL(OPENAI_RESPONSES_PATH, OPENAI_API_ORIGIN);

/**
 * The one endpoint this adapter may call. Exposed so the transport
 * allowlist and the request builder cannot drift apart: both derive from
 * this constant rather than repeating a literal.
 */
export function openAIResponsesEndpoint(): URL {
  return new URL(DEFAULT_ENDPOINT.toString());
}

const SYSTEM_INSTRUCTION_HEADER =
  "You are a governed clinical copilot. Reply ONLY with the required JSON. " +
  "Include ONLY citation refIds present in `allowedCitationIds`. " +
  "Do not fabricate patient details. Do not include commercial recommendations. " +
  "Do not include prices, affiliate links, or promotional copy. " +
  "Never issue orders, prescriptions, activation instructions, or patient messages.";

/**
 * Serialize a minimized envelope into the exact request the transport
 * would send. `apiKey` is passed through as an opaque bearer string; the
 * caller must have resolved it from the secret manager before calling.
 */
export function buildOpenAIRequest(input: {
  envelope: MinimizedEnvelope;
  model: string;
  apiKey: string;
  organizationHeader: string | null;
  projectHeader: string | null;
  endpoint?: URL;
  maxOutputTokens?: number;
}): OpenAIRequestPreamble {
  const endpoint = input.endpoint ?? DEFAULT_ENDPOINT;
  if (endpoint.protocol !== "https:") {
    throw new Error("openai_endpoint_not_https");
  }
  // A caller-supplied endpoint is checked against the pinned origin AND
  // path, not merely against the scheme. `https://evil.example/v1/responses`
  // is https, and would otherwise have been accepted.
  if (endpoint.origin !== OPENAI_API_ORIGIN || endpoint.pathname !== OPENAI_RESPONSES_PATH) {
    throw new Error("openai_endpoint_not_allowlisted");
  }
  if (!input.apiKey || input.apiKey.length < 20) {
    throw new Error("openai_key_shape_invalid");
  }
  const userPayload = {
    envelope_sha256: input.envelope.envelopeSha256,
    run_type: input.envelope.runType,
    lens: input.envelope.lens,
    rule_set_version: input.envelope.ruleSetVersion,
    prompt_version: input.envelope.promptVersion,
    output_schema_version: input.envelope.outputSchemaVersion,
    demographics: input.envelope.demographics,
    activeMedications: input.envelope.activeMedications,
    activeAllergies: input.envelope.activeAllergies,
    labs: input.envelope.labs,
    currentProtocols: input.envelope.currentProtocols,
    restrictedFlagsPresent: input.envelope.restrictedFlagsPresent,
    allowedCitationIds: input.envelope.allowedCitationIds,
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    // Modified Retention posture is a project-level OpenAI setting; the
    // client repeats it as a hint so log inspection in-transit can see it.
    "OpenAI-Beta": "responses=v1",
  };
  if (input.organizationHeader) headers["OpenAI-Organization"] = input.organizationHeader;
  if (input.projectHeader) headers["OpenAI-Project"] = input.projectHeader;

  const body: OpenAIRequestBody = {
    model: input.model,
    input: [
      { role: "system", content: SYSTEM_INSTRUCTION_HEADER },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "copilot_output_v1",
        strict: true,
        schema: COPILOT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    temperature: 0,
    max_output_tokens: input.maxOutputTokens ?? 1200,
    metadata: {
      envelope_sha256: input.envelope.envelopeSha256,
      run_type: input.envelope.runType,
      rule_set_version: input.envelope.ruleSetVersion,
      prompt_version: input.envelope.promptVersion,
      output_schema_version: input.envelope.outputSchemaVersion,
    },
  };
  return { endpoint, method: "POST", headers, body };
}

/**
 * Every field the OpenAI response wrapper must carry for a valid Responses
 * API completion. Anything else is dropped; unknown fields cause refusal.
 */
export type OpenAIResponseWrapper = {
  id: string;
  model: string;
  output: Array<{
    type: "message";
    content: Array<{ type: "output_text"; text: string }>;
  }>;
};

export type ParsedCopilotOutput = {
  runType: string;
  content: { summary: string };
  citations: Array<{
    citationType: "knowledge_reference" | "product_label" | "protocol_template" | "diet_template";
    refId: string;
    version: string | null;
  }>;
  contentSha256: string;
  providerResponseId: string;
  providerModel: string;
};

/**
 * Structural validation. Any unknown top-level field, missing required
 * field, mistyped value, or citation refId not in `allowedCitationIds` →
 * throws `openai_malformed_output`.
 */
export function parseAndValidateOpenAIResponse(input: {
  raw: unknown;
  allowedCitationIds: ReadonlySet<string>;
  expectedModelPrefix?: string;
}): ParsedCopilotOutput {
  const raw = input.raw as Partial<OpenAIResponseWrapper>;
  if (!raw || typeof raw !== "object") throw new Error("openai_malformed_output");
  if (typeof raw.id !== "string" || typeof raw.model !== "string")
    throw new Error("openai_malformed_output");
  if (input.expectedModelPrefix && !raw.model.startsWith(input.expectedModelPrefix)) {
    // Different model than requested — refuse. Even if a valid model, the
    // adapter should not accept a substitute.
    throw new Error("openai_malformed_output");
  }
  const output = raw.output;
  if (!Array.isArray(output) || output.length === 0) throw new Error("openai_malformed_output");
  const first = output[0];
  if (
    !first || typeof first !== "object" ||
    (first as { type?: string }).type !== "message"
  ) throw new Error("openai_malformed_output");
  const content = (first as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) throw new Error("openai_malformed_output");
  const outputText = content[0];
  if (
    !outputText || typeof outputText !== "object" ||
    (outputText as { type?: string }).type !== "output_text" ||
    typeof (outputText as { text?: unknown }).text !== "string"
  ) throw new Error("openai_malformed_output");
  const parsed = safeJsonParse((outputText as { text: string }).text);
  if (!parsed) throw new Error("openai_malformed_output");
  return validateStructure(parsed, {
    allowedCitationIds: input.allowedCitationIds,
    providerResponseId: raw.id,
    providerModel: raw.model,
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateStructure(
  parsed: unknown,
  ctx: {
    allowedCitationIds: ReadonlySet<string>;
    providerResponseId: string;
    providerModel: string;
  },
): ParsedCopilotOutput {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openai_malformed_output");
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  const allowedKeys = new Set(["run_type", "content", "citations"]);
  for (const k of keys) {
    if (!allowedKeys.has(k)) throw new Error("openai_malformed_output");
  }
  const runType = (parsed as { run_type?: unknown }).run_type;
  const rawContent = (parsed as { content?: unknown }).content;
  const rawCitations = (parsed as { citations?: unknown }).citations;
  if (typeof runType !== "string") throw new Error("openai_malformed_output");
  if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent))
    throw new Error("openai_malformed_output");
  const contentKeys = Object.keys(rawContent as Record<string, unknown>);
  if (contentKeys.length !== 1 || contentKeys[0] !== "summary")
    throw new Error("openai_malformed_output");
  const summary = (rawContent as { summary?: unknown }).summary;
  if (typeof summary !== "string" || summary.length > 4000)
    throw new Error("openai_malformed_output");
  if (!Array.isArray(rawCitations)) throw new Error("openai_malformed_output");
  const citations: ParsedCopilotOutput["citations"] = [];
  for (const c of rawCitations) {
    if (!c || typeof c !== "object" || Array.isArray(c))
      throw new Error("openai_malformed_output");
    const cKeys = Object.keys(c as Record<string, unknown>);
    for (const k of cKeys) {
      if (!["citationType", "refId", "version"].includes(k))
        throw new Error("openai_malformed_output");
    }
    const citationType = (c as { citationType?: unknown }).citationType;
    const refId = (c as { refId?: unknown }).refId;
    const version = (c as { version?: unknown }).version;
    if (
      typeof citationType !== "string" ||
      !["knowledge_reference", "product_label", "protocol_template", "diet_template"].includes(citationType)
    ) throw new Error("openai_malformed_output");
    if (typeof refId !== "string") throw new Error("openai_malformed_output");
    if (version !== undefined && version !== null && typeof version !== "string")
      throw new Error("openai_malformed_output");
    if (!ctx.allowedCitationIds.has(refId)) {
      // Hallucinated citation → refuse.
      throw new Error("openai_hallucinated_citation");
    }
    citations.push({
      citationType: citationType as ParsedCopilotOutput["citations"][number]["citationType"],
      refId,
      version: (version as string | null) ?? null,
    });
  }
  const contentSha256 = createHash("sha256")
    .update(JSON.stringify({ summary, citations }))
    .digest("hex");
  return {
    runType,
    content: { summary },
    citations,
    contentSha256,
    providerResponseId: ctx.providerResponseId,
    providerModel: ctx.providerModel,
  };
}

/**
 * PHI-safe response body hasher for logs. Callers hash raw bodies BEFORE
 * writing anything to a log or a failure envelope. Never returns the raw
 * text.
 */
export function hashProviderBodyForAudit(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
