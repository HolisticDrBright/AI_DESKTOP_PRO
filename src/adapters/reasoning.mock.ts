import type { ProvenanceData, Tone } from "./types";

/**
 * MOCK clinical-reasoning workspace data. Synthetic only; shaped like a
 * future `api.reasoning.getWorkspace` tRPC query. Hypothesis review state
 * lives in the demo session store (key `hypo:<patientId>:<hypothesisId>`).
 * Strength is ALWAYS internal evidence weighting — never a probability.
 */

export type ReasoningSourceKind =
  | "labs"
  | "wearables"
  | "patient-reported"
  | "visit-notes"
  | "supplements"
  | "experiments"
  | "assessments";

export const SOURCE_FILTERS: { id: ReasoningSourceKind; label: string }[] = [
  { id: "labs", label: "Labs" },
  { id: "wearables", label: "Wearables" },
  { id: "patient-reported", label: "Patient-reported" },
  { id: "visit-notes", label: "Visit notes" },
  { id: "supplements", label: "Supplements" },
  { id: "experiments", label: "Experiments" },
  { id: "assessments", label: "Assessments" },
];

export interface TimelineEvent {
  id: string;
  date: string;
  source: ReasoningSourceKind;
  text: string;
}

export interface EvidenceItem {
  text: string;
  source: string;
  kind: ReasoningSourceKind;
}

export interface WorkspaceHypothesis {
  id: string;
  name: string;
  summary: string;
  /** Internal evidence weighting 0–100 — not a medical probability. */
  strength: number;
  status: "active" | "monitoring" | "resolved-candidate";
  lastChanged: string;
  evidenceFor: EvidenceItem[];
  evidenceAgainst: EvidenceItem[];
  contradictions: string[];
  missingInformation: string[];
  safetyConsiderations: string[];
  practitionerNotes: string[];
  provenance: ProvenanceData;
  seeds: string[];
}

export interface ReasoningWorkspaceData {
  patientId: string;
  updatedOn: string;
  dateRange: string;
  timeline: TimelineEvent[];
  whatChanged: { text: string; direction: "new" | "strengthened" | "weakened" | "resolved" }[];
  hypotheses: WorkspaceHypothesis[];
}

export const HYPOTHESIS_STATUS_META: Record<
  WorkspaceHypothesis["status"],
  { label: string; tone: Tone }
> = {
  active: { label: "Active", tone: "action" },
  monitoring: { label: "Monitoring", tone: "slate" },
  "resolved-candidate": { label: "Resolution candidate", tone: "positive" },
};

