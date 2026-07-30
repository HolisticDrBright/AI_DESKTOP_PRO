import type {
  BiomarkerMarker,
  ExtractionConfidenceBand,
  LabQueueKind,
  LabReport,
  LabReviewQueueItem,
  LabWorkspace,
  MarkerStatus,
} from "./labs.mock";
import type { ReviewState, Tone } from "./types";

export interface LabObservationRow {
  id: string;
  biomarker_definition_id: string | null;
  canonical_name: string | null;
  biological_system: string | null;
  value_numeric: number | string | null;
  value_text: string | null;
  unit: string | null;
  status: string | null;
  original_reference_interval: string | null;
  confidence: number | string | null;
  provenance: string | null;
  review_status: string;
  reviewed_at: string | null;
  observed_at: string;
  ingested_at: string;
  lab_document_id: string | null;
  source: string;
  document_file_name: string | null;
  document_lab_company: string | null;
}

export interface LabDocumentRow {
  id: string;
  file_name: string | null;
  lab_company: string | null;
  panel_name: string | null;
  lab_date: string | null;
  created_at: string;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function normalizeConfidence(
  raw: number | string | null,
): { value: number | null; band: ExtractionConfidenceBand } {
  if (raw == null || raw === "") return { value: null, band: "unknown" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { value: null, band: "unknown" };
  const value = Math.max(0, Math.min(100, Math.round(parsed <= 1 ? parsed * 100 : parsed)));
  const band: ExtractionConfidenceBand =
    value >= 90 ? "high" : value >= 70 ? "medium" : "low";
  return { value, band };
}

const STRUCTURED_STATUSES = new Set<MarkerStatus>([
  "optimal",
  "low",
  "high",
  "critical-low",
  "critical-high",
  "normal",
]);

const ABNORMAL_SOURCE_STATUSES = new Set([
  "low",
  "high",
  "abnormal",
  "critical",
  "critical-low",
  "critical-high",
]);

function markerStatus(raw: string | null): MarkerStatus {
  const normalized = (raw ?? "").trim().toLowerCase().replaceAll("_", "-") as MarkerStatus;
  return STRUCTURED_STATUSES.has(normalized) ? normalized : "unknown";
}

function reviewState(raw: string): ReviewState {
  if (raw === "accepted") return "reviewed";
  if (raw === "unreviewed") return "awaiting-review";
  return "not-reviewed";
}

export function buildLabMarkers(rows: LabObservationRow[]): BiomarkerMarker[] {
  const grouped = new Map<string, LabObservationRow[]>();
  for (const row of rows) {
    if (row.value_numeric == null || !Number.isFinite(Number(row.value_numeric))) continue;
    const key = row.biomarker_definition_id ?? `unmapped:${row.id}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const markers: BiomarkerMarker[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
    const latest = group[0];
    const prior = group[1];
    const current = Number(latest.value_numeric);
    const priorValue =
      prior?.value_numeric != null && Number.isFinite(Number(prior.value_numeric))
        ? Number(prior.value_numeric)
        : undefined;
    const confidence = normalizeConfidence(latest.confidence);
    const state = reviewState(latest.review_status);
    const name = latest.canonical_name?.trim() || "Unnamed marker";
    const unit = latest.unit?.trim() ?? "";
    const reportName =
      latest.document_file_name?.trim() ||
      `${latest.document_lab_company?.trim() || latest.source || "Lab"} record`;

    markers.push({
      id: latest.id,
      name,
      unit,
      current,
      currentDisplay: trimNumber(current),
      prior: priorValue,
      priorDisplay: priorValue == null ? undefined : trimNumber(priorValue),
      changeDisplay:
        priorValue == null
          ? undefined
          : `${current - priorValue >= 0 ? "+" : "−"}${trimNumber(Math.abs(current - priorValue))}`,
      changePct:
        priorValue == null || priorValue === 0
          ? undefined
          : Math.round(((current - priorValue) / priorValue) * 1000) / 10,
      labRangeText: latest.original_reference_interval ?? "Not provided by lab",
      optimalRange: { unit, source: "Not configured" },
      status: markerStatus(latest.status),
      trend: state === "awaiting-review" ? "needs-review" : "stable",
      series: [...group]
        .reverse()
        .slice(-7)
        .map((row) => ({ date: formatDate(row.observed_at), value: Number(row.value_numeric) })),
      confidence: confidence.value,
      confidenceBand: confidence.band,
      reviewState: state,
      collectedAt: formatDate(latest.observed_at),
      source: {
        reportName,
        location: latest.provenance?.trim() || "Lab record",
        snippet: `${name}  ${trimNumber(current)} ${unit}   Ref: ${
          latest.original_reference_interval ?? "n/a"
        }`,
        confidenceNote:
          confidence.value == null
            ? "Extraction confidence was not recorded. Verify against the source before relying on this result."
            : confidence.value >= 90
              ? "High extraction confidence from the source record."
              : "Verify value and unit against the source before relying on this result.",
        documentId: latest.lab_document_id,
      },
      provenance: {
        sourceType: "measured",
        sourceName: `${latest.document_lab_company?.trim() || "Lab"} · ${formatDate(latest.observed_at)}`,
        lastUpdated: formatDate(latest.ingested_at),
        ...(confidence.value == null ? {} : { confidence: confidence.value }),
        review: state,
      },
      relatedSystems: latest.biological_system ? [latest.biological_system] : [],
      relatedContext: [],
      relatedHypotheses: [],
      relatedProtocols: [],
      seeds: [`${name} ${trimNumber(current)} ${unit} (${formatDate(latest.observed_at)})`],
    });
  }

  return markers.sort((a, b) => a.name.localeCompare(b.name));
}

function queueItem(
  id: string,
  kind: LabQueueKind,
  label: string,
  date: string,
  count: number,
  tone: Tone,
): LabReviewQueueItem {
  return { id, kind, label, source: "Live record", date, count, tone };
}

export function buildLabWorkspace(input: {
  patientId: string;
  patientName: string;
  observations: LabObservationRow[];
  documents: LabDocumentRow[];
}): LabWorkspace {
  const markers = buildLabMarkers(input.observations);
  const reviewed = markers.filter((marker) => marker.reviewState === "reviewed").length;
  const awaiting = markers.filter((marker) => marker.reviewState === "awaiting-review").length;
  const lowConfidence = markers.filter((marker) => marker.confidenceBand === "low").length;
  const abnormal = markers.filter((marker) => {
    const source = input.observations.find((row) => row.id === marker.id);
    return ABNORMAL_SOURCE_STATUSES.has(
      (source?.status ?? "").toLowerCase().replaceAll("_", "-"),
    );
  }).length;
  const latestIngested = input.observations[0]?.ingested_at;
  const latestObserved = input.observations[0]?.observed_at;

  const queue: LabReviewQueueItem[] = [];
  if (awaiting > 0) {
    queue.push(
      queueItem(
        "q-awaiting",
        "extraction-review",
        `${awaiting} marker${awaiting === 1 ? "" : "s"} awaiting review`,
        formatDate(latestIngested),
        awaiting,
        "ai",
      ),
    );
  }
  if (lowConfidence > 0) {
    queue.push(
      queueItem(
        "q-lowconf",
        "low-confidence",
        `${lowConfidence} low-confidence extraction${lowConfidence === 1 ? "" : "s"}`,
        formatDate(latestIngested),
        lowConfidence,
        "warning",
      ),
    );
  }
  if (abnormal > 0) {
    queue.push(
      queueItem(
        "q-abnormal",
        "abnormal",
        `${abnormal} flagged abnormal by source`,
        formatDate(latestObserved),
        abnormal,
        "critical",
      ),
    );
  }

  const reports: LabReport[] = input.documents.map((document) => ({
    id: document.id,
    name: document.panel_name ?? document.file_name ?? "Lab document",
    lab: document.lab_company ?? "—",
    collectedAt: formatDate(document.lab_date),
    uploadedAt: formatDate(document.created_at),
    markerCount: input.observations.filter(
      (observation) => observation.lab_document_id === document.id,
    ).length,
  }));

  return {
    patientId: input.patientId,
    patientName: input.patientName,
    lastUpload: formatDate(input.documents[0]?.created_at),
    lastSynced: formatDate(latestIngested),
    reviewSummary: { reviewed, awaiting, lowConfidence, abnormal },
    reports,
    queue,
    markers,
  };
}
