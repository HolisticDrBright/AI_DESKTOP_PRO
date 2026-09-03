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
  process.env.CLINICAL_CONTRACT_FIXTURE = "1";
  process.env.CLINICAL_SUPABASE_URL = "http://127.0.0.1:3999";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("patientsLive AWS clinical boundary", () => {
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

  test("puts synthetic V2 connection charts first and labels them clearly", async () => {
    const linked = {
      ...patientRow,
      id: "20000000-0000-4000-8000-000000000002",
      mrn: "patient_syn_link_80322acc2236",
      first_name: "Synthetic",
      last_name: "patient_syn_link_80322acc2236",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([patientRow, linked])));

    const rows = await patientsLive.list(TOKEN, ORG_ID);

    expect(rows.map((row) => row.id)).toEqual([linked.id, PATIENT_ID]);
    expect(rows[0]).toMatchObject({
      name: "V2 connection test · patient_syn_link_80322acc2236",
      initials: "V2",
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

  test("creates a patient only through the governed organization-scoped RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(patientRow));
    vi.stubGlobal("fetch", fetchMock);

    const result = await patientsLive.create(
      {
        firstName: "Avery",
        lastName: "Morgan",
        dateOfBirth: "1985-04-12",
        sex: "female",
        mrn: "A-100",
        email: "synthetic@example.invalid",
        phone: "555-0100",
        attestsSynthetic: true,
      },
      TOKEN,
      ORG_ID,
    );

    expect(result.patient).toMatchObject({ id: PATIENT_ID, name: "Avery Morgan", mrn: "A-100" });
    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestUrl.pathname).toBe("/rest/v1/rpc/create_patient_profile");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
      _first_name: "Avery",
      _last_name: "Morgan",
      _date_of_birth: "1985-04-12",
      _sex: "female",
      _mrn: "A-100",
      _email: "synthetic@example.invalid",
      _phone: "555-0100",
    });
  });

  test("refuses all directory access without a practitioner session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(patientsLive.list(null, ORG_ID)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
