import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTH_COOKIES,
  passwordSignIn,
  readAuthSession,
  refreshSession,
  signOutSession,
} from "./auth.server";

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

describe("Desktop-owned practitioner auth", () => {
  test("password sign-in uses the Supabase password grant without exposing credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      user: { email: "practitioner@example.test" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await passwordSignIn("practitioner@example.test", "not-logged");

    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      email: "practitioner@example.test",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://clinical.example.test/auth/v1/token?grant_type=password",
    );
  });

  test("refresh uses token rotation and returns the replacement token pair", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
      expires_in: 1800,
      user: { email: "practitioner@example.test" },
    })));

    await expect(refreshSession("old-refresh")).resolves.toMatchObject({
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    });
  });

  test("provider sign-out revokes only the current session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOutSession("access-token");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://clinical.example.test/auth/v1/logout?scope=local",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
    });
  });

  test("an already revoked provider token is still a successful sign-out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
    await expect(signOutSession("expired-token")).resolves.toBeUndefined();
  });

  test("cookie session preserves the selected organization and detects expiry", () => {
    const values = new Map<string, string>([
      [AUTH_COOKIES.access, "access-token"],
      [AUTH_COOKIES.refresh, "refresh-token"],
      [AUTH_COOKIES.email, "practitioner@example.test"],
      [AUTH_COOKIES.expires, String(Date.now() + 60_000)],
      [AUTH_COOKIES.org, "organization-1"],
    ]);
    const session = readAuthSession({
      get: (name) => values.has(name) ? { value: values.get(name)! } : undefined,
    });

    expect(session).toMatchObject({
      signedIn: true,
      expired: false,
      orgId: "organization-1",
    });
  });
});