export function getReasoningWorkspace(patientId: string): ReasoningWorkspaceData {
  return {
    patientId,
    updatedOn: "Jul 12, 2026",
    dateRange: "Apr 14 – Jul 12, 2026 (90 days)",
    timeline: [
      { id: "t1", date: "Jul 12", source: "wearables", text: "Sleep efficiency dipped to 72% (7-day avg)" },
      { id: "t2", date: "Jul 11", source: "patient-reported", text: "Patient reports evening wakefulness, 3× this week" },
      { id: "t3", date: "Jul 8", source: "labs", text: "Vitamin D 24 ng/mL — rising on repletion" },
      { id: "t4", date: "Jun 30", source: "supplements", text: "Magnesium glycinate started (evening)" },
      { id: "t5", date: "Jun 24", source: "experiments", text: "Morning-light experiment day 7/14 — deep sleep +18%" },
      { id: "t6", date: "Jun 12", source: "visit-notes", text: "Visit: stress load discussed; breathwork assigned" },
      { id: "t7", date: "May 13", source: "labs", text: "Quest panel: hs-CRP 2.8, AM cortisol 21.3" },
      { id: "t8", date: "May 2", source: "assessments", text: "PSS-10 stress score 24/40 (moderate-high)" },
    ],
    whatChanged: [
      { text: "hs-CRP improved 3.0 → 2.8 mg/L", direction: "weakened" },
      { text: "Vitamin D rose 22 → 24 ng/mL on repletion", direction: "weakened" },
      { text: "New: evening wakefulness reported", direction: "new" },
      { text: "Deep sleep +18% during light experiment", direction: "strengthened" },
    ],
    hypotheses: [
      {
        id: "h1",
        name: "Inflammatory burden",
        summary: "Chronic low-grade inflammation contributing to fatigue and poor sleep quality.",
        strength: 82,
        status: "active",
        lastChanged: "Jul 12",
        evidenceFor: [
          { text: "Elevated hs-CRP (2.8 mg/L; optimal < 1.0)", source: "Quest panel · May 13", kind: "labs" },
          { text: "Poor sleep efficiency (72%)", source: "Oura · 30 d", kind: "wearables" },
          { text: "Low vitamin D (24 ng/mL)", source: "Quest panel · May 13", kind: "labs" },
          { text: "Fatigue rated 6/10 average", source: "Daily check-ins", kind: "patient-reported" },
        ],
        evidenceAgainst: [
          { text: "hs-CRP trending down 3 consecutive draws", source: "Lab history", kind: "labs" },
          { text: "No joint pain or morning stiffness", source: "Visit Jun 12", kind: "visit-notes" },
        ],
        contradictions: ["Energy improves on high-CRP days per check-ins (2 instances) — inconsistent with inflammatory fatigue"],
        missingInformation: ["Dietary inflammation log (last 2 weeks)", "Repeat hs-CRP after omega-3 titration"],
        safetyConsiderations: ["No red-flag symptoms; routine follow-up appropriate"],
        practitionerNotes: ["Jun 12 — watching CRP trend before adding interventions (SM)"],
        provenance: { sourceType: "ai-inference", sourceName: "Reasoning engine", dateRange: "Labs May 13 · wearables 30 d", lastUpdated: "Jul 12, 2026", confidence: 74, conflicts: 1, review: "awaiting-review" },
        seeds: ["Elevated hs-CRP (2.8 mg/L)", "Sleep efficiency 72%", "Vitamin D 24 ng/mL"],
      },
      {
        id: "h2",
        name: "Cortisol dysregulation",
        summary: "Elevated morning cortisol with evening wakefulness pattern.",
        strength: 74,
        status: "active",
        lastChanged: "Jul 11",
        evidenceFor: [
          { text: "High AM cortisol (21.3 µg/dL; lab 6.2–19.4)", source: "Salivary panel · May 13", kind: "labs" },
          { text: "Evening wakefulness 3×/week", source: "Patient check-ins", kind: "patient-reported" },
          { text: "PSS-10 stress 24/40", source: "Assessment · May 2", kind: "assessments" },
        ],
        evidenceAgainst: [
          { text: "HRV trend improving (+9% 30-day)", source: "Oura · 30 d", kind: "wearables" },
        ],
        contradictions: [],
        missingInformation: ["Repeat AM cortisol — single collection limits confidence", "4-point diurnal cortisol curve"],
        safetyConsiderations: ["Single sample — do not treat as a trend", "Screen sleep apnea if wakefulness persists"],
        practitionerNotes: [],
        provenance: { sourceType: "measured", sourceName: "Salivary cortisol · May 13", dateRange: "Single collection", lastUpdated: "Jul 11, 2026", confidence: 62, conflicts: 1, review: "awaiting-review" },
        seeds: ["AM cortisol 21.3 µg/dL", "Evening wakefulness 3×/week", "PSS-10 24/40"],
      },
      {
        id: "h3",
        name: "Mitochondrial under-recovery",
        summary: "Low energy pattern consistent with under-recovery; inferred from symptoms.",
        strength: 68,
        status: "monitoring",
        lastChanged: "Jun 24",
        evidenceFor: [
          { text: "Afternoon energy dips reported", source: "Daily check-ins", kind: "patient-reported" },
          { text: "Recovery score plateau (78%)", source: "Oura · 30 d", kind: "wearables" },
        ],
        evidenceAgainst: [
          { text: "Normal fasting glucose", source: "Quest panel · May 13", kind: "labs" },
          { text: "Deep sleep +18% in light experiment", source: "N-of-1 · Jun", kind: "experiments" },
        ],
        contradictions: [],
        missingInformation: ["Organic acids panel", "CoQ10 / carnitine status"],
        safetyConsiderations: [],
        practitionerNotes: [],
        provenance: { sourceType: "ai-inference", sourceName: "Inferred from symptom pattern", lastUpdated: "Jun 24, 2026", confidence: 41, review: "not-reviewed" },
        seeds: ["Afternoon energy dips", "Recovery plateau 78%"],
      },
      {
        id: "h4",
        name: "Vitamin D insufficiency resolving",
        summary: "Repletion under way; expect resolution at next recheck.",
        strength: 55,
        status: "resolved-candidate",
        lastChanged: "Jul 8",
        evidenceFor: [
          { text: "Vitamin D rising 18 → 24 ng/mL over 7 weeks", source: "Lab history", kind: "labs" },
          { text: "Supplement adherence 92%", source: "Supplement tracker", kind: "supplements" },
        ],
        evidenceAgainst: [],
        contradictions: [],
        missingInformation: ["Recheck 25-OH vitamin D at 8 weeks (due Jul 8 — schedule)"],
        safetyConsiderations: ["Confirm dose ceiling before extending repletion"],
        practitionerNotes: ["Repletion protocol on track (SM)"],
        provenance: { sourceType: "measured", sourceName: "Lab history · 3 draws", dateRange: "Mar – Jul", lastUpdated: "Jul 8, 2026", confidence: 86, review: "awaiting-review" },
        seeds: ["Vitamin D rising 18 → 24 ng/mL", "Adherence 92%"],
      },
    ],
  };
}
