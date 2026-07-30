import type { DraftKind } from "./types";

/**
 * Composer vocabulary (context shape + draft-kind metadata) shared by the
 * shell composer and, one day, a real generation backend. Extracted from the
 * mock so the runtime never imports fixtures.
 */

export interface ComposerContext {
  patientName: string;
  /** What the draft is about, e.g. "hypothesis", "lab result", "experiment". */
  subjectType: string;
  subjectLabel: string;
  /** Optional supporting facts to weave into the draft body. */
  seeds?: string[];
}

export interface DraftKindMeta {
  kind: DraftKind;
  label: string;
  /** Whether this draft would reach the patient (extra review gate). */
  patientFacing: boolean;
  blurb: string;
}

export const DRAFT_KINDS: DraftKindMeta[] = [
  { kind: "soap-note", label: "SOAP note", patientFacing: false, blurb: "Structured clinical note (S/O/A/P)." },
  { kind: "reasoning-summary", label: "Reasoning summary", patientFacing: false, blurb: "Narrative of the current clinical reasoning." },
  { kind: "lab-summary", label: "Lab summary", patientFacing: false, blurb: "Plain summary of the latest lab panel." },
  { kind: "supplement-rationale", label: "Supplement rationale", patientFacing: false, blurb: "Why each item is on the plan." },
  { kind: "nof1-interpretation", label: "N-of-1 interpretation", patientFacing: false, blurb: "Read-out of an experiment's result." },
  { kind: "referral", label: "Referral letter", patientFacing: false, blurb: "Letter to a referred provider." },
  { kind: "patient-followup", label: "Patient follow-up", patientFacing: true, blurb: "Friendly recap for the patient." },
  { kind: "patient-message", label: "Patient message", patientFacing: true, blurb: "Short direct message to the patient." },
];

