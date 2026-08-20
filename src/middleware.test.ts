import { afterEach, describe, expect, test } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

afterEach(() => {
  delete process.env.PRODUCTION_WORKLOAD_MODE;
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
