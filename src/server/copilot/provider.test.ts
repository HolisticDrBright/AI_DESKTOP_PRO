import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CopilotUnavailable, disabledProvider, resolveCopilotMode, selectProvider } from "./provider";

const KEYS = [
  "CLINICAL_COPILOT_MODE",
  "VERCEL_ENV",
  "RAILWAY_SERVICE_NAME",
  "FLY_APP_NAME",
  "APP_RUNTIME_ENV",
  "NODE_ENV",
  "NEXT_PUBLIC_APP_ENV",
];

function clear() {
  for (const k of KEYS) delete process.env[k];
}

describe("copilot provider", () => {
  beforeEach(clear);
  afterEach(clear);

  test("default mode is disabled", () => {
    expect(resolveCopilotMode()).toBe("disabled");
  });

  test("disabled mode is honored explicitly", () => {
    process.env.CLINICAL_COPILOT_MODE = "disabled";
    expect(resolveCopilotMode()).toBe("disabled");
  });

  test("fixture mode allowed only when NOT deployed", () => {
    process.env.CLINICAL_COPILOT_MODE = "fixture";
    // no deployed signals
    expect(resolveCopilotMode()).toBe("fixture");
  });

  test.each([
    ["Vercel prod", { VERCEL_ENV: "production" }],
    ["Vercel preview", { VERCEL_ENV: "preview" }],
    ["Railway", { RAILWAY_SERVICE_NAME: "app" }],
    ["Fly.io", { FLY_APP_NAME: "clinical" }],
    ["APP_RUNTIME_ENV=production", { APP_RUNTIME_ENV: "production" }],
    ["APP_RUNTIME_ENV=staging", { APP_RUNTIME_ENV: "staging" }],
    ["NODE_ENV=production", { NODE_ENV: "production" }],
  ])("fixture is REFUSED under %s", (_label, envs) => {
    process.env.CLINICAL_COPILOT_MODE = "fixture";
    for (const [k, v] of Object.entries(envs)) process.env[k] = v;
    expect(() => resolveCopilotMode()).toThrow(/refused/i);
  });

  test("NEXT_PUBLIC_APP_ENV cannot alone refuse fixture (client-shipped, not the boundary)", () => {
    process.env.CLINICAL_COPILOT_MODE = "fixture";
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    // No other deployed signal — fixture stays allowed.
    expect(resolveCopilotMode()).toBe("fixture");
  });

  test("disabled provider throws CopilotUnavailable, never contacts anything", async () => {
    await expect(
      disabledProvider.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {} as never,
        allowedCitationIds: new Set<string>(),
      }),
    ).rejects.toBeInstanceOf(CopilotUnavailable);
  });

  test("selectProvider() returns disabled by default (no fetch, no import of fixture)", async () => {
    const p = await selectProvider();
    expect(p.name).toBe("disabled");
  });

  test("selectProvider() with fixture mode + no deployed signals returns fixture", async () => {
    process.env.CLINICAL_COPILOT_MODE = "fixture";
    const p = await selectProvider();
    expect(p.name).toBe("fixture");
  });

  test("live mode remains scaffolded and refuses in Phase 10A", async () => {
    process.env.CLINICAL_COPILOT_MODE = "live";
    const p = await selectProvider();
    expect(p.name).toBe("live");
    await expect(
      p.draft({
        runType: "practitioner_brief",
        lens: "western",
        inputSnapshot: {} as never,
        allowedCitationIds: new Set<string>(),
      }),
    ).rejects.toBeInstanceOf(CopilotUnavailable);
  });
});
