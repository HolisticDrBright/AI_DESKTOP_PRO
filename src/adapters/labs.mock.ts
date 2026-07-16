import type { ProvenanceData, ReviewState, Tone } from "./types";

/**
 * MOCK labs workspace data. Synthetic only. Shaped like a future
 * `api.labs.getWorkspace` tRPC query. Per-marker review state is NOT stored
 * here — it lives in the demo session store (key `lab:<patientId>:<markerId>`)
 * so the UI stays coherent across a session without faking persistence.
 *
 * Clinical rules encoded in the shape:
 *  - `labRange` is the laboratory's original reference interval and is never
 *    hidden or replaced.
 *  - `optimalRange` is the practice's configured optimal window, kept separate.
 *  - `confidence` is EXTRACTION/data confidence (0–100), never a medical
 *    probability.
 */

export type MarkerStatus =
  | "optimal"
  | "low"
  | "high"
  | "critical-low"
  | "critical-high"
  | "normal"
  /** Source recorded no flag — never assumed normal. */
  | "unknown";

export type MarkerTrendKind =
  | "improving"
  | "worsening"
  | "stable"
  | "newly-abnormal"
  | "needs-review";

/** "unknown" = the source recorded no confidence — shown as such, never as a number. */
export type ExtractionConfidenceBand = "high" | "medium" | "low" | "unknown";

export interface MarkerTrendPoint {
  date: string;
  value: number;
}

export interface OptimalRange {
  min?: number;
  max?: number;
  unit: string;
  source?: string;
}

export interface SourcePreview {
  reportName: string;
  location: string;
  snippet: string;
  confidenceNote: string;
  /** Live: the stored lab document behind this result (authorized download). */
  documentId?: string | null;
}

export interface BiomarkerMarker {
  id: string;
  name: string;
  unit: string;
  current: number;
  currentDisplay: string;
  prior?: number;
  priorDisplay?: string;
  changeDisplay?: string;
  changePct?: number;
  /** Laboratory reference interval — original, never hidden. */
  labRangeText: string;
  optimalRange: OptimalRange;
  status: MarkerStatus;
  trend: MarkerTrendKind;
  series: MarkerTrendPoint[];
  /** 0–100 EXTRACTION confidence (not medical certainty); null = not recorded. */
  confidence: number | null;
  confidenceBand: ExtractionConfidenceBand;
  reviewState: ReviewState;
  collectedAt: string;
  source: SourcePreview;
  provenance: ProvenanceData;
  relatedSystems: string[];
  relatedContext: string[];
  relatedHypotheses: string[];
  relatedProtocols: string[];
  seeds: string[];
}

export interface LabReport {
  id: string;
  name: string;
  lab: string;
  collectedAt: string;
  uploadedAt: string;
  markerCount: number;
}

export type LabQueueKind =
  | "new-report"
  | "extraction-review"
  | "low-confidence"
  | "abnormal"
  | "recheck";

export interface LabReviewQueueItem {
  id: string;
  kind: LabQueueKind;
  label: string;
  source: string;
  date: string;
  count: number;
  tone: Tone;
}

export interface LabWorkspace {
  patientId: string;
  patientName: string;
  lastUpload: string;
  lastSynced: string;
  reviewSummary: { reviewed: number; awaiting: number; lowConfidence: number; abnormal: number };
  reports: LabReport[];
  queue: LabReviewQueueItem[];
  markers: BiomarkerMarker[];
}

function series(vals: number[], startDay = 6): MarkerTrendPoint[] {
  return vals.map((value, i) => ({ date: `Day ${startDay - (vals.length - 1 - i)}`, value }));
}

