/**
 * Phase 10B.2 — the governed model allowlist.
 *
 * SERVER-ONLY. The single place that knows which OpenAI model identifiers
 * this application may name, what each one costs, and which request
 * parameters each one accepts.
 *
 * EXACT IDENTIFIERS ONLY. `gpt-5.6` is an alias that OpenAI points at Sol
 * today and may point elsewhere tomorrow. A clinical run row that records
 * an alias records nothing durable: re-reading it a year later cannot tell
 * you what actually produced the draft. So aliases are refused by name,
 * and the exact identifier is written to every run and every telemetry
 * row.
 *
 * The allowlist here is NECESSARY, never SUFFICIENT. A model also has to
 * be on the provider registry row's `approved_model_allowlist` AND match
 * the activation row's `approved_model`. This table only says "the code
 * knows how to talk to this"; the governed records say "this organization
 * may".
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/model-allowlist is server-only.");
}

export type ModelCapabilities = {
  /** The exact identifier sent to OpenAI and written to the run row. */
  id: string;
  /**
   * Reasoning-family models reject the classic sampling parameters. Sending
   * `temperature` to one is a 400, which aborts a run for no reason — so
   * the capability is declared rather than assumed.
   */
  supportsTemperature: boolean;
  /** Reasoning models take `reasoning: { effort }` instead. */
  supportsReasoningEffort: boolean;
  /** USD cents per million input tokens, standard (short-context) tier. */
  inputCentsPerMillion: number;
  /** USD cents per million output tokens, standard tier. */
  outputCentsPerMillion: number;
  /**
   * Above this many input tokens OpenAI bills the WHOLE request at a
   * long-context rate. The estimator refuses rather than silently
   * under-quoting a run that crosses it.
   */
  longContextThresholdTokens: number;
  maxOutputTokens: number;
};

/**
 * Verified against OpenAI's published model documentation on 2026-08-05
 * (developers.openai.com/api/docs/models/gpt-5.6-sol): exact id
 * `gpt-5.6-sol`, Responses endpoint, structured outputs supported, 128,000
 * max output tokens, $5/M input and $30/M output on the standard tier with
 * a long-context tier above 272K input tokens.
 *
 * `temperature` is NOT sent. The reasoning-family models take
 * `reasoning: { effort }`, and the published parameter reference does not
 * list `temperature` as supported for them. Sending an unsupported
 * parameter fails the request, and a governed clinical run must not fail
 * for a reason this repository could have avoided. Determinism is pursued
 * through a pinned prompt, a strict schema, and `effort` instead.
 */
export const GOVERNED_MODELS: readonly ModelCapabilities[] = [
  {
    id: "gpt-5.6-sol",
    supportsTemperature: false,
    supportsReasoningEffort: true,
    inputCentsPerMillion: 500,
    outputCentsPerMillion: 3000,
    longContextThresholdTokens: 272_000,
    maxOutputTokens: 128_000,
  },
];

/**
 * Identifiers that must never be sent, even if an operator writes one onto
 * a registry row. A floating alias resolves to a different model over
 * time; `latest` is the same problem wearing a different word.
 */
const REFUSED_ALIASES = new Set([
  "gpt-5.6",
  "gpt-5",
  "gpt-4o",
  "gpt-4o-latest",
  "chatgpt-4o-latest",
  "gpt-latest",
  "latest",
]);

export type ModelRefusal = "model_is_floating_alias" | "model_not_on_allowlist";

export type ModelResolution =
  | { ok: true; model: ModelCapabilities }
  | { ok: false; refusal: ModelRefusal };

export function resolveGovernedModel(id: string | null | undefined): ModelResolution {
  const trimmed = String(id ?? "").trim();
  if (REFUSED_ALIASES.has(trimmed.toLowerCase())) {
    return { ok: false, refusal: "model_is_floating_alias" };
  }
  const found = GOVERNED_MODELS.find((m) => m.id === trimmed);
  if (!found) return { ok: false, refusal: "model_not_on_allowlist" };
  return { ok: true, model: found };
}

export function isGovernedModel(id: string | null | undefined): boolean {
  return resolveGovernedModel(id).ok;
}

/* ------------------------------------------------------------------ cost */

export type CostEstimate =
  | { ok: true; cents: number; inputTokens: number; outputTokens: number }
  | { ok: false; refusal: "long_context_tier_unpriced" | "negative_tokens" };

/**
 * Estimate a call's cost in whole cents, rounded UP.
 *
 * Rounding up matters: a budget that under-counts by a fraction of a cent
 * per call is a budget that can be walked past. Everything here is
 * integer-cent arithmetic for the same reason — the database caps are
 * integers, and a float that rounds to the cap is not the cap.
 *
 * A request that would cross the long-context threshold is REFUSED rather
 * than priced, because above it OpenAI re-bills the entire request at a
 * higher rate and this estimator would be quoting the wrong tier. Nothing
 * in this phase's envelope comes anywhere near 272K tokens; if something
 * ever does, the refusal is the correct outcome.
 */
export function estimateCostCents(
  model: ModelCapabilities,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  if (inputTokens < 0 || outputTokens < 0) return { ok: false, refusal: "negative_tokens" };
  if (inputTokens > model.longContextThresholdTokens) {
    return { ok: false, refusal: "long_context_tier_unpriced" };
  }
  const cents =
    Math.ceil((inputTokens * model.inputCentsPerMillion) / 1_000_000) +
    Math.ceil((outputTokens * model.outputCentsPerMillion) / 1_000_000);
  return { ok: true, cents, inputTokens, outputTokens };
}

/**
 * A deliberately crude token estimate for BUDGET RESERVATION only.
 *
 * It is not a tokenizer and does not pretend to be. Reservation happens
 * before the call, when the true count is unknowable, so the only safe
 * error direction is over-estimating: four characters per token is below
 * the real ratio for JSON, which makes this an over-count, which makes the
 * reservation conservative. The ACTUAL counts come back from the provider
 * and are what `settle_copilot_external_call` charges against the cap.
 */
export function projectTokens(serializedRequest: string, maxOutputTokens: number): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: Math.ceil(serializedRequest.length / 4),
    outputTokens: maxOutputTokens,
  };
}
