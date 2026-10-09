import { describe, expect, it, vi } from "vitest";

/**
 * The embedded-visit route's PRODUCTION headers. The browser bootstrap test
 * (`e2e/zoom-sdk-bootstrap.spec.ts`) proves the real pinned SDK loads under
 * the dev server, whose policy is this one plus the documented dev-only
 * 'unsafe-eval' allowance; this test pins what production actually serves.
 */
describe("telehealth visit route headers", () => {
  it("allows exactly Zoom's origins, camera and microphone, and cross-origin isolation — no eval, no other third party", async () => {
    vi.stubEnv("APP_EDITION", "clinical");
    vi.stubEnv("NODE_ENV", "production");
    const config = (await import("../../next.config")).default;
    const headers = await config.headers!();
    const visit = headers.find((entry) => entry.source === "/telehealth/visit/:path*");
    expect(visit).toBeDefined();
    const value = (key: string) => visit!.headers.find((header) => header.key === key)?.value ?? "";
    const csp = Object.fromEntries(value("Content-Security-Policy").split(";").map((directive) => {
      const [name, ...rest] = directive.trim().split(/\s+/);
      return [name, rest];
    }));
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://source.zoom.us"]);
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp["connect-src"]).toEqual(expect.arrayContaining(["'self'", "https://*.zoom.us", "wss://*.zoom.us"]));
    expect(csp["frame-src"]).toEqual(["https://*.zoom.us"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(value("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(value("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(value("Permissions-Policy")).toBe("microphone=(self), camera=(self), display-capture=(self), geolocation=()");
    expect(value("Referrer-Policy")).toBe("no-referrer");
    const api = headers.find((entry) => entry.source === "/api/live/telehealth/:path*");
    expect(api?.headers.find((header) => header.key === "Cache-Control")?.value).toContain("no-store");
  });
});
