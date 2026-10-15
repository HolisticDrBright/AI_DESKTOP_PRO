import { describe, expect, it, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The funnel route's PRODUCTION headers: same-origin only, no frame, no media, no external
 * script source, on the funnel page and on the purchase page it leads to. And a structural fact:
 * the funnel and purchase pages add no API route, so the set of unauthenticated routes is exactly
 * what it was (the Lambda's declared public route is asserted in
 * authenticated-api-infrastructure.test.ts; the Desktop's is `/api/public/consult`).
 */
describe("program funnel route headers", () => {
  it("serves a strict same-origin policy with no frame and no external destination", async () => {
    vi.stubEnv("APP_EDITION", "clinical");
    vi.stubEnv("NODE_ENV", "production");
    const config = (await import("../../next.config")).default;
    const headers = await config.headers!();
    for (const source of ["/learn/:slug", "/buy/:slug"]) {
    const funnel = headers.find((entry) => entry.source === source);
    expect(funnel, source).toBeDefined();
    const value = (key: string) => funnel!.headers.find((header) => header.key === key)?.value ?? "";
    const csp = Object.fromEntries(value("Content-Security-Policy").split(";").map((directive) => {
      const [name, ...rest] = directive.trim().split(/\s+/);
      return [name, rest];
    }));
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["media-src"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    for (const directive of Object.values(csp) as string[][]) for (const source of directive) expect(source).not.toMatch(/^https?:|^wss?:|\*/);
    expect(value("X-Content-Type-Options")).toBe("nosniff");
    expect(value("Permissions-Policy")).toBe("microphone=(), camera=(), geolocation=()");
    }
  });
  it("needs no allowance for the sign-up link: it is a same-origin /join path, and no sign-up host appears in the policy", async () => {
    vi.stubEnv("APP_EDITION", "clinical");
    vi.stubEnv("NODE_ENV", "production");
    const policy = async () => {
      vi.resetModules();
      const config = (await import("../../next.config")).default;
      const entry = (await config.headers!()).find((candidate) => candidate.source === "/learn/:slug");
      return entry!.headers.find((header) => header.key === "Content-Security-Policy")!.value;
    };
    const value = await policy();
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://clinic.fictional.example");
    expect(await policy()).toBe(value);
    expect(value).not.toMatch(/join|updates|signup/i);
    vi.unstubAllEnvs();
  });
  it("declares exactly four unauthenticated Desktop routes: the consult intake and the three campaign routes", () => {
    const routes: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) walk(path); else if (entry === "route.ts") routes.push(path.replace(/\\/g, "/")); } };
    walk("src/app/api");
    const publicRoutes = routes.filter((route) => route.includes("/api/public/"));
    // The campaign engine (marketing wiring, workstream 2) adds the sign-up post, the confirmation and the RFC 8058
    // one-click unsubscribe. Each answers not-found while CAMPAIGN_ENGINE_ENABLED is off; SES events reach the engine
    // by SNS straight into its own function, with no route here.
    expect(publicRoutes.sort()).toEqual(["src/app/api/public/campaigns/confirm/route.ts", "src/app/api/public/campaigns/join/route.ts",
      "src/app/api/public/campaigns/unsubscribe/route.ts", "src/app/api/public/consult/route.ts"]);
    expect(routes.some((route) => /funnel|learn|\/buy\//.test(route))).toBe(false);
  });
});

describe("My courses route headers", () => {
  it("serves the same strict same-origin policy, never cached and never referred", async () => {
    vi.stubEnv("APP_EDITION", "clinical");
    vi.stubEnv("NODE_ENV", "production");
    const config = (await import("../../next.config")).default;
    const entry = (await config.headers!()).find((candidate) => candidate.source === "/courses");
    expect(entry).toBeDefined();
    const value = (key: string) => entry!.headers.find((header) => header.key === key)?.value ?? "";
    expect(value("Content-Security-Policy")).toMatch(/connect-src 'self'/);
    expect(value("Content-Security-Policy")).toMatch(/frame-ancestors 'none'/);
    expect(value("Cache-Control")).toBe("no-store, private");
    expect(value("Referrer-Policy")).toBe("no-referrer");
  });
});
