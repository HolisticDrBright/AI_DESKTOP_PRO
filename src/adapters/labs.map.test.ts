import { describe, expect, test } from "vitest";
import {
  buildLabMarkers,
  buildLabWorkspace,
  normalizeConfidence,
  type LabObservationRow,
} from "./labs.map";

const observation = (
  overrides: Partial<LabObservationRow> = {},
): LabObservationRow => ({
  id: "30000000-0000-4000-8000-000000000001",
  biomarker_definition_id: "40000000-0000-4000-8000-000000000001",
  canonical_name: "TSH",
  biological_system: "Thyroid",
  value_numeric: 2.1,
  value_text: null,
  unit: "mIU/L",
  status: "normal",
  original_reference_interval: "0.45–4.50",
  confidence: 0.96,
  provenance: "Page 2 · Thyroid",
  review_status: "unreviewed",
  reviewed_at: null,
  observed_at: "2026-07-20T12:00:00Z",
  ingested_at: "2026-07-21T12:00:00Z",
  lab_document_id: "50000000-0000-4000-8000-000000000001",
  source: "pdf",
  document_file_name: "Thyroid panel.pdf",
  document_lab_company: "Vibrant",
  ...overrides,
});

describe("lab workspace mapping", () => {
  test("keeps an unrecorded extraction confidence unknown", () => {
    expect(normalizeConfidence(null)).toEqual({ value: null, band: "unknown" });
    const [marker] = buildLabMarkers([observation({ confidence: null })]);
    expect(marker.confidence).toBeNull();
    expect(marker.confidenceBand).toBe("unknown");
    expect(marker.provenance.confidence).toBeUndefined();
  });

  test("preserves the laboratory interval and never guesses direction from an unstructured flag", () => {
    const [marker] = buildLabMarkers([
      observation({
        status: "abnormal",
        original_reference_interval: "See laboratory comment",
      }),
    ]);
    expect(marker.labRangeText).toBe("See laboratory comment");
    expect(marker.optimalRange.source).toBe("Not configured");
    expect(marker.status).toBe("unknown");
  });

  test("maps stored critical status names without changing their direction", () => {
    const [marker] = buildLabMarkers([observation({ status: "critical_high" })]);
    expect(marker.status).toBe("critical-high");
  });

  test("omits text-only results rather than fabricating chart values", () => {
    expect(
      buildLabMarkers([
        observation({
          value_numeric: null,
          value_text: "Detected",
        }),
      ]),
    ).toEqual([]);
  });

  test("summarizes current markers without double-counting historical observations", () => {
    const prior = observation({
      id: "30000000-0000-4000-8000-000000000002",
      value_numeric: 3.2,
      observed_at: "2026-06-20T12:00:00Z",
      review_status: "accepted",
    });
    const workspace = buildLabWorkspace({
      patientId: "patient-1",
      patientName: "Avery Morgan",
      observations: [observation({ status: "high", confidence: 0.5 }), prior],
      documents: [{
        id: "50000000-0000-4000-8000-000000000001",
        file_name: "Thyroid panel.pdf",
        lab_company: "Vibrant",
        panel_name: "Thyroid panel",
        lab_date: "2026-07-20",
        created_at: "2026-07-21T12:00:00Z",
      }],
    });

    expect(workspace.reviewSummary).toEqual({
      reviewed: 0,
      awaiting: 1,
      lowConfidence: 1,
      abnormal: 1,
    });
    expect(workspace.markers[0].series).toHaveLength(2);
    expect(workspace.reports[0].markerCount).toBe(2);
  });
});
