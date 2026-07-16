import type { ProvenanceData, Tone } from "./types";

/**
 * MOCK Health Twin system map. Synthetic only; shaped like a future
 * `api.healthTwin.getMap` tRPC query. Status is a labelled band (never color
 * alone); completeness is data coverage, not certainty. Snapshots power the
 * state-replay control.
 */

export type SystemStatus = "supported" | "stable" | "strained" | "attention";

export const SYSTEM_STATUS_META: Record<SystemStatus, { label: string; tone: Tone }> = {
  supported: { label: "Supported", tone: "positive" },
  stable: { label: "Stable", tone: "slate" },
  strained: { label: "Strained", tone: "warning" },
  attention: { label: "Needs attention", tone: "critical" },
};

export interface TwinSystemNode {
  id: string;
  name: string;
  status: SystemStatus;
  trend: "improving" | "stable" | "worsening";
  /** 0–100 data completeness (coverage, not certainty). */
  completeness: number;
  observations: number;
  contradictions: number;
  lastUpdate: string;
}

export interface TwinSystemDetail {
  facts: string[];
  biomarkers: { name: string; value: string; note: string }[];
  symptoms: string[];
  contributing: string[];
  interventions: string[];
  historicalResponse: string[];
  missingInformation: string[];
  activeHypotheses: string[];
  practitionerComments: string[];
  provenance: ProvenanceData;
}

export interface TwinSnapshot {
  date: string;
  nodes: TwinSystemNode[];
}

export interface HealthTwinData {
  patientId: string;
  snapshots: TwinSnapshot[];
  details: Record<string, TwinSystemDetail>;
}

const BASE: Omit<TwinSystemNode, "status" | "trend">[] = [
  { id: "metabolic", name: "Metabolic", completeness: 82, observations: 24, contradictions: 0, lastUpdate: "Jul 12" },
  { id: "cardiovascular", name: "Cardiovascular", completeness: 74, observations: 18, contradictions: 0, lastUpdate: "Jul 12" },
  { id: "inflammation", name: "Inflammation & immune", completeness: 78, observations: 21, contradictions: 1, lastUpdate: "Jul 12" },
  { id: "hormonal", name: "Hormonal", completeness: 55, observations: 12, contradictions: 1, lastUpdate: "Jul 11" },
  { id: "gi", name: "Gastrointestinal", completeness: 48, observations: 9, contradictions: 0, lastUpdate: "Jun 28" },
  { id: "detox", name: "Detoxification & exposure", completeness: 36, observations: 6, contradictions: 0, lastUpdate: "Jun 12" },
  { id: "mito", name: "Mitochondrial & energy", completeness: 41, observations: 11, contradictions: 0, lastUpdate: "Jul 10" },
  { id: "cognitive", name: "Cognitive & neurological", completeness: 44, observations: 8, contradictions: 0, lastUpdate: "Jul 2" },
  { id: "msk", name: "Musculoskeletal", completeness: 52, observations: 7, contradictions: 0, lastUpdate: "Jun 20" },
  { id: "stress", name: "Stress & autonomic", completeness: 71, observations: 19, contradictions: 1, lastUpdate: "Jul 11" },
  { id: "sleep", name: "Sleep & circadian", completeness: 86, observations: 30, contradictions: 0, lastUpdate: "Jul 12" },
  { id: "aging", name: "Healthy aging", completeness: 39, observations: 5, contradictions: 0, lastUpdate: "May 30" },
];

/** status/trend per system per snapshot date (oldest → newest). */
const TIMELINE: Record<string, [SystemStatus, TwinSystemNode["trend"]][]> = {
  metabolic:      [["stable", "stable"], ["stable", "stable"], ["supported", "improving"], ["supported", "improving"]],
  cardiovascular: [["strained", "stable"], ["stable", "improving"], ["stable", "improving"], ["supported", "improving"]],
  inflammation:   [["attention", "worsening"], ["strained", "stable"], ["strained", "improving"], ["strained", "improving"]],
  hormonal:       [["strained", "stable"], ["strained", "worsening"], ["attention", "worsening"], ["attention", "stable"]],
  gi:             [["stable", "stable"], ["stable", "stable"], ["stable", "stable"], ["stable", "stable"]],
  detox:          [["stable", "stable"], ["stable", "stable"], ["stable", "stable"], ["stable", "stable"]],
  mito:           [["strained", "stable"], ["strained", "stable"], ["strained", "improving"], ["strained", "improving"]],
  cognitive:      [["stable", "stable"], ["stable", "stable"], ["stable", "stable"], ["stable", "stable"]],
  msk:            [["stable", "stable"], ["stable", "stable"], ["stable", "stable"], ["stable", "stable"]],
  stress:         [["attention", "worsening"], ["attention", "stable"], ["strained", "improving"], ["strained", "stable"]],
  sleep:          [["strained", "stable"], ["strained", "improving"], ["stable", "improving"], ["supported", "improving"]],
  aging:          [["stable", "stable"], ["stable", "stable"], ["stable", "stable"], ["stable", "stable"]],
};

