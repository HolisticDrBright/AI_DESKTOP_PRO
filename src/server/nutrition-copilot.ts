if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

/**
 * The nutrition copilot boundary (server-only).
 *
 * DRAFT ONLY, and governed in the literal sense: every suggestion it makes is
 * derived from inputs already recorded in this system — a published template
 * version and the patient's own recorded constraints. It does not generate
 * dietary advice, and it has no model behind it to generate any. That is a
 * design decision, not a missing feature: a fluent invented food rule is
 * indistinguishable from a real one on the screen, and this is the wrong place
 * to find that out.
 *
 * What it therefore CANNOT do, structurally rather than by policy:
 *
 *   - it cannot write. There is no database call in this module and it imports
 *     no adapter, so a draft only ever becomes real when a practitioner saves it
 *     through the ordinary RPC path;
 *   - it cannot approve or activate. No function here has that shape;
 *   - it cannot set an energy or macro target. Those are clinical numbers and
 *     they come from the practitioner who calculated them;
 *   - it cannot claim evidence. Nothing it emits carries an evidence grade, and
 *     the database would refuse a `governed_reference` grade anyway without an
 *     actual reference row;
 *   - it cannot silently drop a food rule that conflicts with an allergy. It
 *     RAISES the conflict instead, because a quiet removal hides exactly the
 *     thing a practitioner needs to see.
 *
 * Every item it returns is labelled a draft and carries the reason it was
 * suggested, so the practitioner is reviewing an argument rather than a verdict.
 */

export interface CopilotConfigReport {
  enabled: boolean;
  /** Operator-facing reasons, never secrets. */
  problems: string[];
}

const ENABLE_FLAG = "NUTRITION_COPILOT_ENABLED";

export function getCopilotConfig(): CopilotConfigReport {
  const raw = (process.env[ENABLE_FLAG] ?? "").trim().toLowerCase();
  const enabled = raw === "1" || raw === "true";
  return {
    enabled,
    problems: enabled
      ? []
      : [`${ENABLE_FLAG} is not set — the nutrition copilot is disabled.`],
  };
}

export class CopilotDisabledError extends Error {
  readonly code = "not_configured";
  readonly problems: string[];
  constructor(problems: string[]) {
    super("The nutrition copilot is disabled.");
    this.name = "CopilotDisabledError";
    this.problems = problems;
  }
}

/* ------------------------------------------------------------- contract */

export interface CopilotConstraint {
  kind: string;
  label: string;
  severity?: string | null;
  source?: string | null;
}

export interface CopilotFoodRule {
  disposition: "emphasize" | "include" | "limit" | "avoid" | "conditional";
  label: string;
  conditionNote?: string | null;
  phaseNumber?: number | null;
}

export interface CopilotTemplateSnapshot {
  templateName: string;
  versionNumber: number;
  requiresPractitionerReview: boolean;
  foodRules: CopilotFoodRule[];
}

export type CopilotSuggestionKind =
  | "carry_forward"
  | "conflict_with_constraint"
  | "needs_substitution"
  | "missing_assessment"
  | "review_required";

export interface CopilotSuggestion {
  kind: CopilotSuggestionKind;
  /** Always true. There is no non-draft output from this module. */
  isDraft: true;
  title: string;
  /** Why this was suggested, in terms of the recorded input it came from. */
  rationale: string;
  /** The recorded input this was derived from — never an unattributed claim. */
  derivedFrom: string;
  /** Blocking suggestions must be dealt with before the draft is submitted. */
  severity: "info" | "attention";
  ruleLabel?: string;
}

export interface CopilotDraft {
  suggestions: CopilotSuggestion[];
  /** Provenance kind the caller records if any suggestion is accepted. */
  provenanceKind: "copilot_draft";
  /** Repeated on the payload so a UI cannot render this as a finished plan. */
  disclaimer: string;
}

const DISCLAIMER =
  "Draft suggestions assembled from this organisation's published template and " +
  "this patient's recorded constraints. Nothing here has been reviewed, nothing " +
  "is saved, and none of it is advice until a practitioner edits, approves and " +
  "activates a plan.";

/** Constraint kinds where a matching food rule is a safety problem, not a preference. */
const SAFETY_KINDS = new Set(["allergy", "intolerance"]);

/**
 * Assemble a draft from a published template and the patient's constraints.
 *
 * Deterministic: the same inputs give the same suggestions, which is what makes
 * this reviewable at all.
 */
export function draftPlanFromTemplate(input: {
  template: CopilotTemplateSnapshot;
  constraints: CopilotConstraint[];
}): CopilotDraft {
  const config = getCopilotConfig();
  if (!config.enabled) throw new CopilotDisabledError(config.problems);

  const suggestions: CopilotSuggestion[] = [];
  const { template, constraints } = input;

  if (constraints.length === 0) {
    suggestions.push({
      kind: "missing_assessment",
      isDraft: true,
      title: "No constraints are recorded for this patient",
      rationale:
        "Nothing is recorded about allergies, intolerances, access, budget or " +
        "cooking ability, so this draft cannot be tailored and should not be " +
        "read as though it has been.",
      derivedFrom: "the patient's constraint list, which is empty",
      severity: "attention",
    });
  }

  for (const rule of template.foodRules) {
    const clash = constraints.find(
      (c) =>
        rule.disposition !== "avoid" &&
        rule.disposition !== "limit" &&
        matches(rule.label, c.label),
    );

    if (clash && SAFETY_KINDS.has(clash.kind)) {
      // Raised, never removed. A silent removal would hide the conflict.
      suggestions.push({
        kind: "conflict_with_constraint",
        isDraft: true,
        title: `"${rule.label}" conflicts with a recorded ${clash.kind}`,
        rationale:
          "The template tells the patient to eat this, and a recorded " +
          `${clash.kind} names it. This is left in the draft deliberately so ` +
          "you decide what happens to it — it is not removed behind your back.",
        derivedFrom: `recorded ${clash.kind}: ${clash.label}`,
        severity: "attention",
        ruleLabel: rule.label,
      });
      continue;
    }

    if (clash) {
      suggestions.push({
        kind: "needs_substitution",
        isDraft: true,
        title: `"${rule.label}" may need a substitute`,
        rationale:
          `A recorded ${clash.kind} names this food. It is not a safety ` +
          "problem, but the plan is unlikely to be followed as written.",
        derivedFrom: `recorded ${clash.kind}: ${clash.label}`,
        severity: "info",
        ruleLabel: rule.label,
      });
      continue;
    }

    suggestions.push({
      kind: "carry_forward",
      isDraft: true,
      title: rule.label,
      rationale: `Carried forward unchanged from ${template.templateName} v${template.versionNumber}.`,
      derivedFrom: `${template.templateName} v${template.versionNumber}`,
      severity: "info",
      ruleLabel: rule.label,
    });
  }

  if (template.requiresPractitionerReview) {
    suggestions.push({
      kind: "review_required",
      isDraft: true,
      title: "This template requires practitioner review",
      rationale:
        "The source template is marked as requiring review, so this draft " +
        "cannot become a patient plan without one.",
      derivedFrom: `${template.templateName} v${template.versionNumber}`,
      severity: "attention",
    });
  }

  return { suggestions, provenanceKind: "copilot_draft", disclaimer: DISCLAIMER };
}

/** Whole-word-ish containment either way, so "milk" matches "Milk and yoghurt". */
function matches(ruleLabel: string, constraintLabel: string): boolean {
  const a = ruleLabel.toLowerCase();
  const b = constraintLabel.toLowerCase().trim();
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}
