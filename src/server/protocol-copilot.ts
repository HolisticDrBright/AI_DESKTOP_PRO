if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

/**
 * The protocol copilot boundary (server-only).
 *
 * DRAFT ONLY, and disabled unless an operator turns it on. Every suggestion is
 * assembled from records that already exist in this system: an approved
 * protocol template version, the patient's recorded medications and allergies,
 * and governed intervention classes. There is no model behind it and no
 * outbound call, which is deliberate — a fluent invented dose is
 * indistinguishable from a real one on screen, and a protocol is the worst
 * possible place to discover that.
 *
 * What it cannot do, STRUCTURALLY rather than by policy:
 *
 *   - it cannot write. This module makes no database call and imports no
 *     adapter, so a suggestion only becomes real when a practitioner saves it
 *     through the ordinary RPC path;
 *   - it cannot approve, activate, order, send, charge, or add to a cart. No
 *     function here has any of those shapes, and it has no access to a path
 *     that does;
 *   - it cannot invent a dose. `proposedDose` is only ever copied from a source
 *     that is named in `doseSource`, and an item whose source carries no dose
 *     is emitted with a null dose and a `dose_unavailable` suggestion. It is
 *     not filled in with something plausible;
 *   - it cannot manufacture an interaction finding. Where no governed
 *     interaction reference is loaded it reports that the review was not
 *     completed and names what is missing;
 *   - it cannot favour an affiliate product, because COMMERCIAL DATA IS NOT AN
 *     INPUT TO THIS MODULE. There is no field on `CopilotProtocolInput` that
 *     can carry a price, a commission, a supplier or a link. Ranking cannot be
 *     influenced by information the function never receives.
 *
 * Ordering is by clinical position from the source template, never by anything
 * resembling commercial value. There is no scoring function here at all.
 */

export interface ProtocolCopilotConfigReport {
  enabled: boolean;
  /** Operator-facing reasons, never secrets. */
  problems: string[];
}

const ENABLE_FLAG = "PROTOCOL_COPILOT_ENABLED";

export function getProtocolCopilotConfig(): ProtocolCopilotConfigReport {
  const raw = (process.env[ENABLE_FLAG] ?? "").trim().toLowerCase();
  const enabled = raw === "1" || raw === "true";
  return {
    enabled,
    problems: enabled
      ? []
      : [`${ENABLE_FLAG} is not set — the protocol copilot is disabled.`],
  };
}

export class ProtocolCopilotDisabledError extends Error {
  readonly code = "not_configured";
  readonly problems: string[];
  constructor(problems: string[]) {
    super("The protocol copilot is disabled.");
    this.name = "ProtocolCopilotDisabledError";
    this.problems = problems;
  }
}

/* ------------------------------------------------------------- contract */

/** Where a dose came from. There is no fourth option, and no default. */
export type DoseSourceKind =
  | "product_label"
  | "practitioner_protocol"
  | "governed_reference";

export interface CopilotTemplateItem {
  position: number;
  kind: "product" | "diet" | "lifestyle" | "monitoring" | "followup";
  label: string;
  /** Null unless the source actually stated one. Never inferred. */
  dosageText: string | null;
  doseSourceKind: DoseSourceKind | null;
  doseSourceRef: string | null;
  catalogProductVersionId: string | null;
  /** Verification state of the exact product, as recorded. */
  verificationStatus: string | null;
  interventionClassCode: string | null;
}

export interface CopilotInterventionClass {
  code: string;
  name: string;
  jurisdictionSensitive: boolean;
  monitoringRequirements: string[];
  stoppingRules: string[];
  contraindications: string[];
}

export interface CopilotPatientRecord {
  /** Recorded allergies. An empty list means "none recorded", not "none". */
  allergies: string[];
  /** Recorded active medications. Same caveat. */
  medications: string[];
  /** True when at least one medication carries a coded identifier. */
  medicationsHaveCodedIdentifiers: boolean;
}

export interface CopilotProtocolInput {
  templateName: string;
  templateVersion: number;
  items: CopilotTemplateItem[];
  interventionClasses: CopilotInterventionClass[];
  patient: CopilotPatientRecord;
  /** True only when a governed interaction reference is actually loaded. */
  governedInteractionReferenceLoaded: boolean;
}

