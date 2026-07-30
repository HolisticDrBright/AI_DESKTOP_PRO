import { beforeEach, describe, expect, test, vi } from "vitest";
import { labsLive } from "./labs.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "20000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CLINICAL_SUPABASE_URL = "https://clinical.example.test";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("labsLive Supabase boundary", () => {
  test("loads the selected patient's workspace through RLS-scoped direct contracts", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/rpc/list_patient_lab_observations")) {
        return Promise.resolve(response([{
          id: "observation-1",
          biomarker_definition_id: "definition-1",
          canonical_name: "TSH",
          biological_system: "Thyroid",
          value_numeric: 2.1,
          value_text: null,
          unit: "mIU/L",
          status: "normal",
          original_reference_interval: "0.45–4.50",
          confidence: null,
          provenance: "Page 2",
          review_status: "unreviewed",
          reviewed_at: null,
          observed_at: "2026-07-20T12:00:00Z",
          ingested_at: "2026-07-21T12:00:00Z",
          lab_document_id: "document-1",
          source: "pdf",
          document_file_name: "Panel.pdf",
          document_lab_company: "Vibrant",
        }]));
      }
      if (url.pathname.endsWith("/lab_documents")) {
        return Promise.resolve(response([{
          id: "document-1",
          file_name: "Panel.pdf",
          lab_company: "Vibrant",
          panel_name: "Thyroid panel",
          lab_date: "2026-07-20",
          created_at: "2026-07-21T12:00:00Z",
        }]));
      }
      return Promise.resolve(response([{ first_name: "Avery", last_name: "Morgan" }]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const workspace = await labsLive.getWorkspace(PATIENT_ID, ORG_ID, TOKEN);

    expect(workspace.patientName).toBe("Avery Morgan");
    expect(workspace.markers[0]).toMatchObject({
      name: "TSH",
      confidence: null,
      confidenceBand: "unknown",
    });
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(input as string),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }));
    expect(calls.find((call) => call.url.pathname.endsWith("/rpc/list_patient_lab_observations"))?.body)
      .toEqual({ _organization_id: ORG_ID, _patient_id: PATIENT_ID });
    expect(
      calls.find((call) => call.url.pathname.endsWith("/lab_documents"))?.url.searchParams.get(
        "organization_id",
      ),
    ).toBe(`eq.${ORG_ID}`);
    expect(
      calls.find((call) => call.url.pathname.endsWith("/patient_profiles"))?.url.searchParams.get(
        "id",
      ),
    ).toBe(`eq.${PATIENT_ID}`);
  });

  test("reviews a marker through the atomic Supabase RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      review_status: "accepted",
      reviewed_at: "2026-07-28T20:00:00Z",
      previous_status: "unreviewed",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      labsLive.reviewMarker("observation-1", "accepted", "Reviewed", TOKEN),
    ).resolves.toMatchObject({
      ok: true,
      reviewStatus: "accepted",
      previousStatus: "unreviewed",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://clinical.example.test/rest/v1/rpc/review_biomarker",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _observation_id: "observation-1",
      _decision: "accepted",
      _note: "Reviewed",
    });
  });
});
