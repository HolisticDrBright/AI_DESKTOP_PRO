import type { Tone } from "./types";

/**
 * MOCK N-of-1 experiment data. Synthetic only; shaped like a future
 * `api.experiments.*` tRPC namespace. Conclusions use ONLY the cautious
 * vocabulary; results describe observed change, never causation, and launch
 * requires practitioner approval.
 */

export type ExperimentConclusion =
  | "Likely beneficial"
  | "Possibly beneficial"
  | "No measurable effect"
  | "Possibly harmful"
  | "Inconclusive";

export const EXP_CONCLUSION_TONE: Record<ExperimentConclusion, Tone> = {
  "Likely beneficial": "positive",
  "Possibly beneficial": "teal",
  "No measurable effect": "slate",
  "Possibly harmful": "critical",
  Inconclusive: "warning",
};

export type ExperimentDesign =
  | "Before-and-after"
  | "Withdrawal and rechallenge"
  | "Alternating treatment"
  | "Randomized crossover"
  | "Custom design";

export const DESIGNS: { id: ExperimentDesign; blurb: string }[] = [
  { id: "Before-and-after", blurb: "Baseline window, then intervention window. Simplest; most confounder-prone." },
  { id: "Withdrawal and rechallenge", blurb: "On → off → on. Helps separate the intervention from background drift." },
  { id: "Alternating treatment", blurb: "Alternate on/off blocks on a schedule." },
  { id: "Randomized crossover", blurb: "Randomized block order; strongest single-patient design." },
  { id: "Custom design", blurb: "Define your own phase structure." },
];

export interface ActiveExperimentCard {
  id: string;
  hypothesis: string;
  intervention: string;
  design: ExperimentDesign;
  phase: string;
  day: string;
  completionPct: number;
  primaryOutcome: string;
  direction: string;
  confounders: string[];
  safety: "No concerns" | "Monitor" | "Review";
  review: "Approved" | "Awaiting approval";
}

export interface CompletedExperimentResult {
  id: string;
  hypothesis: string;
  intervention: string;
  design: ExperimentDesign;
  window: string;
  primaryOutcome: string;
  baseline: string;
  interventionValue: string;
  absoluteChange: string;
  relativeChange: string;
  completenessPct: number;
  adherencePct: number;
  confounders: string[];
  adverseEvents: string[];
  interpretation: string;
  conclusion: ExperimentConclusion;
}

export interface BuilderStepDef {
  n: number;
  title: string;
  hint: string;
}

export const BUILDER_STEPS: BuilderStepDef[] = [
  { n: 1, title: "Define goal", hint: "What the patient wants to improve, in their words." },
  { n: 2, title: "Define hypothesis", hint: "One sentence: intervention → expected observable change." },
  { n: 3, title: "Choose ONE primary intervention", hint: "Single variable — multiple changes make results unreadable." },
  { n: 4, title: "Baseline duration", hint: "Long enough to capture normal variation (typically 7–14 days)." },
  { n: 5, title: "Intervention duration", hint: "Long enough for a plausible response window." },
  { n: 6, title: "Primary + secondary outcomes", hint: "One primary metric; secondaries are exploratory." },
  { n: 7, title: "Variables to keep stable", hint: "Sleep schedule, caffeine, training load…" },
  { n: 8, title: "Confounders", hint: "What else could move the outcome during the window." },
  { n: 9, title: "Stopping rules", hint: "Symptoms or thresholds that end the experiment early." },
  { n: 10, title: "Review design", hint: "Check the design against the goal before approval." },
  { n: 11, title: "Practitioner approval", hint: "Required before launch — nothing starts without it." },
  { n: 12, title: "Launch", hint: "Begins baseline tracking (demo — not persisted)." },
];

export function getActiveExperiments(): ActiveExperimentCard[] {
  return [
    {
      id: "e1",
      hypothesis: "Morning light exposure improves deep sleep",
      intervention: "10 min outdoor light within 30 min of waking",
      design: "Before-and-after",
      phase: "Intervention",
      day: "Day 7 of 14",
      completionPct: 50,
      primaryOutcome: "Deep sleep (min/night)",
      direction: "↑ 18% vs baseline",
      confounders: ["Magnesium started in same window", "Seasonal daylight increase"],
      safety: "No concerns",
      review: "Approved",
    },
    {
      id: "e2",
      hypothesis: "Magnesium glycinate reduces muscle tension",
      intervention: "Magnesium glycinate 240 mg (evening)",
      design: "Before-and-after",
      phase: "Intervention",
      day: "Day 5 of 21",
      completionPct: 24,
      primaryOutcome: "Muscle tension (self-rated 0–10)",
      direction: "↓ 22% vs baseline",
      confounders: ["Concurrent light experiment"],
      safety: "No concerns",
      review: "Approved",
    },
  ];
}

export function getCompletedExperiments(): CompletedExperimentResult[] {
  return [
    {
      id: "c1",
      hypothesis: "Evening screen curfew shortens sleep latency",
      intervention: "No screens after 21:30",
      design: "Withdrawal and rechallenge",
      window: "Apr 7 – May 19 (6 weeks)",
      primaryOutcome: "Sleep latency (min)",
      baseline: "34 min",
      interventionValue: "26 min",
      absoluteChange: "−8 min",
      relativeChange: "−24%",
      completenessPct: 88,
      adherencePct: 71,
      confounders: ["Work travel week 3", "Seasonal daylight increase"],
      adverseEvents: [],
      interpretation:
        "Latency fell during both on-blocks and partially rebounded during withdrawal, consistent with a real association. Imperfect adherence (71%) and seasonal change temper the strength of the read. Observed change only — not a causal claim.",
      conclusion: "Possibly beneficial",
    },
    {
      id: "c2",
      hypothesis: "Afternoon caffeine cutoff improves HRV",
      intervention: "No caffeine after 12:00",
      design: "Before-and-after",
      window: "Mar 3 – Mar 31 (4 weeks)",
      primaryOutcome: "Overnight HRV (ms)",
      baseline: "61 ms",
      interventionValue: "62 ms",
      absoluteChange: "+1 ms",
      relativeChange: "+1.6%",
      completenessPct: 94,
      adherencePct: 89,
      confounders: ["None identified"],
      adverseEvents: ["Mild afternoon headaches, week 1 (resolved)"],
      interpretation:
        "Change is within normal night-to-night variation. Good adherence and data completeness make this a fair read.",
      conclusion: "No measurable effect",
    },
  ];
}