export type ProtocolSuggestionKind =
  | "carry_forward"
  | "dose_unavailable"
  | "unverified_product"
  | "allergy_conflict"
  | "monitoring_required"
  | "stopping_rule"
  | "jurisdiction_review"
  | "interaction_not_completed"
  | "missing_assessment";

export interface ProtocolSuggestion {
  kind: ProtocolSuggestionKind;
  /** Always true. There is no non-draft output from this module. */
  isDraft: true;
  title: string;
  rationale: string;
  /** The recorded input this came from — never an unattributed claim. */
  derivedFrom: string;
  severity: "info" | "attention";
  itemLabel?: string;
  /** Only ever copied from a named source. Null when the source has none. */
  proposedDose?: string | null;
  doseSource?: string | null;
}

export interface ProtocolCopilotDraft {
  suggestions: ProtocolSuggestion[];
  provenanceKind: "copilot_draft";
  /** Repeated on the payload so no UI can render this as a finished protocol. */
  disclaimer: string;
  /** Stated on every draft, so the absence of findings is never read as safety. */
  interactionReviewState: "not_completed";
  interactionReviewReason: string;
}

const DISCLAIMER =
  "Draft suggestions assembled from this organisation's approved template and " +
  "this patient's recorded medications and allergies. Nothing here has been " +
  "reviewed, nothing is saved, no product has been ordered and nothing is " +
  "advice until a practitioner edits, approves and activates a protocol.";

/**
 * Assemble a draft protocol from an approved template and a patient record.
 *
 * Deterministic: the same inputs give the same suggestions in the same order,
 * which is what makes the output reviewable rather than merely plausible.
 */
