import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * THE CLINICAL FIXTURE BARRIER.
 *
 * The clinical edition must never render a synthetic patient, appointment,
 * lab, note, protocol, invoice, message, program, or wearable reading. The
 * dangerous failure is silent: a namespace with no live source returns its
 * fixture, and a practitioner reads "Alexandra Morgan, health score 78" as
 * their own patient's record.
 *
 * These tests load the adapter facade twice — once as each edition — and assert
 * that every unwired namespace SERVES fixtures in demo and REFUSES in clinical.
 * A refusal is what lets the UI show an honest unavailable state.
 *
 * Known fixture identities that must never appear in clinical mode:
 *   p-78435 Alexandra Morgan · p-64201 Michael Johnson · p-59318 Priya Sharma
 */

const FIXTURE_PATIENT_IDS = ["p-78435", "p-64201", "p-59318", "p-52984"];
const FIXTURE_PATIENT_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

async function loadFacade(edition: "demo" | "clinical") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_EDITION", edition);
  vi.stubEnv("NEXT_PUBLIC_EDITION_LOCK", "");
  const [{ api }, { APP_EDITION }] = await Promise.all([
    import("./index"),
    import("@/lib/edition"),
  ]);
  // Guard the test itself: if the stub failed, every assertion below is void.
  expect(APP_EDITION).toBe(edition);
  return api;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("demo edition serves its synthetic fixtures", () => {
  test("the fixture dataset is present and recognizable", async () => {
    const api = await loadFacade("demo");

    const patients = await api.patients.list();
    expect(patients.length).toBeGreaterThan(0);
    const ids = patients.map((p) => p.id);
    expect(ids).toContain("p-78435");
    expect(patients.map((p) => p.name)).toContain("Alexandra Morgan");

    const summary = await api.patients.summary("p-78435");
    expect(summary?.healthScore.value).toBeGreaterThan(0);
  });

  test("unwired namespaces return demo data rather than throwing", async () => {
    const api = await loadFacade("demo");

    await expect(api.reasoning.getWorkspace("p-78435")).resolves.toBeTruthy();
    await expect(api.supplements.getWorkspace("p-78435")).resolves.toBeTruthy();
    await expect(api.healthTwin.getMap("p-78435")).resolves.toBeTruthy();
    await expect(api.calendar.getSchedule()).resolves.toBeTruthy();
    await expect(api.assistant.session()).resolves.toBeTruthy();
    await expect(api.experiments.listActive()).resolves.toBeInstanceOf(Array);
    await expect(api.inventory.listProducts()).resolves.toBeInstanceOf(Array);
    await expect(api.labOrders.getDraftOrder("p-78435")).resolves.toBeTruthy();
  });
});

describe("clinical edition refuses every fixture namespace", () => {
  const cases: [string, (api: Awaited<ReturnType<typeof loadFacade>>) => Promise<unknown>][] = [
    ["patients.summary", (api) => api.patients.summary("p-78435")],
    ["assistant.session", (api) => api.assistant.session()],
    ["calendar.getSchedule", (api) => api.calendar.getSchedule()],
    ["reasoning.getWorkspace", (api) => api.reasoning.getWorkspace("p-78435")],
    ["supplements.getWorkspace", (api) => api.supplements.getWorkspace("p-78435")],
    ["healthTwin.getMap", (api) => api.healthTwin.getMap("p-78435")],
    ["experiments.listActive", (api) => api.experiments.listActive()],
    ["experiments.listCompleted", (api) => api.experiments.listCompleted()],
    ["inventory.listProducts", (api) => api.inventory.listProducts()],
    ["inventory.listSales", (api) => api.inventory.listSales()],
    ["labOrders.getDraftOrder", (api) => api.labOrders.getDraftOrder("p-78435")],
    ["labOrders.listCatalogPanels", (api) => api.labOrders.listCatalogPanels("p-78435")],
    ["imports.plan", (api) => api.imports.plan("csv")],
  ];

  for (const [name, call] of cases) {
    test(`${name} throws unavailable instead of returning fixtures`, async () => {
      const api = await loadFacade("clinical");
      await expect(call(api)).rejects.toMatchObject({ code: "unavailable" });
    });
  }

  test("a refusal never carries fixture patient data in its message", async () => {
    const api = await loadFacade("clinical");
    // An error that leaked a fixture name would put synthetic identity on
    // screen through the error path instead of the data path.
    const error = await api.patients.summary("p-78435").catch((e: unknown) => e);
    const text = JSON.stringify({
      message: (error as Error).message,
      detail: (error as { detail?: string }).detail,
    });
    for (const name of FIXTURE_PATIENT_NAMES) {
      expect(text).not.toContain(name);
    }
    for (const id of FIXTURE_PATIENT_IDS) {
      expect(text).not.toContain(id);
    }
  });

  test("the mutation surface refuses too — no synthetic writes in clinical mode", async () => {
    const api = await loadFacade("clinical");
    await expect(
      api.labOrders.addPanelToDraft("p-78435", "panel-cmp"),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(api.labOrders.prepareOrderDraft("p-78435")).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  test("live-only namespaces stay live-only and never degrade to demo", async () => {
    const api = await loadFacade("clinical");
    // These have no demo implementation at all; in clinical mode they must
    // attempt the real boundary (and fail on transport in this unit context),
    // never silently return synthetic appointments.
    const error = await api.schedule
      .getWeek("2026-07-27T00:00:00Z", "2026-08-02T00:00:00Z")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).not.toBe(undefined);
    // Whatever the failure is, it is not "here are some fixtures".
    expect(JSON.stringify(error)).not.toContain("Alexandra Morgan");
  });
});

describe("the demo edition cannot be switched live by the deprecated flag", () => {
  test("NEXT_PUBLIC_USE_LIVE_API=true does not enable live adapters in a demo build", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_APP_EDITION", "demo");
    vi.stubEnv("NEXT_PUBLIC_USE_LIVE_API", "true");

    const { USE_LIVE_API, getApiMode } = await import("./mode");
    const { IS_DEMO, IS_CLINICAL } = await import("@/lib/edition");

    expect(IS_DEMO).toBe(true);
    expect(IS_CLINICAL).toBe(false);
    // The deprecated alias is derived from the edition, not from its own flag.
    expect(USE_LIVE_API).toBe(false);
    expect(getApiMode()).toBe("mock");
  });

  test("dev identity overrides are ignored in the demo edition", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_APP_EDITION", "demo");
    vi.stubEnv("NEXT_PUBLIC_DEV_ORG_ID", "org-real-clinic");
    vi.stubEnv("NEXT_PUBLIC_DEV_PATIENT_ID", "real-patient-uuid");

    const { getDevContext, hasDevOverrides } = await import("./mode");
    expect(getDevContext()).toEqual({});
    expect(hasDevOverrides()).toBe(false);
  });
});
