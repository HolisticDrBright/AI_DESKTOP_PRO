import { afterEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { AUTH_COOKIES, refreshSession } from "@/adapters/auth.server";
import { AdapterError } from "@/adapters/errors";

vi.mock("@/adapters/auth.server", async importOriginal => ({
  ...await importOriginal<typeof import("@/adapters/auth.server")>(),
  refreshSession: vi.fn(),
}));

afterEach(() => {
  delete process.env.PRODUCTION_WORKLOAD_MODE;
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("clinical-only authentication lifecycle", () => {
  for (const legacyFlag of [undefined, "false", "true"]) {
    test(`signed-out pages require sign-in regardless of retired mode flag ${legacyFlag}`, async () => {
      vi.stubEnv("NEXT_PUBLIC_USE_LIVE_API", legacyFlag);
      const response = await middleware(new NextRequest("https://desktop.example.test/patients/fictional/chart?view=timeline"));
      expect(response.status).toBe(307);
      const target = new URL(response.headers.get("location")!);
      expect(target.origin).toBe("https://desktop.example.test");
      expect(target.pathname).toBe("/login");
      expect(target.searchParams.get("next")).toBe("/patients/fictional/chart?view=timeline");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(refreshSession).not.toHaveBeenCalled();
    });
  }

  test("public authentication pages and APIs reach their own handlers", async () => {
    for (const path of ["/login", "/reset", "/api/auth/login", "/api/live/program-assignments"]) {
      const response = await middleware(new NextRequest("https://desktop.example.test" + path));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(refreshSession).not.toHaveBeenCalled();
  });

  test("an expired page session refreshes even when the retired mode flag is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_USE_LIVE_API", undefined);
    const tokens = { accessToken: "fictional-successor", refreshToken: "fictional-refresh-successor", expiresAt: Date.now() + 3600000, email: "fictional@example.invalid" };
    vi.mocked(refreshSession).mockResolvedValueOnce(tokens);
    const request = new NextRequest("https://desktop.example.test/patients/fictional/chart", { headers: {
      cookie: `${AUTH_COOKIES.access}=fictional-expired; ${AUTH_COOKIES.refresh}=fictional-refresh; ${AUTH_COOKIES.expires}=1`,
    } });
    const response = await middleware(request);
    expect(refreshSession).toHaveBeenCalledExactlyOnceWith("fictional-refresh");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(request.url);
    expect(response.cookies.get(AUTH_COOKIES.access)?.value).toBe(tokens.accessToken);
    expect(response.cookies.get(AUTH_COOKIES.refresh)?.value).toBe(tokens.refreshToken);
  });

  test("an expired session without a refresh token redirects pages and clears unusable cookies", async () => {
    const response = await middleware(new NextRequest("https://desktop.example.test/patients/fictional/chart", { headers: {
      cookie: `${AUTH_COOKIES.access}=fictional-expired; ${AUTH_COOKIES.expires}=1`,
    } }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    for (const name of Object.values(AUTH_COOKIES)) expect(response.cookies.get(name)?.maxAge).toBe(0);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  test("a revoked refresh redirects and clears cookies instead of retaining access", async () => {
    vi.mocked(refreshSession).mockRejectedValueOnce(new AdapterError("unauthenticated", "Fictional revoked session"));
    const response = await middleware(new NextRequest("https://desktop.example.test/patients/fictional/chart", { headers: {
      cookie: `${AUTH_COOKIES.access}=fictional-expired; ${AUTH_COOKIES.refresh}=fictional-revoked-refresh; ${AUTH_COOKIES.expires}=1`,
    } }));
    expect(refreshSession).toHaveBeenCalledExactlyOnceWith("fictional-revoked-refresh");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    for (const name of Object.values(AUTH_COOKIES)) expect(response.cookies.get(name)?.maxAge).toBe(0);
  });
});

describe("production readiness middleware boundary", () => {
  test("allows only the bounded health endpoint", async () => {
    process.env.PRODUCTION_WORKLOAD_MODE = "readiness_only";
    const response = await middleware(new NextRequest("https://desktop.example.test/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("refuses application and API routes without exposing data", async () => {
    process.env.PRODUCTION_WORKLOAD_MODE = "readiness_only";
    const response = await middleware(new NextRequest("https://desktop.example.test/patients/patient-1"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await response.json()).toEqual({ error: "production_not_activated", phiAllowed: false });
  });
});
