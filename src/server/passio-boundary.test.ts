import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * PHASE 9A — the Passio provider boundary, proven from the outside.
 *
 * The claims under test are the ones the documentation makes: disabled by
 * default, no fixture fallback, no patient identifier leaves the building, and
 * being configured is not the same as having transacted.
 */

const REAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  for (const key of ["PASSIO_ENABLED", "PASSIO_LICENSE_KEY", "PASSIO_CUSTOMER_ID"]) {
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  process.env = { ...REAL_ENV };
});

async function boundary() {
  vi.resetModules();
  const mod = await import("./passio-boundary");
  mod.__resetPassioState();
  return mod;
}

function enable() {
  vi.stubEnv("PASSIO_ENABLED", "1");
  vi.stubEnv("PASSIO_LICENSE_KEY", "test-licence-key");
  vi.stubEnv("PASSIO_CUSTOMER_ID", "test-customer");
}

describe("Passio boundary configuration", () => {
  test("is disabled by default, and says why", async () => {
    const { getPassioConfig } = await boundary();
    const report = getPassioConfig();
    expect(report.mode).toBe("disabled");
    expect(report.configured).toBe(false);
    expect(report.problems.join(" ")).toMatch(/PASSIO_ENABLED is not set/);
  });

  test("enabled but incomplete stays disabled and names what is missing", async () => {
    vi.stubEnv("PASSIO_ENABLED", "1");
    const { getPassioConfig } = await boundary();
    const report = getPassioConfig();
    expect(report.configured).toBe(false);
    expect(report.problems.join(" ")).toMatch(/PASSIO_LICENSE_KEY is missing/);
    expect(report.problems.join(" ")).toMatch(/PASSIO_CUSTOMER_ID is missing/);
  });

  test("never puts the licence key in the operator-facing report", async () => {
    vi.stubEnv("PASSIO_ENABLED", "1");
    vi.stubEnv("PASSIO_LICENSE_KEY", "super-secret-licence");
    const { getPassioConfig } = await boundary();
    expect(JSON.stringify(getPassioConfig())).not.toContain("super-secret-licence");
  });

  test("refuses every capability while unconfigured, with a typed error", async () => {
    const mod = await boundary();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    for (const call of [
      () => mod.searchFoods("apple"),
      () => mod.getFoodDetail("ref-1"),
      () => mod.lookupBarcode("501234567890"),
      () => mod.recogniseImage("base64"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "not_configured" });
    }
    // The important half: nothing was attempted over the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("has NO fixture fallback — no environment variable produces invented food", async () => {
    // A made-up nutrient value is a clinical hazard, not a placeholder.
    vi.stubEnv("PASSIO_FIXTURES", "1");
    vi.stubEnv("ENABLE_FIXTURE_NUTRITION", "1");
    vi.stubEnv("NUTRITION_FIXTURE_MODE", "on");
    vi.stubEnv("NODE_ENV", "test");
    const mod = await boundary();
    await expect(mod.searchFoods("apple")).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("Passio boundary refuses to carry patient identifiers", () => {
  test("refuses a search that looks like a record id, an email, or a date of birth", async () => {
    enable();
    const mod = await boundary();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    for (const term of [
      "3f7c1c2e-9b3a-4a1e-8c0d-2b4f6a8e0d11",
      "patient@example.test",
      "chicken 1990-04-02",
      "MRN 4451207",
    ]) {
      await expect(mod.searchFoods(term)).rejects.toMatchObject({ code: "refused" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("allows an ordinary food term", async () => {
    enable();
    const mod = await boundary();
    expect(() => mod.assertFoodTermOnly("grilled chicken thigh")).not.toThrow();
    expect(() => mod.assertFoodTermOnly("greek yoghurt 0%")).not.toThrow();
  });

  test("rejects a non-barcode at the barcode capability", async () => {
    enable();
    const mod = await boundary();
    await expect(mod.lookupBarcode("not-a-barcode")).rejects.toMatchObject({ code: "refused" });
  });
});

describe("Passio boundary transport", () => {
  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init)),
    );
  }

  const tokenBody = JSON.stringify({ access_token: "token-abc", expires_in: 3600 });

  test("configured is not the same as transacted", async () => {
    enable();
    const mod = await boundary();
    // Configured, but nothing has actually been asked of Passio yet.
    expect(mod.getPassioConfig().configured).toBe(true);
    expect(mod.hasExecutedLiveRequest()).toBe(false);

    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    await mod.searchFoods("apple");
    expect(mod.hasExecutedLiveRequest()).toBe(true);
  });

  test("sends the licence key only to the token endpoint, and the customer id as a header", async () => {
    enable();
    const mod = await boundary();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      return url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    await mod.searchFoods("apple");
    const [tokenCall, apiCall] = calls;
    expect(tokenCall.url).toContain("test-licence-key");
    // The licence key must not travel with the data request.
    expect(apiCall.url).not.toContain("test-licence-key");
    expect(JSON.stringify(apiCall.init?.headers)).not.toContain("test-licence-key");
    expect(JSON.stringify(apiCall.init?.headers)).toContain("test-customer");
    expect(JSON.stringify(apiCall.init?.headers)).toContain("Bearer token-abc");
  });

  test("hashes the response instead of returning a body to store", async () => {
    enable();
    const mod = await boundary();
    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response(JSON.stringify({ results: [{ id: "f1", displayName: "Apple", calories: 95 }] }), {
            status: 200,
          }),
    );

    const result = await mod.searchFoods("apple");
    expect(result.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data[0]).toMatchObject({
      reference: "f1",
      label: "Apple",
      nutrientSource: "passio",
      energyValue: 95,
      energyUnit: "kcal",
    });
  });

  test("labels a missing energy value as null rather than zero", async () => {
    enable();
    const mod = await boundary();
    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response(JSON.stringify({ results: [{ id: "f2", displayName: "Water" }] }), {
            status: 200,
          }),
    );
    const result = await mod.searchFoods("water");
    // Zero calories and unknown calories are different claims.
    expect(result.data[0].energyValue).toBeNull();
    expect(result.data[0].energyUnit).toBeNull();
  });

  test("reports not-found and rate-limited as outcomes rather than as empty success", async () => {
    enable();
    const mod = await boundary();

    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    expect((await mod.getFoodDetail("missing")).outcome).toBe("not_found");

    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response("{}", { status: 429 }),
    );
    expect((await mod.lookupBarcode("501234567890")).outcome).toBe("rate_limited");
  });

  test("a provider error message never reaches the caller verbatim", async () => {
    enable();
    const mod = await boundary();
    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response(JSON.stringify({ message: "invalid query: patient@example.test" }), {
            status: 400,
          }),
    );
    await expect(mod.searchFoods("apple")).rejects.toThrow(/refused the request \(400\)/);
    await expect(mod.searchFoods("apple")).rejects.not.toThrow(/example\.test/);
  });

  test("image recognition always comes back awaiting review", async () => {
    enable();
    const mod = await boundary();
    stubFetch((url) =>
      url.includes("/token")
        ? new Response(tokenBody, { status: 200 })
        : new Response(JSON.stringify({ results: [{ id: "f3", displayName: "Pasta", calories: 300 }] }), {
            status: 200,
          }),
    );
    const result = await mod.recogniseImage("base64-image");
    // A photographed meal is a suggestion, never a confirmed log.
    expect(result.data.reviewState).toBe("awaiting_review");
  });
});
