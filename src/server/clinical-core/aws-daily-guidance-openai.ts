if (typeof window !== "undefined") throw new Error("aws-daily-guidance-openai is server-only");

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { parseOpenAISecret } from "./aws-lab-openai";
import {
  DAILY_GUIDANCE_EVIDENCE,
  DAILY_GUIDANCE_EVIDENCE_VERSION,
  DAILY_GUIDANCE_REPRODUCTIVE_RULES,
} from "./daily-guidance-evidence";
import {
  DailyGuidanceError,
  validateDailyGuidanceResult,
  type DailyGuidanceInput,
  type DailyGuidanceResult,
} from "./aws-daily-guidance";

const secrets = new SecretsManagerClient({});
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "actions", "confidence"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 600 },
    actions: {
      type: "array", minItems: 1, maxItems: 5,
      items: {
        type: "object", additionalProperties: false,
        required: ["category", "title", "rationale", "inputMetrics", "evidenceIds"],
        properties: {
          category: { type: "string", enum: ["movement", "nutrition", "sleep", "recovery"] },
          title: { type: "string", minLength: 1, maxLength: 120 },
          rationale: { type: "string", minLength: 1, maxLength: 280 },
          inputMetrics: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          evidenceIds: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        },
      },
    },
    confidence: { type: "string", enum: ["low", "moderate", "high"] },
  },
} as const;

const SYSTEM = [
  "You generate same-day consumer wellness guidance from an exact measured-data contract.",
  "The consumer receives the interpretation directly; do not imply practitioner review or approval.",
  "Use only supplied measurements, baselines, symptoms, reproductive context, and evidence policies. Missing fields are unknown; never infer, impute, or substitute defaults.",
  "Cycle phase is low-confidence context and never overrides measured recovery or symptoms. Do not claim universal cycle-syncing benefits.",
  "For irregular cycles, hormonal contraception, pregnancy, postpartum, perimenopause, menopause, not-applicable, or prefer-not-to-say, do not infer a cycle phase.",
  "Do not diagnose, prescribe, recommend supplements or products, or suggest changing medication, hormone, supplement, or dose.",
  "Do not provide calorie restriction, fasting, or advice that could worsen low energy availability.",
  "Pregnancy and postpartum output must remain moderate, symptom-led, and acknowledge that medical or obstetric complications require individualized professional guidance.",
  "Cite only evidence IDs included in the supplied evidence registry and only inputMetrics present in the request.",
  "Each rationale must be one complete plain-language sentence no longer than 280 characters; never end mid-thought.",
  "Return JSON only and match the schema exactly.",
].join(" ");

export function buildDailyGuidanceOpenAIRequest(input: DailyGuidanceInput, model: string) {
  return {
    model,
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({
        contractVersion: input.contractVersion,
        date: input.date,
        measurements: input.measurements,
        baselines: input.baselines,
        symptoms: input.symptoms,
        reproductiveContext: input.reproductiveContext,
        evidenceVersion: DAILY_GUIDANCE_EVIDENCE_VERSION,
        evidenceRegistry: DAILY_GUIDANCE_EVIDENCE,
        reproductiveGuidanceRules: input.reproductiveContext
          ? DAILY_GUIDANCE_REPRODUCTIVE_RULES[input.reproductiveContext.stage]
          : null,
      }) },
    ],
    text: { format: { type: "json_schema", name: "consumer_daily_guidance_v1", strict: true, schema: OUTPUT_SCHEMA } },
    store: false,
    reasoning: { effort: "none" },
    max_output_tokens: 1800,
    metadata: { contract: "daily-guidance-openai/1" },
  };
}

function outputText(response: Record<string, unknown>): string {
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "output_text"
        && typeof (part as Record<string, unknown>).text === "string") return (part as { text: string }).text;
    }
  }
  throw new DailyGuidanceError("provider_unavailable");
}

export function parseDailyGuidanceOpenAIResponse(input: { response: unknown; request: DailyGuidanceInput; model: string; generatedAt?: string }): DailyGuidanceResult {
  if (!input.response || typeof input.response !== "object" || Array.isArray(input.response)) throw new DailyGuidanceError("provider_unavailable");
  const response = input.response as Record<string, unknown>;
  if (response.model !== input.model || (response.status !== undefined && response.status !== "completed")) throw new DailyGuidanceError("provider_unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(outputText(response)); } catch (error) {
    if (error instanceof DailyGuidanceError) throw error;
    throw new DailyGuidanceError("provider_unavailable");
  }
  return validateDailyGuidanceResult({ value: parsed, request: input.request, model: input.model, generatedAt: input.generatedAt });
}

async function apiKey(secretArn: string): Promise<string> {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (typeof response.SecretString !== "string") throw new DailyGuidanceError("provider_unavailable");
  try { return parseOpenAISecret(response.SecretString); } catch { throw new DailyGuidanceError("provider_unavailable"); }
}

export async function generateDailyGuidanceWithOpenAI(input: { request: DailyGuidanceInput; model: string; secretArn: string }): Promise<DailyGuidanceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RESPONSES_URL, {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { Authorization: `Bearer ${await apiKey(input.secretArn)}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildDailyGuidanceOpenAIRequest(input.request, input.model)),
    });
    if (response.status >= 300 && response.status < 400) throw new DailyGuidanceError("provider_unavailable");
    const raw = await response.text();
    if (!response.ok || Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES
      || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new DailyGuidanceError("provider_unavailable");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new DailyGuidanceError("provider_unavailable"); }
    return parseDailyGuidanceOpenAIResponse({ response: parsed, request: input.request, model: input.model });
  } catch (error) {
    if (error instanceof DailyGuidanceError) throw error;
    throw new DailyGuidanceError("provider_unavailable");
  } finally {
    clearTimeout(timer);
  }
}
