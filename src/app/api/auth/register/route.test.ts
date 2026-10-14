import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NextRequest } from "next/server";

const register = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const resend = vi.hoisted(() => vi.fn());
vi.mock("@/adapters/mode", () => ({ USE_LIVE_API: true }));
vi.mock("@/server/clinical-core/workforce-self-signup-release", () => ({ WORKFORCE_SELF_SIGNUP_READY: true }));
vi.mock("@/adapters/auth.server", () => ({
  registerPractitioner: register,
  confirmPractitionerEmail: confirm,
  resendPractitionerCode: resend,
}));
import { POST } from "./route";

let counter = 0;
function request(body: unknown, headers: Record<string, string> = {}) {
  counter += 1;
  return new Request("http://0.0.0.0:3000/api/auth/register", {
    method: "POST",
    headers: {
      host: "desktop.ailongevitypro.app",
      origin: "https://desktop.ailongevitypro.app",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-forwarded-for": `192.0.2.${counter}`,
      ...headers,
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  register.mockResolvedValue(undefined);
  confirm.mockResolvedValue(undefined);
  resend.mockResolvedValue(undefined);
});

describe("public practitioner registration", () => {
  test("creates only an identity request and returns no patient-access claim", async () => {
    const response = await POST(request({ action: "start", email: "New@Example.Test", password: "NotARealPassword!123", organizationId: "attacker" }));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(register).toHaveBeenCalledWith("new@example.test", "NotARealPassword!123");
    expect(await response.json()).toEqual({ data: { message: "If registration can proceed, a six-digit code will be sent to your email." } });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("confirms a six-digit email code without creating a session or membership", async () => {
    const response = await POST(request({ action: "confirm", email: "new@example.test", code: "123456" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { confirmed: true, membershipApproved: false } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(confirm).toHaveBeenCalledWith("new@example.test", "123456");
  });

  test("resend response does not disclose whether an account exists", async () => {
    const response = await POST(request({ action: "resend", email: "absent@example.test" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { message: "If this account is awaiting confirmation, a new code will be sent." } });
    expect(resend).toHaveBeenCalledWith("absent@example.test");
  });

  test.each<Record<string, string>>([
    { origin: "https://evil.example" },
    { origin: "" },
    { "sec-fetch-site": "same-site" },
    { origin: "http://desktop.ailongevitypro.app" },
  ])("refuses cross-origin registration before Cognito: %o", async (headers) => {
    expect((await POST(request({ action: "start", email: "new@example.test", password: "NotARealPassword!123" }, headers))).status).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });

  test("refuses invalid input and oversized bodies before Cognito", async () => {
    const bad = [
      { action: "start", email: "new@example.test", password: "short" },
      { action: "confirm", email: "new@example.test", code: "12345" },
      { action: "elevate", email: "new@example.test" },
      { action: "start", email: "new@example.test", password: "NotARealPassword!123", padding: "x".repeat(2100) },
    ];
    for (const input of bad) expect((await POST(request(input))).status).toBe(400);
    expect(register).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
