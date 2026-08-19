import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The clinical edition FAILS CLOSED. If the configuration that makes real
 * clinical data possible is absent, the app must say it is not configured — it
 * must never degrade to fixtures, and never render an empty chart a
 * practitioner could read as "this patient has no records".
 *
 * The demo edition asserts the inverse: it must hold no clinical credentials at
 * all, so a demo deployment cannot be nudged toward live behaviour.
 */

const CLINICAL_ENV = [
  "CLINICAL_AWS_REGION",
  "CLINICAL_AWS_API_ORIGIN",
  "CLINICAL_AWS_ALLOWED_API_HOSTS",
  "CLINICAL_AWS_WORKFORCE_USER_POOL_ID",
  "CLINICAL_AWS_WORKFORCE_CLIENT_ID",
  "AWS_CLINICAL_ADAPTER_READY",
  "PHI_ALLOWED",
];

function configureAwsClinicalBoundary() {
  vi.stubEnv("CLINICAL_AWS_REGION", "us-east-2");
  vi.stubEnv("CLINICAL_AWS_API_ORIGIN", "https://clinical-api.example.test");
  vi.stubEnv("CLINICAL_AWS_ALLOWED_API_HOSTS", "clinical-api.example.test");
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_USER_POOL_ID", "us-east-2_example");
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_CLIENT_ID", "client-example");
  vi.stubEnv("AWS_CLINICAL_ADAPTER_READY", "true");
  vi.stubEnv("PHI_ALLOWED", "false");
}

async function loadGate(edition: "demo" | "clinical") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_EDITION", edition);
  vi.stubEnv("NEXT_PUBLIC_EDITION_LOCK", "");
  return import("./edition.server");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("clinical edition configuration gate", () => {
  test("reports every missing requirement rather than the first", async () => {
    for (const name of CLINICAL_ENV) vi.stubEnv(name, "");
    const gate = await loadGate("clinical");

    const report = gate.inspectEditionConfig();
    expect(report.edition).toBe("clinical");
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(CLINICAL_ENV);
    expect(gate.isClinicalBoundaryConfigured()).toBe(false);
  });

  test("throws when required clinical configuration is absent", async () => {
    for (const name of CLINICAL_ENV) vi.stubEnv(name, "");
    const gate = await loadGate("clinical");

    expect(() => gate.assertEditionConfig()).toThrow(/fails closed/);
    expect(() => gate.assertEditionConfig()).toThrow(/CLINICAL_AWS_REGION/);
  });

  test("treats whitespace-only configuration as absent", async () => {
    configureAwsClinicalBoundary();
    vi.stubEnv("CLINICAL_AWS_API_ORIGIN", "   ");
    const gate = await loadGate("clinical");

    expect(gate.inspectEditionConfig().missing).toEqual(["CLINICAL_AWS_API_ORIGIN"]);
    expect(gate.isClinicalBoundaryConfigured()).toBe(false);
  });

  test("passes once the boundary is fully configured", async () => {
    configureAwsClinicalBoundary();
    const gate = await loadGate("clinical");

    const report = gate.inspectEditionConfig();
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(gate.isClinicalBoundaryConfigured()).toBe(true);
    expect(() => gate.assertEditionConfig()).not.toThrow();
  });
});

describe("demo edition credential gate", () => {
  test("a clean demo deployment passes", async () => {
    for (const name of CLINICAL_ENV) vi.stubEnv(name, "");
    const gate = await loadGate("demo");

    const report = gate.inspectEditionConfig();
    expect(report.edition).toBe("demo");
    expect(report.ok).toBe(true);
    expect(report.unexpected).toEqual([]);
    // A demo build has no clinical boundary to be configured, ever.
    expect(gate.isClinicalBoundaryConfigured()).toBe(false);
  });

  test("rejects a demo deployment holding clinical credentials", async () => {
    vi.stubEnv("CLINICAL_SUPABASE_URL", "https://real-clinic.supabase.co");
    vi.stubEnv("CLINICAL_SUPABASE_ANON_KEY", "real-key");
    const gate = await loadGate("demo");

    const report = gate.inspectEditionConfig();
    expect(report.ok).toBe(false);
    expect(report.unexpected).toContain("CLINICAL_SUPABASE_URL");
    expect(report.unexpected).toContain("CLINICAL_SUPABASE_ANON_KEY");
    expect(() => gate.assertEditionConfig()).toThrow(/must hold no real credentials/);
  });

  test("rejects a demo deployment holding third-party or service-role secrets", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("OPENAI_API_KEY", "sk-x");
    const gate = await loadGate("demo");

    const report = gate.inspectEditionConfig();
    expect(report.unexpected).toEqual(
      expect.arrayContaining([
        "SUPABASE_SERVICE_ROLE_KEY",
        "STRIPE_SECRET_KEY",
        "OPENAI_API_KEY",
      ]),
    );
    expect(() => gate.assertEditionConfig()).toThrow();
  });

  test("a demo build is never asked for clinical configuration", async () => {
    for (const name of CLINICAL_ENV) vi.stubEnv(name, "");
    const gate = await loadGate("demo");
    // Missing clinical env is not a demo problem — the demo calls nothing.
    expect(gate.inspectEditionConfig().missing).toEqual([]);
  });
});