export function draftProtocolFromTemplate(
  input: CopilotProtocolInput,
): ProtocolCopilotDraft {
  const config = getProtocolCopilotConfig();
  if (!config.enabled) throw new ProtocolCopilotDisabledError(config.problems);

  const suggestions: ProtocolSuggestion[] = [];
  const { templateName, templateVersion, patient } = input;
  const source = `${templateName} v${templateVersion}`;
  const classes = new Map(input.interventionClasses.map((c) => [c.code, c]));

  if (patient.allergies.length === 0) {
    suggestions.push({
      kind: "missing_assessment",
      isDraft: true,
      title: "No allergies are recorded for this patient",
      rationale:
        "An empty allergy list is not the same as no allergies. This draft " +
        "could not be checked against one, and must not be read as though it " +
        "had been.",
      derivedFrom: "the patient's allergy list, which is empty",
      severity: "attention",
    });
  }

  // Clinical position order, from the template. Never a commercial ranking —
  // there is no commercial input to rank by.
  const items = [...input.items].sort((a, b) => a.position - b.position);

  for (const item of items) {
    const allergyHit = patient.allergies.find((a) => matches(item.label, a));
    if (allergyHit) {
      // Raised, never removed. A silent removal hides the conflict.
      suggestions.push({
        kind: "allergy_conflict",
        isDraft: true,
        title: `"${item.label}" conflicts with a recorded allergy`,
        rationale:
          "The template includes this item and a recorded allergy names it. " +
          "It is left in the draft deliberately so you decide what happens to " +
          "it — it is not removed behind your back.",
        derivedFrom: `recorded allergy: ${allergyHit}`,
        severity: "attention",
        itemLabel: item.label,
      });
    }

    if (item.kind === "product") {
      if (item.dosageText && item.doseSourceKind) {
        suggestions.push({
          kind: "carry_forward",
          isDraft: true,
          title: item.label,
          rationale: `Carried forward unchanged from ${source}.`,
          derivedFrom: source,
          severity: "info",
          itemLabel: item.label,
          proposedDose: item.dosageText,
          doseSource: describeDoseSource(item),
        });
      } else {
        // NEVER INVENT A DOSE.
        suggestions.push({
          kind: "dose_unavailable",
          isDraft: true,
          title: `No dose is recorded for "${item.label}"`,
          rationale:
            "A dose requires an exact product label, a supplied practitioner " +
            "protocol or a governed reference. None is recorded for this item, " +
            "so no dose is proposed. Enter one from the label you are working " +
            "from.",
          derivedFrom: source,
          severity: "attention",
          itemLabel: item.label,
          proposedDose: null,
          doseSource: null,
        });
      }

      if (item.verificationStatus && item.verificationStatus !== "verified") {
        suggestions.push({
          kind: "unverified_product",
          isDraft: true,
          title: `"${item.label}" is ${item.verificationStatus}`,
          rationale:
            "The exact product version behind this item is not verified. It " +
            "may still be correct; it has not been confirmed against a label.",
          derivedFrom: `catalog verification state: ${item.verificationStatus}`,
          severity: "attention",
          itemLabel: item.label,
        });
      }
    }

    const cls = item.interventionClassCode
      ? classes.get(item.interventionClassCode)
      : undefined;
    if (!cls) continue;

    for (const requirement of cls.monitoringRequirements) {
      suggestions.push({
        kind: "monitoring_required",
        isDraft: true,
        title: `Monitoring for ${cls.name}: ${requirement}`,
        rationale:
          "The governed intervention class for this item records this " +
          "monitoring requirement.",
        derivedFrom: `intervention class ${cls.code}`,
        severity: "attention",
        itemLabel: item.label,
      });
    }

    for (const rule of cls.stoppingRules) {
      suggestions.push({
        kind: "stopping_rule",
        isDraft: true,
        title: `Stop ${cls.name} if: ${rule}`,
        rationale:
          "The governed intervention class for this item records this stopping " +
          "rule. A protocol without stopping rules has no way to end badly on " +
          "purpose.",
        derivedFrom: `intervention class ${cls.code}`,
        severity: "attention",
        itemLabel: item.label,
      });
    }

    if (cls.jurisdictionSensitive) {
      suggestions.push({
        kind: "jurisdiction_review",
        isDraft: true,
        title: `${cls.name} is jurisdiction-sensitive`,
        rationale:
          "This class requires review against your own scope and jurisdiction. " +
          "This system makes NO determination that any intervention is legal " +
          "where you practise.",
        derivedFrom: `intervention class ${cls.code}`,
        severity: "attention",
        itemLabel: item.label,
      });
    }
  }

  // Interaction review is always reported as NOT COMPLETED by this module,
  // with the reason named. A copilot draft is not an interaction check, and an
  // empty findings list must never read as an all-clear.
  const interactionReviewReason = interactionReason(input);
  suggestions.push({
    kind: "interaction_not_completed",
    isDraft: true,
    title: "Interaction review not completed",
    rationale: interactionReviewReason,
    derivedFrom: "the recorded medication list and governed reference registry",
    severity: "attention",
  });

  return {
    suggestions,
    provenanceKind: "copilot_draft",
    disclaimer: DISCLAIMER,
    interactionReviewState: "not_completed",
    interactionReviewReason,
  };
}

function describeDoseSource(item: CopilotTemplateItem): string {
  const label: Record<DoseSourceKind, string> = {
    product_label: "an exact product label",
    practitioner_protocol: "a supplied practitioner protocol",
    governed_reference: "a governed reference",
  };
  const base = label[item.doseSourceKind as DoseSourceKind];
  return item.doseSourceRef ? `${base} (${item.doseSourceRef})` : base;
}

function interactionReason(input: CopilotProtocolInput): string {
  if (!input.governedInteractionReferenceLoaded) {
    return (
      "No governed interaction reference is loaded, so no interaction check " +
      "could run. This is not a finding that the protocol is interaction-free."
    );
  }
  if (input.patient.medications.length === 0) {
    return (
      "No active medications are recorded. That is not evidence the protocol " +
      "is interaction-free — it means there was nothing to check against."
    );
  }
  if (!input.patient.medicationsHaveCodedIdentifiers) {
    return (
      "Recorded medications carry no coded identifiers, so they cannot be " +
      "matched against an interaction reference by name alone."
    );
  }
  return (
    "A copilot draft does not perform interaction review. Run the protocol " +
    "interaction check on the saved draft before approving it."
  );
}

/** Whole-word-ish containment either way, so "nuts" matches "Mixed nuts blend". */
function matches(itemLabel: string, constraintLabel: string): boolean {
  const a = itemLabel.toLowerCase();
  const b = constraintLabel.toLowerCase().trim();
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}
