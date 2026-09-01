import { beforeEach, describe, expect, test, vi } from "vitest";
import { relationshipsLive } from "./relationships.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "20000000-0000-4000-8000-000000000001";
const RELATIONSHIP_ID = "30000000-0000-4000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CLINICAL_CONTRACT_FIXTURE = "1";
  process.env.CLINICAL_SUPABASE_URL = "http://127.0.0.1:3999";
  process.env.CLINICAL_SUPABASE_ANON_KEY = "publishable-test-key";
  vi.restoreAllMocks();
});

describe("patient relationships live boundary", () => {
  test("lists relationships through the patient and organization scoped contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ patientId: PATIENT_ID, relationships: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await relationshipsLive.list(PATIENT_ID, TOKEN, ORG_ID);

    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestUrl.pathname).toBe("/rest/v1/rpc/get_patient_relationships");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
      _patient_id: PATIENT_ID,
    });
  });

  test("creates only a pending scoped invitation and does not send UI attestations downstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      invitationCode: "A1B2C3D4E5",
      deliveryState: "manual_secure_delivery_required",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await relationshipsLive.invite({
      patientId: PATIENT_ID,
      displayName: "Synthetic Caregiver",
      email: "caregiver@example.invalid",
      relationshipType: "adult_child",
      requestedScopes: ["protocols_supplements", "laboratory_results"],
      expiresInDays: 90,
    }, TOKEN, ORG_ID);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
      _patient_id: PATIENT_ID,
      _display_name: "Synthetic Caregiver",
      _email: "caregiver@example.invalid",
      _relationship_type: "adult_child",
      _requested_scopes: ["protocols_supplements", "laboratory_results"],
      _expires_in_days: 90,
    });
  });

  test("revokes with optimistic concurrency and a required audit reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      relationshipId: RELATIONSHIP_ID,
      status: "revoked",
      version: 3,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await relationshipsLive.revoke({
      relationshipId: RELATIONSHIP_ID,
      expectedVersion: 2,
      reason: "Patient withdrew access",
    }, TOKEN);

    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestUrl.pathname).toBe("/rest/v1/rpc/revoke_patient_relationship");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _relationship_id: RELATIONSHIP_ID,
      _expected_version: 2,
      _reason: "Patient withdrew access",
    });
  });

  test("refuses relationship access without a practitioner session", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(relationshipsLive.list(PATIENT_ID, null, ORG_ID)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
