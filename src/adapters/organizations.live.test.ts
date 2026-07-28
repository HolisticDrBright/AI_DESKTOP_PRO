import { beforeEach, describe, expect, test, vi } from "vitest";
import { organizationsLive } from "./organizations.live";

const TOKEN = "signed-practitioner-token";
const ORG_ID = "10000000-0000-4000-8000-000000000001";

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

describe("organizationsLive Supabase boundary", () => {
  test("loads and maps only organizations returned by the caller-scoped RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{
      organization_id: ORG_ID,
      name: "Practice A",
      slug: "practice-a",
      role: "practitioner",
    }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(organizationsLive.mine(TOKEN)).resolves.toEqual([{
      organizationId: ORG_ID,
      name: "Practice A",
      slug: "practice-a",
      role: "practitioner",
    }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://clinical.example.test/rest/v1/rpc/list_my_organizations");
    expect(init.headers).toMatchObject({
      apikey: "publishable-test-key",
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  test("claims pending memberships through the caller-only RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(2));
    vi.stubGlobal("fetch", fetchMock);

    await expect(organizationsLive.claim(TOKEN)).resolves.toEqual({ activated: 2 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://clinical.example.test/rest/v1/rpc/activate_my_memberships",
    );
  });

  test("maps the admin roster and passes the selected organization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{
      membership_id: "membership-1",
      user_id: "user-1",
      email: "member@example.test",
      display_name: "Member",
      role: "staff",
      status: "active",
      joined_at: "2026-07-28T00:00:00Z",
    }]));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await organizationsLive.members(TOKEN, ORG_ID);

    expect(rows[0]).toMatchObject({
      membershipId: "membership-1",
      userId: "user-1",
      displayName: "Member",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _organization_id: ORG_ID,
    });
  });

  test("does not pretend to invite an email that has no existing identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response({ code: "P0002", message: "internal identity detail" }, 400),
    ));

    await expect(
      organizationsLive.invite(
        { email: "missing@example.test", role: "practitioner" },
        TOKEN,
        ORG_ID,
      ),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "No account exists for that email. Create it through the approved identity-admin process, then add it here.",
    });
  });

  test("role changes and removals use the exact audited membership RPCs", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(null)));
    vi.stubGlobal("fetch", fetchMock);

    await organizationsLive.setRole(
      { membershipId: "membership-1", role: "admin" },
      TOKEN,
    );
    await organizationsLive.remove({ membershipId: "membership-1" }, TOKEN);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://clinical.example.test/rest/v1/rpc/set_org_member_role",
      "https://clinical.example.test/rest/v1/rpc/remove_org_member",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      _membership_id: "membership-1",
      _role: "admin",
    });
  });
});
