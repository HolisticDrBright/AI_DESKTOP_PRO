import type { ComposerDraft, DraftKind } from "./types";

/**
 * MOCK draft generation for the note/report composer.
 *
 * There is **no language model and no persistence here** — `generateDraft`
 * returns deterministic, clearly-templated text so the composer UX can be
 * exercised end to end. It is the isolated boundary a real generation call
 * (`api.composer.generate`, server-side, with the model behind it) will
 * replace. Every draft comes back un-finalized (`review: "not-reviewed"`);
 * approval is an explicit practitioner step in the UI, never automatic.
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

const KIND_META = Object.fromEntries(DRAFT_KINDS.map((d) => [d.kind, d])) as Record<
  DraftKind,
  DraftKindMeta
>;

function seedLines(ctx: ComposerContext): string {
  if (!ctx.seeds?.length) return "";
  return "\n" + ctx.seeds.map((s) => `  • ${s}`).join("\n");
}

/** Per-kind mock body templates. Deterministic; obviously a draft. */
function body(kind: DraftKind, ctx: ComposerContext): string {
  const p = ctx.patientName;
  const subj = ctx.subjectLabel;
  switch (kind) {
    case "soap-note":
      return [
        `Subjective`,
        `${p} — context for "${subj}". Reason for review and reported symptoms to be confirmed with the patient.${seedLines(ctx)}`,
        ``,
        `Objective`,
        `Relevant measured data and lab values referenced below under Sources.`,
        ``,
        `Assessment`,
        `Working consideration: ${subj}. Reflects internal evidence weighting, not a diagnosis.`,
        ``,
        `Plan`,
        `Proposed next steps pending practitioner review.`,
      ].join("\n");
    case "reasoning-summary":
      return [
        `Clinical reasoning — ${p}`,
        ``,
        `The leading consideration is ${subj}, supported by the evidence listed under Sources.${seedLines(ctx)}`,
        ``,
        `This is an internal reasoning summary, not a diagnosis or a probability. Confirm with the patient and correlate clinically before acting.`,
      ].join("\n");
    case "lab-summary":
      return [
        `Lab summary — ${p}`,
        ``,
        `Summary of the most recent panel relevant to ${subj}. Values and reference ranges are drawn from the linked source records.${seedLines(ctx)}`,
        ``,
        `Out-of-range results are flagged for practitioner review; none are auto-communicated to the patient.`,
      ].join("\n");
    case "supplement-rationale":
      return [
        `Supplement rationale — ${p}`,
        ``,
        `Rationale for the items associated with ${subj}. Each entry ties to a measured or reported finding.${seedLines(ctx)}`,
        ``,
        `Dosing and interactions to be confirmed by the practitioner before sharing.`,
      ].join("\n");
    case "nof1-interpretation":
      return [
        `N-of-1 interpretation — ${p}`,
        ``,
        `Interpretation of the experiment relating to ${subj}. Effect direction and magnitude are descriptive of the observed data only.${seedLines(ctx)}`,
        ``,
        `Result strength reflects the observed change, not a medical probability.`,
      ].join("\n");
    case "referral":
      return [
        `Referral — regarding ${p}`,
        ``,
        `Dear colleague,`,
        `I am referring ${p} for evaluation in the context of ${subj}. A summary of relevant findings is enclosed.${seedLines(ctx)}`,
        ``,
        `Please find attached the supporting records. Kind regards,`,
      ].join("\n");
    case "patient-followup":
      return [
        `Hi ${p.split(" ")[0]},`,
        ``,
        `Here is a recap of what we looked at regarding ${subj}, in plain language.${seedLines(ctx)}`,
        ``,
        `Nothing here changes your plan until we've talked it through. — Your care team`,
      ].join("\n");
    case "patient-message":
      return [
        `Hi ${p.split(" ")[0]}, a quick note about ${subj}.`,
        ``,
        `${ctx.seeds?.[0] ?? "Details to confirm."} We'll cover the specifics at your next check-in.`,
      ].join("\n");
    default:
      return `Draft regarding ${subj} for ${p}.`;
  }
}

export async function generateDraft(
  kind: DraftKind,
  ctx: ComposerContext,
): Promise<ComposerDraft> {
  const meta = KIND_META[kind];
  return {
    kind,
    title: `${meta.label} — ${ctx.subjectLabel}`,
    body: body(kind, ctx),
    sources: ctx.seeds?.length
      ? ["Linked from " + ctx.subjectType + ": " + ctx.subjectLabel]
      : ["No source records linked yet"],
    dateRange: "Last 30 days",
    missingInfo: meta.patientFacing
      ? ["Practitioner review required before this reaches the patient"]
      : ["Confirm findings against the source records before finalizing"],
    review: "not-reviewed",
    patientFacing: meta.patientFacing,
  };
}
