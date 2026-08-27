import { afterEach, describe, expect, test } from "vitest";
import {
  evaluateContractFixtureBoundary,
  getContractFixtureTransport,
  isContractFixtureAllowed,
} from "./contractFixture";

/** process.env.NODE_ENV is typed read-only; tests still need to set it. */
function setEnv(key: string, value: string): void {
  (process.env as Record<string, string>)[key] = value;
}

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

/** A local harness posture that SHOULD be allowed. */
function localEnv(over: Record<string, string> = {}) {
  return {
    CLINICAL_CONTRACT_FIXTURE: "1",
    CLINICAL_SUPABASE_URL: "http://127.0.0.1:3920",
    ...over,
  };
}

describe("the happy path is narrow and explicit", () => {
  test("loopback + explicit opt-in + non-deployed is allowed", () => {
    setEnv("NODE_ENV", "development");
    const v = evaluateContractFixtureBoundary(localEnv());
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.backendOrigin).toBe("http://127.0.0.1:3920");
  });

  test("localhost and ::1 are loopback too", () => {
    setEnv("NODE_ENV", "development");
    for (const url of ["http://localhost:3920", "http://[::1]:3920"]) {
      expect(evaluateContractFixtureBoundary(localEnv({ CLINICAL_SUPABASE_URL: url })).allowed).toBe(
        true,
      );
    }
  });
});

describe("every rule refuses on its own", () => {
  test("no explicit opt-in refuses — there is no default-on path", () => {
    setEnv("NODE_ENV", "development");
    for (const flag of [undefined, "", "0", "true", "yes", "TRUE"]) {
      const env = localEnv();
      if (flag === undefined) delete (env as Record<string, unknown>).CLINICAL_CONTRACT_FIXTURE;
      else env.CLINICAL_CONTRACT_FIXTURE = flag;
      const v = evaluateContractFixtureBoundary(env);
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.refusal).toBe("not_enabled");
    }
  });

  test("a deployed runtime refuses even on loopback with the flag set", () => {
    // The categorical Phase 10A rule. Every marker refuses independently.
    for (const [key, value] of [
      ["NODE_ENV", "production"],
      ["VERCEL_ENV", "production"],
      ["APP_RUNTIME_ENV", "production"],
      ["FLY_APP_NAME", "clinical"],
      ["K_SERVICE", "clinical"],
      ["AWS_LAMBDA_FUNCTION_NAME", "clinical"],
      ["RENDER", "true"],
      ["NETLIFY", "true"],
      ["DYNO", "web.1"],
      ["KUBERNETES_SERVICE_HOST", "10.0.0.1"],
    ] as Array<[string, string]>) {
      process.env = { ...SAVED, NODE_ENV: "development" };
      (process.env as Record<string, string>)[key] = value;
      const v = evaluateContractFixtureBoundary(localEnv());
      expect(v.allowed, `${key}=${value} must refuse`).toBe(false);
      if (!v.allowed) expect(v.refusal).toBe("deployed_runtime");
    }
  });

  test("no backend configured refuses", () => {
    setEnv("NODE_ENV", "development");
    const env = localEnv();
    delete (env as Record<string, unknown>).CLINICAL_SUPABASE_URL;
    const v = evaluateContractFixtureBoundary(env);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("backend_not_configured");
  });

  test("the real clinical project refuses by identity", () => {
    setEnv("NODE_ENV", "development");
    const v = evaluateContractFixtureBoundary(
      localEnv({ CLINICAL_SUPABASE_URL: "https://urcjiehlxoehievobezf.supabase.co" }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("hosted_supabase_project");
  });

  test("the clinical project ref is refused even behind a local-looking host", () => {
    // A tunnel or hosts-file entry could make it look local; the ref is
    // checked by identity, not only by the loopback rule.
    setEnv("NODE_ENV", "development");
    const v = evaluateContractFixtureBoundary(
      localEnv({ CLINICAL_SUPABASE_URL: "http://urcjiehlxoehievobezf.localtest.me:3920" }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("hosted_supabase_project");
  });

  test("any hosted Supabase project refuses, not just ours", () => {
    setEnv("NODE_ENV", "development");
    for (const host of ["https://someoneelse.supabase.co", "https://x.supabase.in"]) {
      const v = evaluateContractFixtureBoundary(localEnv({ CLINICAL_SUPABASE_URL: host }));
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.refusal).toBe("hosted_supabase_project");
    }
  });

  test("a non-loopback provider refuses", () => {
    setEnv("NODE_ENV", "development");
    for (const host of [
      "https://api.openai.com",
      "http://10.0.0.5:3920",
      "http://192.168.1.10:3920",
      "http://clinical.internal:3920",
    ]) {
      const v = evaluateContractFixtureBoundary(localEnv({ CLINICAL_SUPABASE_URL: host }));
      expect(v.allowed, `${host} must refuse`).toBe(false);
      if (!v.allowed) expect(v.refusal).toBe("non_loopback_backend");
    }
  });

  test("an unparseable backend URL refuses", () => {
    setEnv("NODE_ENV", "development");
    const v = evaluateContractFixtureBoundary(localEnv({ CLINICAL_SUPABASE_URL: "not a url" }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("backend_url_unparseable");
  });
});

describe("no client-shipped value can open the boundary", () => {
  test("NEXT_PUBLIC_* is never consulted", () => {
    setEnv("NODE_ENV", "production"); // deployed
    setEnv("NEXT_PUBLIC_CONTRACT_FIXTURE", "1");
    setEnv("NEXT_PUBLIC_APP_ENV", "development");
    const v = evaluateContractFixtureBoundary(localEnv());
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.refusal).toBe("deployed_runtime");
  });

  test("the refusal names the reason rather than being silent", () => {
    setEnv("NODE_ENV", "production");
    const v = evaluateContractFixtureBoundary(localEnv());
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.detail).toMatch(/deployed runtime/i);
      expect(v.detail).toMatch(/NODE_ENV=production/);
    }
  });
});

describe("isContractFixtureAllowed", () => {
  test("agrees with the verdict", () => {
    setEnv("NODE_ENV", "development");
    expect(isContractFixtureAllowed(localEnv())).toBe(true);
    setEnv("NODE_ENV", "production");
    expect(isContractFixtureAllowed(localEnv())).toBe(false);
  });

  test("transport exposes a credential only for the approved loopback fixture", () => {
    setEnv("NODE_ENV", "development");
    expect(getContractFixtureTransport(localEnv())).toBeNull();
    expect(getContractFixtureTransport(localEnv({ CLINICAL_SUPABASE_ANON_KEY: "fixture-only" })))
      .toEqual({ origin: "http://127.0.0.1:3920", credential: "fixture-only" });

    setEnv("NODE_ENV", "production");
    expect(getContractFixtureTransport(localEnv({ CLINICAL_SUPABASE_ANON_KEY: "fixture-only" })))
      .toBeNull();
  });
});