const DATES = ["Apr 14", "May 13", "Jun 24", "Jul 12"];

export function getHealthTwin(patientId: string): HealthTwinData {
  const snapshots: TwinSnapshot[] = DATES.map((date, i) => ({
    date,
    nodes: BASE.map((b) => ({
      ...b,
      status: TIMELINE[b.id][i][0],
      trend: TIMELINE[b.id][i][1],
      // Older snapshots had less data.
      completeness: Math.max(10, b.completeness - (DATES.length - 1 - i) * 8),
      observations: Math.max(1, b.observations - (DATES.length - 1 - i) * 4),
    })),
  }));

  const details: Record<string, TwinSystemDetail> = {
    inflammation: {
      facts: ["hs-CRP 2.8 mg/L, improving across 3 draws", "No infection signs reported"],
      biomarkers: [
        { name: "hs-CRP", value: "2.8 mg/L", note: "above practice optimal (<1.0), improving" },
        { name: "Omega-3 Index", value: "6.2%", note: "below optimal (8–12%), rising" },
      ],
      symptoms: ["Fatigue 6/10 average", "Post-exertion heaviness (occasional)"],
      contributing: ["Low omega-3 status", "Sleep debt (resolving)", "Vitamin D insufficiency (repleting)"],
      interventions: ["Omega-3 3 g/day", "Vitamin D repletion", "Anti-inflammatory dietary pattern"],
      historicalResponse: ["hs-CRP 3.6 → 2.8 mg/L over 12 weeks alongside omega-3 titration (association, not causation)"],
      missingInformation: ["Dietary inflammation log (2 weeks)", "Repeat hs-CRP post-titration"],
      activeHypotheses: ["Inflammatory burden (wt 82)"],
      practitionerComments: ["Watching CRP trend before adding interventions (SM, Jun 12)"],
      provenance: { sourceType: "measured", sourceName: "Quest panel · May 13 + wearables", dateRange: "90 days", lastUpdated: "Jul 12, 2026", confidence: 78, conflicts: 1, review: "awaiting-review" },
    },
    sleep: {
      facts: ["Sleep score 72 (good), 30-day trend up", "Deep sleep +18% during light experiment"],
      biomarkers: [
        { name: "Sleep efficiency", value: "72%", note: "below 85% target" },
        { name: "HRV (avg)", value: "68 ms", note: "improving" },
      ],
      symptoms: ["Evening wakefulness 3×/week (new)"],
      contributing: ["Elevated AM cortisol", "Evening screen exposure"],
      interventions: ["Morning light 10 min", "Magnesium glycinate (evening)"],
      historicalResponse: ["Sleep score 64 → 72 over 8 weeks with light + magnesium (association)"],
      missingInformation: ["Sleep-study data to rule out apnea"],
      activeHypotheses: ["Cortisol dysregulation (wt 74)"],
      practitionerComments: [],
      provenance: { sourceType: "measured", sourceName: "Oura · 30 d", dateRange: "30 days", lastUpdated: "Jul 12, 2026", confidence: 86, review: "awaiting-review" },
    },
    hormonal: {
      facts: ["AM cortisol 21.3 µg/dL — above lab range (single collection)"],
      biomarkers: [
        { name: "Cortisol AM", value: "21.3 µg/dL", note: "single collection — confirm" },
        { name: "TSH / fT3 / fT4", value: "normal", note: "thyroid panel unremarkable" },
      ],
      symptoms: ["Evening wakefulness", "Stress 24/40 (PSS-10)"],
      contributing: ["Work stress load", "Evening screen exposure"],
      interventions: ["Breathwork (assigned)", "Ashwagandha (adherence 61%)"],
      historicalResponse: ["No measurable cortisol change on ashwagandha at current adherence"],
      missingInformation: ["Repeat AM cortisol", "4-point diurnal curve"],
      activeHypotheses: ["Cortisol dysregulation (wt 74)"],
      practitionerComments: [],
      provenance: { sourceType: "measured", sourceName: "Salivary cortisol · May 13", dateRange: "Single collection", lastUpdated: "Jul 11, 2026", confidence: 62, conflicts: 1, review: "awaiting-review" },
    },
  };

  // Default detail for systems without a rich record yet — honest about sparsity.
  for (const b of BASE) {
    if (!details[b.id]) {
      details[b.id] = {
        facts: ["No abnormal findings recorded in the current window"],
        biomarkers: [],
        symptoms: [],
        contributing: [],
        interventions: [],
        historicalResponse: [],
        missingInformation: [`Coverage is ${b.completeness}% — add data sources to strengthen this system's picture`],
        activeHypotheses: [],
        practitionerComments: [],
        provenance: { sourceType: "measured", sourceName: "Aggregated records", dateRange: "90 days", lastUpdated: b.lastUpdate + ", 2026", confidence: b.completeness, review: "awaiting-review" },
      };
    }
  }

  return { patientId, snapshots, details };
}