const MARKERS: Omit<BiomarkerMarker, "id">[] = [
  {
    name: "hs-CRP",
    unit: "mg/L",
    current: 2.8, currentDisplay: "2.8", prior: 3.0, priorDisplay: "3.0",
    changeDisplay: "−0.2", changePct: -6.7,
    labRangeText: "< 3.0 (normal)",
    optimalRange: { max: 1.0, unit: "mg/L", source: "Practice optimal" },
    status: "high", trend: "improving",
    series: series([3.6, 3.4, 3.5, 3.1, 3.0, 2.9, 2.8]),
    confidence: 92, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 1 · Inflammation", snippet: "C-REACTIVE PROTEIN, CARDIAC  2.8 mg/L   Ref: <3.0", confidenceNote: "Clear labelled value and unit; high extraction confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 92 },
    relatedSystems: ["Inflammation", "Cardiovascular"],
    relatedContext: ["Fatigue", "Reduce inflammation (goal)"],
    relatedHypotheses: ["Inflammatory burden"],
    relatedProtocols: ["Omega-3 3 g/day"],
    seeds: ["hs-CRP 2.8 mg/L (optimal < 1.0), improving from 3.0"],
  },
  {
    name: "Vitamin D, 25-OH",
    unit: "ng/mL",
    current: 24, currentDisplay: "24", prior: 22, priorDisplay: "22",
    changeDisplay: "+2", changePct: 9.1,
    labRangeText: "30 – 100",
    optimalRange: { min: 40, max: 70, unit: "ng/mL", source: "Practice optimal" },
    status: "low", trend: "improving",
    series: series([18, 19, 20, 21, 22, 23, 24]),
    confidence: 96, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 2 · Vitamins", snippet: "VITAMIN D,25-OH,TOTAL  24 ng/mL   Ref: 30-100", confidenceNote: "Value below lab range flagged by lab; high extraction confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 96 },
    relatedSystems: ["Immune", "Bone"],
    relatedContext: ["Low energy"],
    relatedHypotheses: ["Inflammatory burden"],
    relatedProtocols: ["Vitamin D repletion"],
    seeds: ["Vitamin D 24 ng/mL (lab 30–100; optimal 40–70), rising"],
  },
  {
    name: "Ferritin",
    unit: "ng/mL",
    current: 45, currentDisplay: "45", prior: 44, priorDisplay: "44",
    changeDisplay: "+1", changePct: 2.3,
    labRangeText: "16 – 154",
    optimalRange: { min: 50, max: 150, unit: "ng/mL", source: "Practice optimal" },
    status: "low", trend: "stable",
    series: series([42, 44, 43, 45, 44, 46, 45]),
    confidence: 90, confidenceBand: "high", reviewState: "reviewed",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 3 · Iron studies", snippet: "FERRITIN  45 ng/mL   Ref: 16-154", confidenceNote: "Within lab range, below practice optimal; high confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "reviewed", confidence: 90 },
    relatedSystems: ["Hematologic"],
    relatedContext: ["Energy"],
    relatedHypotheses: [],
    relatedProtocols: [],
    seeds: ["Ferritin 45 ng/mL (optimal 50–150), stable"],
  },
  {
    name: "Cortisol, AM",
    unit: "µg/dL",
    current: 21.3, currentDisplay: "21.3", prior: 20.0, priorDisplay: "20.0",
    changeDisplay: "+1.3", changePct: 6.5,
    labRangeText: "6.2 – 19.4",
    optimalRange: { min: 10, max: 16, unit: "µg/dL", source: "Practice optimal" },
    status: "critical-high", trend: "worsening",
    series: series([18, 19, 20.5, 20, 21, 21.5, 21.3]),
    confidence: 62, confidenceBand: "medium", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 4 · Endocrine", snippet: "CORTISOL, AM  21.3 ug/dL   Ref: 6.2-19.4  (single collection)", confidenceNote: "Above lab range; single collection limits interpretation — confirm before acting." },
    provenance: { sourceType: "measured", sourceName: "Salivary cortisol · May 13", dateRange: "Single collection", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 62, conflicts: 1 },
    relatedSystems: ["HPA axis", "Sleep & Recovery"],
    relatedContext: ["Poor sleep", "Stress"],
    relatedHypotheses: ["Cortisol dysregulation"],
    relatedProtocols: ["Support cortisol rhythm"],
    seeds: ["AM cortisol 21.3 µg/dL (above lab range 6.2–19.4); single collection"],
  },
  {
    name: "Omega-3 Index",
    unit: "%",
    current: 6.2, currentDisplay: "6.2", prior: 6.1, priorDisplay: "6.1",
    changeDisplay: "+0.1", changePct: 1.6,
    labRangeText: "> 4.0",
    optimalRange: { min: 8, max: 12, unit: "%", source: "Practice optimal" },
    status: "low", trend: "improving",
    series: series([4.8, 5.1, 5.4, 5.7, 5.9, 6.1, 6.2]),
    confidence: 88, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "OmegaQuant · May 13", location: "Page 1", snippet: "OMEGA-3 INDEX  6.2 %   Desirable: >8%", confidenceNote: "Clear value; high confidence." },
    provenance: { sourceType: "measured", sourceName: "OmegaQuant · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 88 },
    relatedSystems: ["Cardiovascular", "Inflammation"],
    relatedContext: [],
    relatedHypotheses: ["Inflammatory burden"],
    relatedProtocols: ["Omega-3 3 g/day"],
    seeds: ["Omega-3 Index 6.2% (optimal 8–12%), rising"],
  },
  {
    name: "Fasting insulin",
    unit: "µIU/mL",
    current: 8.1, currentDisplay: "8.1", prior: 8.0, priorDisplay: "8.0",
    changeDisplay: "+0.1", changePct: 1.3,
    labRangeText: "2.6 – 24.9",
    optimalRange: { min: 2, max: 6, unit: "µIU/mL", source: "Practice optimal" },
    status: "high", trend: "needs-review",
    series: series([7.6, 7.7, 7.9, 8.0, 7.8, 8.0, 8.1]),
    confidence: 41, confidenceBand: "low", reviewState: "not-reviewed",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 5 · Metabolic (faint scan)", snippet: "FASTING INSULIN  8.1? uIU/mL   (low-contrast scan region)", confidenceNote: "Low-contrast source region; the value 8.1 and unit need practitioner confirmation before use." },
    provenance: { sourceType: "ai-inference", sourceName: "Extraction from Quest PDF", dateRange: "Lab PDF p.5", lastUpdated: "May 13, 2026", review: "not-reviewed", confidence: 41, conflicts: 1 },
    relatedSystems: ["Metabolic"],
    relatedContext: ["Afternoon energy dips"],
    relatedHypotheses: ["Insulin resistance progression"],
    relatedProtocols: [],
    seeds: ["Fasting insulin 8.1 µIU/mL (optimal 2–6) — low extraction confidence, confirm"],
  },
  {
    name: "HbA1c",
    unit: "%",
    current: 5.5, currentDisplay: "5.5", prior: 5.4, priorDisplay: "5.4",
    changeDisplay: "+0.1", changePct: 1.9,
    labRangeText: "4.0 – 5.6",
    optimalRange: { max: 5.3, unit: "%", source: "Practice optimal" },
    status: "high", trend: "worsening",
    series: series([5.3, 5.3, 5.4, 5.4, 5.4, 5.5, 5.5]),
    confidence: 94, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 5 · Metabolic", snippet: "HEMOGLOBIN A1c  5.5 %   Ref: 4.0-5.6", confidenceNote: "Clear value; high confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 6 months", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 94 },
    relatedSystems: ["Metabolic"],
    relatedContext: [],
    relatedHypotheses: ["Insulin resistance progression"],
    relatedProtocols: [],
    seeds: ["HbA1c 5.5% (optimal < 5.3), creeping up"],
  },
  {
    name: "Homocysteine",
    unit: "µmol/L",
    current: 9.8, currentDisplay: "9.8", prior: 9.5, priorDisplay: "9.5",
    changeDisplay: "+0.3", changePct: 3.2,
    labRangeText: "< 15",
    optimalRange: { max: 7, unit: "µmol/L", source: "Practice optimal" },
    status: "high", trend: "stable",
    series: series([9.4, 9.5, 9.6, 9.5, 9.7, 9.6, 9.8]),
    confidence: 78, confidenceBand: "medium", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 6 · Methylation", snippet: "HOMOCYSTEINE  9.8 umol/L   Ref: <15", confidenceNote: "Value legible; medium confidence on unit parse." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 78 },
    relatedSystems: ["Methylation", "Cardiovascular"],
    relatedContext: [],
    relatedHypotheses: [],
    relatedProtocols: [],
    seeds: ["Homocysteine 9.8 µmol/L (optimal < 7)"],
  },
  {
    name: "ApoB",
    unit: "mg/dL",
    current: 92, currentDisplay: "92", prior: 96, priorDisplay: "96",
    changeDisplay: "−4", changePct: -4.2,
    labRangeText: "< 90",
    optimalRange: { max: 80, unit: "mg/dL", source: "Practice optimal" },
    status: "high", trend: "improving",
    series: series([104, 102, 100, 98, 96, 94, 92]),
    confidence: 85, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 2 · Lipids", snippet: "APOLIPOPROTEIN B  92 mg/dL   Ref: <90", confidenceNote: "Clear value; high confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 85 },
    relatedSystems: ["Cardiovascular"],
    relatedContext: [],
    relatedHypotheses: [],
    relatedProtocols: ["Omega-3 3 g/day"],
    seeds: ["ApoB 92 mg/dL (optimal < 80), improving from 96"],
  },
  {
    name: "TSH",
    unit: "µIU/mL",
    current: 2.1, currentDisplay: "2.1", prior: 2.0, priorDisplay: "2.0",
    changeDisplay: "+0.1", changePct: 5.0,
    labRangeText: "0.45 – 4.5",
    optimalRange: { min: 1.0, max: 2.0, unit: "µIU/mL", source: "Practice optimal" },
    status: "high", trend: "stable",
    series: series([1.9, 2.0, 2.0, 2.1, 2.0, 2.1, 2.1]),
    confidence: 90, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 4 · Thyroid", snippet: "TSH  2.1 uIU/mL   Ref: 0.45-4.5", confidenceNote: "Clear value; high confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "awaiting-review", confidence: 90 },
    relatedSystems: ["Thyroid"],
    relatedContext: [],
    relatedHypotheses: [],
    relatedProtocols: [],
    seeds: ["TSH 2.1 µIU/mL (optimal 1–2)"],
  },
  {
    name: "Free T3",
    unit: "pg/mL",
    current: 3.1, currentDisplay: "3.1", prior: 3.2, priorDisplay: "3.2",
    changeDisplay: "−0.1", changePct: -3.1,
    labRangeText: "2.0 – 4.4",
    optimalRange: { min: 3.0, max: 4.0, unit: "pg/mL", source: "Practice optimal" },
    status: "optimal", trend: "stable",
    series: series([3.2, 3.1, 3.2, 3.1, 3.2, 3.1, 3.1]),
    confidence: 55, confidenceBand: "low", reviewState: "not-reviewed",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 4 · Thyroid (smudged)", snippet: "FREE T3  3.1? pg/mL   (partial OCR)", confidenceNote: "Partial OCR on this row; confirm the value 3.1 before use." },
    provenance: { sourceType: "ai-inference", sourceName: "Extraction from Quest PDF", dateRange: "Lab PDF p.4", lastUpdated: "May 13, 2026", review: "not-reviewed", confidence: 55, conflicts: 1 },
    relatedSystems: ["Thyroid"],
    relatedContext: [],
    relatedHypotheses: [],
    relatedProtocols: [],
    seeds: ["Free T3 3.1 pg/mL (optimal 3.0–4.0) — low extraction confidence, confirm"],
  },
  {
    name: "Free T4",
    unit: "ng/dL",
    current: 1.2, currentDisplay: "1.2", prior: 1.2, priorDisplay: "1.2",
    changeDisplay: "0.0", changePct: 0,
    labRangeText: "0.82 – 1.77",
    optimalRange: { min: 1.0, max: 1.5, unit: "ng/dL", source: "Practice optimal" },
    status: "optimal", trend: "stable",
    series: series([1.2, 1.2, 1.1, 1.2, 1.2, 1.2, 1.2]),
    confidence: 89, confidenceBand: "high", reviewState: "reviewed",
    collectedAt: "May 13, 2026",
    source: { reportName: "Quest Diagnostics · May 13", location: "Page 4 · Thyroid", snippet: "FREE T4  1.2 ng/dL   Ref: 0.82-1.77", confidenceNote: "Clear value; high confidence." },
    provenance: { sourceType: "measured", sourceName: "Quest panel · May 13", dateRange: "Last 90 days", lastUpdated: "May 13, 2026", review: "reviewed", confidence: 89 },
    relatedSystems: ["Thyroid"],
    relatedContext: [],
    relatedHypotheses: [],
    relatedProtocols: [],
    seeds: ["Free T4 1.2 ng/dL (optimal 1.0–1.5), stable"],
  },
];

