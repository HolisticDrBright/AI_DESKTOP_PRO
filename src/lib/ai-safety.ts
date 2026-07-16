/**
 * AI / clinical-decision-support safety classification registry.
 *
 * A plain-language inventory of every place the product uses AI or automated
 * reasoning, and how it is governed. It deliberately makes **no** regulatory
 * claims — the product is not described as HIPAA compliant, FDA cleared, SOC 2
 * certified, or clinically validated anywhere in this data. Each entry states
 * what the feature does, who uses it, whether it is patient-facing, and the
 * review + audit requirements that keep a human in the loop.
 */

export type ActionVerb =
  | "recommends"
  | "drafts"
  | "summarizes"
  | "ranks"
  | "explains"
  | "detects";

export type Determinism = "Deterministic" | "AI" | "Hybrid";
export type RiskLevel = "Low" | "Moderate" | "High";
export type ReviewRequirement =
  | "Practitioner review required"
  | "Review recommended"
  | "Informational only";

export interface AiFeatureClassification {
  feature: string;
  roles: string[];
  patientFacing: boolean;
  inputs: string[];
  outputType: string;
  actionVerb: ActionVerb;
  determinism: Determinism;
  risk: RiskLevel;
  review: ReviewRequirement;
  audited: boolean;
  /** In-product disclaimer shown near the feature's output. */
  disclaimer: string;
}

export const AI_FEATURES: AiFeatureClassification[] = [
  {
    feature: "Clinical Reasoning Snapshot",
    roles: ["Practitioner"],
    patientFacing: false,
    inputs: ["Measured labs", "Wearable data", "Patient-reported symptoms"],
    outputType: "Ranked hypotheses with evidence weighting",
    actionVerb: "ranks",
    determinism: "AI",
    risk: "High",
    review: "Practitioner review required",
    audited: true,
    disclaimer:
      "Evidence weighting is internal, not a medical probability or diagnosis. For practitioner review.",
  },
  {
    feature: "Lab panel recommendation",
    roles: ["Practitioner"],
    patientFacing: false,
    inputs: ["Reasoning hypotheses", "Prior labs", "Patient goals", "Active protocols"],
    outputType: "Suggested lab panels with reason + provenance (draft order only)",
    actionVerb: "recommends",
    determinism: "Hybrid",
    risk: "Moderate",
    review: "Practitioner review required",
    audited: true,
    disclaimer:
      "Suggestions are not orders. No lab order is submitted; clinical indication and patient consent are required before ordering.",
  },
  {
    feature: "Clinical Assistant (Q&A)",
    roles: ["Practitioner"],
    patientFacing: false,
    inputs: ["Patient record", "Labs", "Notes"],
    outputType: "Narrative answer with cited sources",
    actionVerb: "explains",
    determinism: "AI",
    risk: "Moderate",
    review: "Review recommended",
    audited: true,
    disclaimer: "Assistant answers cite their sources and require practitioner judgment.",
  },
  {
    feature: "Note & report composer",
    roles: ["Practitioner"],
    patientFacing: true,
    inputs: ["Selected record context", "Practitioner prompt"],
    outputType: "Editable draft (note, report, patient message)",
    actionVerb: "drafts",
    determinism: "AI",
    risk: "High",
    review: "Practitioner review required",
    audited: true,
    disclaimer:
      "Drafts are never final and never sent automatically. Patient-facing drafts require explicit approval.",
  },
  {
    feature: "Provenance & confidence scoring",
    roles: ["Practitioner"],
    patientFacing: false,
    inputs: ["Source metadata", "Data completeness"],
    outputType: "Source label + completeness percentage",
    actionVerb: "summarizes",
    determinism: "Deterministic",
    risk: "Low",
    review: "Informational only",
    audited: false,
    disclaimer: "Completeness reflects data coverage, not clinical certainty.",
  },
  {
    feature: "N-of-1 experiment interpretation",
    roles: ["Practitioner"],
    patientFacing: false,
    inputs: ["Experiment measurements", "Baseline"],
    outputType: "Effect-direction read-out",
    actionVerb: "summarizes",
    determinism: "Hybrid",
    risk: "Moderate",
    review: "Practitioner review required",
    audited: true,
    disclaimer: "Describes observed change only; not a claim of causation or efficacy.",
  },
  {
    feature: "Risk flags",
    roles: ["Practitioner"],
    patientFacing: false,
    inputs: ["Measured labs", "Reference ranges"],
    outputType: "Out-of-range flags with monitor/review action",
    actionVerb: "detects",
    determinism: "Deterministic",
    risk: "Moderate",
    review: "Review recommended",
    audited: true,
    disclaimer: "Flags compare values to reference ranges; they are not diagnoses.",
  },
  {
    feature: "Supplement rationale",
    roles: ["Practitioner"],
    patientFacing: true,
    inputs: ["Protocol", "Linked findings"],
    outputType: "Editable rationale draft",
    actionVerb: "drafts",
    determinism: "AI",
    risk: "Moderate",
    review: "Practitioner review required",
    audited: true,
    disclaimer: "Dosing and interactions must be confirmed by the practitioner before sharing.",
  },
  {
    feature: "Import field detection & matching",
    roles: ["Practitioner", "Admin"],
    patientFacing: false,
    inputs: ["Uploaded export files"],
    outputType: "Field mappings + duplicate-match suggestions",
    actionVerb: "detects",
    determinism: "Hybrid",
    risk: "Moderate",
    review: "Practitioner review required",
    audited: true,
    disclaimer: "Every matched record is queued for review; nothing is inserted automatically.",
  },
];
