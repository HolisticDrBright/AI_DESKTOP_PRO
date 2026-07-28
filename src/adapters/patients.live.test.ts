import { beforeEach, describe, expect, test, vi } from "vitest";
import { patientsLive } from "./patients.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "20000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const patientRow = {
  id: PATIENT_ID,
  organization_id: ORG_ID,
  mrn: "A-100",
  first_name: "Avery",
  last_name: "Morgan",
  date_of_birth: "1985-04-12",
  sex: "female",
  status: "active",
};

beforeEach(() => {
  process.env.CLINICAL_SUPABASE_URL = "https://clinical.example.test";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("patientsLive Supabase boundary", () => {
  test("lists only the selected organization's RLS-visible patients", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([patientRow]));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await patientsLive.list(TOKEN, ORG_ID);

    expect(rows[0]).toMatchObject({
      id: PATIENT_ID,
      mrn: "A-100",
      name: "Avery Morgan",
      initials: "AM",
    });
    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestUrl.pathname).toBe("/rest/v1/patient_profiles");
    expect(requestUrl.searchParams.get("organization_id")).toBe(`eq.${ORG_ID}`);
    expect(requestUrl.searchParams.get("deleted_at")).toBe("is.null");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  test("a direct patient URL is constrained by both patient and selected organization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([patientRow]));
    vi.stubGlobal("fetch", fetchMock);

    await patientsLive.get(PATIENT_ID, TOKEN, ORG_ID);

    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestUrl.searchParams.get("id")).toBe(`eq.${PATIENT_ID}`);
    expect(requestUrl.searchParams.get("organization_id")).toBe(`eq.${ORG_ID}`);
    expect(requestUrl.searchParams.get("limit")).toBe("1");
  });

  test("returns no patient when RLS or the selected organization hides the row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([])));
    await expect(
      patientsLive.get(PATIENT_ID, TOKEN, ORG_ID),
    ).resolves.toBeUndefined();
  });

  test("refuses all directory access without a practitioner session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(patientsLive.list(null, ORG_ID)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