export function getLabWorkspace(patientId: string, patientName = "this patient"): LabWorkspace {
  const markers: BiomarkerMarker[] = MARKERS.map((m, i) => ({
    ...m,
    id: `${patientId}-m${String(i + 1).padStart(2, "0")}`,
  }));

  const abnormal = markers.filter(
    (m) => m.status !== "optimal" && m.status !== "normal",
  ).length;
  const lowConf = markers.filter((m) => m.confidenceBand === "low").length;
  const awaiting = markers.filter((m) => m.reviewState !== "reviewed").length;

  return {
    patientId,
    patientName,
    lastUpload: "May 13, 2026 · 9:12 AM",
    lastSynced: "2 min ago",
    reviewSummary: {
      reviewed: markers.length - awaiting,
      awaiting,
      lowConfidence: lowConf,
      abnormal,
    },
    reports: [
      { id: `${patientId}-r1`, name: "Quest Diagnostics — comprehensive panel", lab: "Quest Diagnostics", collectedAt: "May 13, 2026", uploadedAt: "May 13, 2026", markerCount: 10 },
      { id: `${patientId}-r2`, name: "OmegaQuant — Omega-3 Index", lab: "OmegaQuant", collectedAt: "May 13, 2026", uploadedAt: "May 13, 2026", markerCount: 1 },
    ],
    queue: [
      { id: `${patientId}-q1`, kind: "new-report", label: "New Quest panel uploaded", source: "Quest Diagnostics", date: "May 13", count: 10, tone: "navy" },
      { id: `${patientId}-q2`, kind: "extraction-review", label: "Extraction needs review", source: "Quest PDF p.4–5", date: "May 13", count: 2, tone: "ai" },
      { id: `${patientId}-q3`, kind: "low-confidence", label: "Low-confidence markers", source: "Fasting insulin, Free T3", date: "May 13", count: lowConf, tone: "warning" },
      { id: `${patientId}-q4`, kind: "abnormal", label: "Abnormal biomarkers", source: "vs practice optimal", date: "May 13", count: abnormal, tone: "critical" },
      { id: `${patientId}-q5`, kind: "recheck", label: "Recheck recommended", source: "Vitamin D · 8 weeks", date: "Jul 8", count: 1, tone: "action" },
    ],
    markers,
  };
}
