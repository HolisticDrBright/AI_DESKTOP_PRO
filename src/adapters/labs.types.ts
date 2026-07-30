import type { ProvenanceData, ReviewState, Tone } from "./types";

/**
 * Labs workspace DTO vocabulary shared by the live adapter, the API routes,
 * and the UI. Extracted from `labs.mock.ts` so the clinical runtime never
 * imports a mock module; the synthetic marker rows stay there, fixture-only.
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

