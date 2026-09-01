if (typeof window !== "undefined") throw new Error("aws-ask-alp is server-only");

import { createHash } from "node:crypto";

export const ASK_ALP_CONTRACT_VERSION = "patient-chat-generation/1" as const;
export const ASK_ALP_CONTEXT_VERSION = "patient-chat-context/1" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const FORBIDDEN_OUTPUT = /\b(?:diagnos(?:e|ed|is)|prescri(?:be|bed)|increase|decrease|double|halve|stop|start|switch)\b.{0,80}\b(?:dose|dosage|medication|hormone|peptide)\b|\b(?:buy|source|purchase)\b.{0,50}\bpeptide\b/i;

export type AskAlpGenerationRequest = {
  contractVersion: typeof ASK_ALP_CONTRACT_VERSION;
  requestId: string;
  systemPromptVersion: string;
  signedSystemPrompt: string;
  contextVersion: typeof ASK_ALP_CONTEXT_VERSION;
  context: Record<string, unknown>;
  userMessage: string;
};

export type AskAlpGenerationResult = {
  answer: string;
  confidence: "low" | "moderate" | "high";
  escalationRecommended: boolean;
  escalationReason: string | null;
  provider: "openai";
  model: string;
};

export class AskAlpError extends Error {
  constructor(readonly category: "request_invalid" | "prompt_not_approved" | "provider_unavailable" | "unsafe_output_refused") {
    super(category);
  }
}

export function promptSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateAskAlpRequest(value: unknown, approvedPromptSha256: string): AskAlpGenerationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AskAlpError("request_invalid");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = ["context", "contextVersion", "contractVersion", "requestId", "signedSystemPrompt", "systemPromptVersion", "userMessage"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)
    || row.contractVersion !== ASK_ALP_CONTRACT_VERSION || row.contextVersion !== ASK_ALP_CONTEXT_VERSION
    || typeof row.requestId !== "string" || !UUID.test(row.requestId)
    || typeof row.systemPromptVersion !== "string" || !VERSION.test(row.systemPromptVersion)
    || typeof row.signedSystemPrompt !== "string" || row.signedSystemPrompt.length < 100 || row.signedSystemPrompt.length > 20_000
    || typeof row.userMessage !== "string" || row.userMessage.trim().length < 1 || row.userMessage.length > 4_000
    || !row.context || typeof row.context !== "object" || Array.isArray(row.context)
    || JSON.stringify(row.context).length > 60_000) throw new AskAlpError("request_invalid");
  if (!/^[0-9a-f]{64}$/.test(approvedPromptSha256) || promptSha256(row.signedSystemPrompt) !== approvedPromptSha256) {
    throw new AskAlpError("prompt_not_approved");
  }
  return row as AskAlpGenerationRequest;
}

export function validateAskAlpResult(value: unknown, model: string): AskAlpGenerationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AskAlpError("provider_unavailable");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = ["answer", "confidence", "escalationRecommended", "escalationReason"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)
    || typeof row.answer !== "string" || row.answer.trim().length < 1 || row.answer.length > 12_000
    || !["low", "moderate", "high"].includes(String(row.confidence))
    || typeof row.escalationRecommended !== "boolean"
    || !(row.escalationReason === null || (typeof row.escalationReason === "string" && row.escalationReason.length <= 240))
    || (row.escalationRecommended && !row.escalationReason)
    || (!row.escalationRecommended && row.escalationReason !== null)
    || FORBIDDEN_OUTPUT.test(row.answer)) throw new AskAlpError("unsafe_output_refused");
  return {
    answer: row.answer.trim(), confidence: row.confidence as AskAlpGenerationResult["confidence"],
    escalationRecommended: row.escalationRecommended, escalationReason: row.escalationReason as string | null,
    provider: "openai", model,
  };
}
