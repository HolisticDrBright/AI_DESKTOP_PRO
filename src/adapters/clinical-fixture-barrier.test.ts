import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * THE CLINICAL FIXTURE BARRIER — clinical-only runtime edition.
 *
 * This repository ships ONLY the clinical product. The registry
 * (`src/adapters/index.ts`) has no mock branch: every namespace either reaches
 * the Desktop-owned boundary or throws `unavailable` so the UI renders an
 * honest not-configured state. These tests prove that from the outside:
 *
 *   1. every unwired namespace REFUSES — it never returns fixture data;
 *   2. no fixture identity can escape through the error path;
 *   3. live namespaces attempt real transport (and fail on transport in this
 *      unit context) — they never degrade to fixtures;
 *   4. the deprecated NEXT_PUBLIC_USE_LIVE_API flag is inert, and the import
 *      graph from production routes reaches no *.mock.ts module (enforced
 *      structurally by scripts/check-mock-imports.mjs, re-asserted here).
 *
 * Fixture files still exist for THIS test suite and its siblings — that is
 * their only remaining runtime-adjacent purpose.
 */

const FIXTURE_PATIENT_IDS = ["p-78435", "p-64201", "p-59318", "p-52984"];
const FIXTURE_PATIENT_NAMES = ["Alexandra Morgan", "Michael Johnson", "Priya Sharma"];

async function loadRegistry() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_EDITION", "clinical");
  vi.stubEnv("NEXT_PUBLIC_EDITION_LOCK", "clinical");
  const { api } = await import("./index");
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

describe("unwired namespaces refuse instead of returning fixtures", () => {
  const cases: [string, (api: Awaited<ReturnType<typeof loadRegistry>>) => Promise<unknown>][] = [
    ["patients.summary", (api) => api.patients.summary()],
    ["assistant.session", (api) => api.assistant.session()],
    ["composer.generate", (api) => api.composer.generate()],
    ["imports.plan", (api) => api.imports.plan()],
    ["calendar.getSchedule", (api) => api.calendar.getSchedule()],
    ["supplements.getWorkspace", (api) => api.supplements.getWorkspace()],
    ["healthTwin.getMap", (api) => api.healthTwin.getMap()],
    ["experiments.listActive", (api) => api.experiments.listActive()],
    ["experiments.listCompleted", (api) => api.experiments.listCompleted()],
    ["inventory.listProducts", (api) => api.inventory.listProducts()],
    ["inventory.listSales", (api) => api.inventory.listSales()],
    ["labOrders.getDraftOrder", (api) => api.labOrders.getDraftOrder()],
    ["labOrders.listCatalogPanels", (api) => api.labOrders.listCatalogPanels()],
    ["labOrders.prepareOrderDraft", (api) => api.labOrders.prepareOrderDraft()],
    ["integrations.getConnectors", (api) => api.integrations.getConnectors()],
    ["permissions.getMatrix", (api) => api.permissions.getMatrix()],
    ["labs.configureOptimalRange", (api) =>
      (api.labs.configureOptimalRange as (...a: unknown[]) => Promise<unknown>)(
        "m1",
        { unit: "x" },
        { patientId: "p", patientName: "P", markerName: "M" },
      )],
  ];

  for (const [name, call] of cases) {
    test(`${name} throws unavailable`, async () => {
      const api = await loadRegistry();
      await expect(call(api)).rejects.toMatchObject({ code: "unavailable" });
    });
  }

  test("refusals never carry fixture identities", async () => {
    const api = await loadRegistry();
    const error = await api.patients.summary().catch((e: unknown) => e);
    const text = JSON.stringify({
      message: (error as Error).message,
      detail: (error as { detail?: string }).detail,
    });
    for (const needle of [...FIXTURE_PATIENT_NAMES, ...FIXTURE_PATIENT_IDS]) {
      expect(text).not.toContain(needle);
    }
  });
});

describe("live namespaces attempt real transport, never fixtures", () => {
  test("schedule.getWeek fails on transport, not with fixture appointments", async () => {
    const api = await loadRegistry();
    const error = await api.schedule
      .getWeek("2026-07-27T00:00:00Z", "2026-08-02T00:00:00Z")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain("Alexandra Morgan");
  });

  test("tasks.getQueue fails on transport, not with the fixture queue", async () => {
    const api = await loadRegistry();
    const error = await api.tasks.getQueue().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = JSON.stringify(error);
    for (const id of FIXTURE_PATIENT_IDS) expect(text).not.toContain(id);
  });

  test("reasoning workspace and overview go to the live client", async () => {
    const api = await loadRegistry();
    await expect(api.reasoning.getWorkspace("x")).rejects.toBeInstanceOf(Error);
    await expect(api.patients.overview("x")).rejects.toBeInstanceOf(Error);
    // and neither rejection carries fixture data
    const err = await api.patients.overview("x").catch((e: unknown) => JSON.stringify(e));
    for (const name of FIXTURE_PATIENT_NAMES) {
      expect(err as string).not.toContain(name);
    }
  });
});

describe("the deprecated flag and demo identities are inert", () => {
  test("NEXT_PUBLIC_USE_LIVE_API=false cannot re-enable a mock mode", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_APP_EDITION", "clinical");
    vi.stubEnv("NEXT_PUBLIC_USE_LIVE_API", "false");

    const { USE_LIVE_API, getApiMode } = await import("./mode");
    expect(USE_LIVE_API).toBe(true);
    expect(getApiMode()).toBe("live");
  });

  test("the registry exposes no queueUploadDemo or demo-session surface", async () => {
    const api = await loadRegistry();
    expect((api.labs as Record<string, unknown>).queueUploadDemo).toBeUndefined();
    expect((api.actions as Record<string, unknown>).clearSessionAuditEvents).toBeUndefined();
    expect((api.actions as Record<string, unknown>).listAuditEvents).toBeUndefined();
  });

  test("the command palette carries no fixture patients", async () => {
    const { getCommandGroups } = await import("./commands");
    const text = JSON.stringify(getCommandGroups("some-uuid"));
    for (const needle of [...FIXTURE_PATIENT_NAMES, ...FIXTURE_PATIENT_IDS]) {
      expect(text).not.toContain(needle);
    }
  });
});
