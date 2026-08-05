import { describe, expect, test } from "vitest";
import {
  estimateCostCents,
  GOVERNED_MODELS,
  isGovernedModel,
  projectTokens,
  resolveGovernedModel,
} from "./model-allowlist";

describe("only exact, governed model identifiers resolve", () => {
  test("the phase's model resolves to its exact identifier", () => {
    const r = resolveGovernedModel("gpt-5.6-sol");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.id).toBe("gpt-5.6-sol");
  });

  test("a floating alias is refused BY NAME, not merely missing", () => {
    // The distinction matters for the operator message: "gpt-5.6" is a real
    // model that works today and points somewhere else tomorrow. Refusing
    // it as "not on the allowlist" would invite someone to add it.
    for (const alias of ["gpt-5.6", "gpt-5", "gpt-4o", "chatgpt-4o-latest", "latest", "gpt-latest"]) {
      const r = resolveGovernedModel(alias);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal, alias).toBe("model_is_floating_alias");
    }
  });

  test("an unknown identifier is refused as off-allowlist", () => {
    for (const id of ["claude-opus-5", "gpt-5.7-sol", "", null, undefined, "  "]) {
      const r = resolveGovernedModel(id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toBe("model_not_on_allowlist");
    }
  });

  test("resolution is exact — no trimming into a match, no case folding", () => {
    expect(isGovernedModel("GPT-5.6-SOL")).toBe(false);
    expect(isGovernedModel("gpt-5.6-sol ")).toBe(true); // trimmed input only
    expect(isGovernedModel("gpt-5.6-sol-preview")).toBe(false);
  });

  test("every governed model declares its parameter capabilities explicitly", () => {
    for (const m of GOVERNED_MODELS) {
      expect(typeof m.supportsTemperature).toBe("boolean");
      expect(typeof m.supportsReasoningEffort).toBe("boolean");
      expect(m.inputCentsPerMillion).toBeGreaterThan(0);
      expect(m.outputCentsPerMillion).toBeGreaterThan(0);
      expect(m.longContextThresholdTokens).toBeGreaterThan(0);
    }
  });

  test("the reasoning-family model does NOT claim temperature support", () => {
    const r = resolveGovernedModel("gpt-5.6-sol");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.supportsTemperature).toBe(false);
      expect(r.model.supportsReasoningEffort).toBe(true);
    }
  });
});

describe("cost estimation is integer cents and rounds UP", () => {
  const model = GOVERNED_MODELS[0]!;

  test("published rates: $5/M input, $30/M output", () => {
    // Priced at 100K each rather than 1M: a 1M-token INPUT is past the
    // long-context threshold and is correctly refused, so it cannot be
    // used to check the standard-tier rate.
    const e = estimateCostCents(model, 100_000, 100_000);
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.cents).toBe(50 + 300);
    expect(model.inputCentsPerMillion).toBe(500);
    expect(model.outputCentsPerMillion).toBe(3000);
  });

  test("output tokens are NOT capped by the long-context input threshold", () => {
    // The tier is decided by INPUT size. A large output under a small
    // input is priced, not refused.
    const e = estimateCostCents(model, 1_000, 1_000_000);
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.cents).toBe(1 + 3000);
  });

  test("a fractional cent rounds up, never down", () => {
    // 1 input token is worth 0.0005 cents. Rounding down would let an
    // unbounded number of small calls cost nothing against the cap.
    const e = estimateCostCents(model, 1, 1);
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.cents).toBe(2);
  });

  test("zero tokens costs zero", () => {
    const e = estimateCostCents(model, 0, 0);
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.cents).toBe(0);
  });

  test("a long-context request is REFUSED rather than under-quoted", () => {
    // Above the threshold OpenAI re-bills the whole request at a higher
    // rate; quoting the standard tier would be wrong, not approximate.
    const e = estimateCostCents(model, model.longContextThresholdTokens + 1, 10);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.refusal).toBe("long_context_tier_unpriced");
  });

  test("negative tokens are refused rather than credited", () => {
    expect(estimateCostCents(model, -1, 0).ok).toBe(false);
    expect(estimateCostCents(model, 0, -1).ok).toBe(false);
  });

  test("the phase cap of $5 buys a bounded, checkable number of calls", () => {
    // 10 calls x (2000 in + 1200 out) is the phase's worst case.
    const per = estimateCostCents(model, 2000, 1200);
    expect(per.ok).toBe(true);
    if (per.ok) {
      expect(per.cents * 10).toBeLessThanOrEqual(500);
    }
  });
});

describe("token projection is conservative by construction", () => {
  test("it OVER-estimates input, because reservation happens before truth", () => {
    const body = JSON.stringify({ a: "x".repeat(400) });
    const p = projectTokens(body, 1200);
    // 4 chars/token is below the real JSON ratio, so this over-counts.
    expect(p.inputTokens).toBeGreaterThanOrEqual(body.length / 4);
    expect(p.outputTokens).toBe(1200);
  });

  test("it reserves the FULL output allowance, not an average", () => {
    expect(projectTokens("{}", 1200).outputTokens).toBe(1200);
  });
});
